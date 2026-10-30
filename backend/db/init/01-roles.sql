-- Infrastructure code: login roles per process (§13.3). Runs once when the Postgres volume is created.
-- The group roles app_rw / app_ro are also created by migration 0001 (IF NOT EXISTS), so order does not matter.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN CREATE ROLE app_ro NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahayak_api') THEN
    CREATE ROLE sahayak_api LOGIN PASSWORD 'dev' IN ROLE app_rw;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahayak_worker') THEN
    CREATE ROLE sahayak_worker LOGIN PASSWORD 'dev' IN ROLE app_rw;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahayak_analytics') THEN
    CREATE ROLE sahayak_analytics LOGIN PASSWORD 'dev' IN ROLE app_ro;
  END IF;
END $$;

-- Per-role settings (§13.3): statement_timeout 5 s for the API, 60 s for workers; idle-in-transaction 10 s.
ALTER ROLE sahayak_api SET statement_timeout = '5s';
ALTER ROLE sahayak_api SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE sahayak_worker SET statement_timeout = '60s';
ALTER ROLE sahayak_worker SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE sahayak_analytics SET statement_timeout = '60s';
ALTER ROLE sahayak_analytics SET default_transaction_read_only = on;
