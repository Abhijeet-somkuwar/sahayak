-- file: db/migrations/20261006000010_analytics.sql
-- migrate:up
CREATE TABLE facility_daily_stats (
  facility_id             uuid NOT NULL REFERENCES facilities(id),
  department_id           uuid NOT NULL REFERENCES departments(id),
  stat_date               date NOT NULL,
  registrations           int NOT NULL DEFAULT 0,
  checked_in              int NOT NULL DEFAULT 0,
  seen                    int NOT NULL DEFAULT 0,
  no_shows                int NOT NULL DEFAULT 0,
  left_without_being_seen int NOT NULL DEFAULT 0,
  triage_emergency        int NOT NULL DEFAULT 0,
  triage_priority         int NOT NULL DEFAULT 0,
  triage_routine          int NOT NULL DEFAULT 0,
  triage_self_care        int NOT NULL DEFAULT 0,
  triage_overrides        int NOT NULL DEFAULT 0,
  ai_fallback_count       int NOT NULL DEFAULT 0,
  wait_p50_seconds        int,
  wait_p90_seconds        int,
  consult_p50_seconds     int,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  is_final                boolean NOT NULL DEFAULT false,
  PRIMARY KEY (facility_id, department_id, stat_date)
);

CREATE TABLE facility_hourly_arrivals (
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  stat_date     date NOT NULL,
  hour          smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),   -- IST hour
  arrivals      int NOT NULL,
  PRIMARY KEY (facility_id, department_id, stat_date, hour)
);

-- migrate:down
DROP TABLE IF EXISTS facility_hourly_arrivals, facility_daily_stats;
