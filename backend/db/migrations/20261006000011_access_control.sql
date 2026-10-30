-- file: db/migrations/20261006000011_access_control.sql
-- migrate:up
GRANT USAGE ON SCHEMA public TO app_rw, app_ro;

-- Grant on top-level tables only. Partitions get NO direct grants, so the application can only reach
-- partitioned data through the parent table, where the RLS policies below apply.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rw', t.relname);
    EXECUTE format('GRANT SELECT ON %I TO app_ro', t.relname);
  END LOOP;
END $$;

-- Append-only and maintenance-only tables.
REVOKE UPDATE, DELETE ON audit_events, consents, queue_events, llm_calls FROM app_rw;
REVOKE INSERT, UPDATE, DELETE ON partition_registry FROM app_rw;
REVOKE ALL ON partition_registry FROM app_ro;
REVOKE EXECUTE ON FUNCTION create_month_partition(regclass, date), ensure_partitions(int, int) FROM PUBLIC;

-- 🔒 Facility isolation (fail closed). The (SELECT ...) wrappers make Postgres evaluate the scope once per query.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'encounters', 'triage_assessments', 'prebriefs', 'encounter_diagnoses', 'prescription_items', 'observations',
    'followups', 'queue_sessions', 'opd_tokens', 'queue_events', 'emergency_prealerts',
    'facility_daily_stats', 'facility_hourly_arrivals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY facility_isolation ON %I TO app_rw, app_ro
         USING ((SELECT app_is_state_scope()) OR facility_id = ANY ((SELECT app_facility_ids())::uuid[]))', t);
  END LOOP;
END $$;

-- migrate:down
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'encounters', 'triage_assessments', 'prebriefs', 'encounter_diagnoses', 'prescription_items', 'observations',
    'followups', 'queue_sessions', 'opd_tokens', 'queue_events', 'emergency_prealerts',
    'facility_daily_stats', 'facility_hourly_arrivals']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS facility_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
