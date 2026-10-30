-- file: db/migrations/20261006000001_foundation.sql
-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Group roles. Login users (e.g. sahayak_api IN ROLE app_rw) are created by infrastructure code.
-- The migration user owns all objects; app_rw / app_ro never own tables (so RLS applies to them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN CREATE ROLE app_ro NOLOGIN; END IF;
END $$;

-- Smallest UUIDv7 that can be generated at or after ts: 48-bit ms timestamp followed by zero bits.
CREATE FUNCTION uuid7_boundary(ts timestamptz) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (lpad(to_hex(floor(extract(epoch FROM ts) * 1000)::bigint), 12, '0')
          || '00000000000000000000')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Request scope for row-level security. The API sets these per transaction:
--   SELECT set_config('app.facility_ids', '<uuid>,<uuid>', true), set_config('app.scope', 'facility', true);
-- Unset or empty settings mean "no facilities" (fail closed).
CREATE FUNCTION app_facility_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN coalesce(current_setting('app.facility_ids', true), '') = '' THEN '{}'::uuid[]
              ELSE string_to_array(current_setting('app.facility_ids', true), ',')::uuid[] END
$$;

CREATE FUNCTION app_is_state_scope() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('app.scope', true), '') = 'state'
$$;

-- Registry of monthly-partitioned tables and their retention.
CREATE TABLE partition_registry (
  parent_table        regclass PRIMARY KEY,
  retention_months    int CHECK (retention_months IS NULL OR retention_months >= 1), -- NULL = never auto-expire
  archive_before_drop boolean NOT NULL DEFAULT true,
  detach_order        smallint NOT NULL DEFAULT 50  -- lower = detached earlier (children before parents)
);

CREATE FUNCTION create_month_partition(p_parent regclass, p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_rel   text;
  v_nsp   text;
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text;
BEGIN
  SELECT c.relname, n.nspname INTO v_rel, v_nsp
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = p_parent;

  v_name := v_rel || '_p' || to_char(v_start, 'YYYYMM');
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
    v_nsp, v_name, v_nsp, v_rel,
    uuid7_boundary(v_start::timestamp AT TIME ZONE 'UTC'),
    uuid7_boundary(v_end::timestamp AT TIME ZONE 'UTC'));
  RETURN v_name;
END $$;

-- Idempotent. Run daily by the scheduler and at the end of every migration that adds a partitioned table.
CREATE FUNCTION ensure_partitions(p_months_back int DEFAULT 1, p_months_ahead int DEFAULT 3)
RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  m int;
BEGIN
  FOR r IN SELECT parent_table FROM partition_registry ORDER BY detach_order DESC LOOP
    FOR m IN -p_months_back .. p_months_ahead LOOP
      RETURN NEXT create_month_partition(
        r.parent_table,
        (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m))::date);
    END LOOP;
  END LOOP;
END $$;

-- Partitions older than their table's retention. The retention job exports each one to object
-- storage, then runs ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY and DROP TABLE outside a transaction.
CREATE FUNCTION list_expired_partitions()
RETURNS TABLE (parent_table regclass, partition_name text, partition_month date, detach_order smallint)
LANGUAGE sql STABLE AS $$
  SELECT r.parent_table, c.relname::text, to_date(right(c.relname, 6), 'YYYYMM'), r.detach_order
  FROM partition_registry r
  JOIN pg_inherits i ON i.inhparent = r.parent_table
  JOIN pg_class c    ON c.oid = i.inhrelid
  WHERE r.retention_months IS NOT NULL
    AND c.relname ~ '_p[0-9]{6}$'
    AND to_date(right(c.relname, 6), 'YYYYMM')
        < (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => r.retention_months))::date
  ORDER BY r.detach_order, 3
$$;

-- migrate:down
DROP FUNCTION IF EXISTS list_expired_partitions();
DROP FUNCTION IF EXISTS ensure_partitions(int, int);
DROP FUNCTION IF EXISTS create_month_partition(regclass, date);
DROP TABLE IF EXISTS partition_registry;
DROP FUNCTION IF EXISTS app_is_state_scope();
DROP FUNCTION IF EXISTS app_facility_ids();
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS uuid7_boundary(timestamptz);
