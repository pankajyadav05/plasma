-- Plasma E2E Postgres seed (idempotent on fresh volume).
CREATE SCHEMA IF NOT EXISTS e2e;

DROP TABLE IF EXISTS e2e.types CASCADE;
CREATE TABLE e2e.types (
  id          serial PRIMARY KEY,
  bigint_col  bigint,
  numeric_col numeric,
  text_col    text,
  note        text
);

INSERT INTO e2e.types (bigint_col, numeric_col, text_col, note) VALUES
  (9007199254740993, 1.0000000000000001, '00123', 'edge: bigint past Number.MAX_SAFE_INTEGER + leading-zero text'),
  (1, 2.5, 'plain', 'control row');

DROP TABLE IF EXISTS e2e.people CASCADE;
CREATE TABLE e2e.people (
  id   serial PRIMARY KEY,
  name text NOT NULL,
  age  int
);
INSERT INTO e2e.people (name, age)
SELECT 'person-' || g, (g % 80) + 1
FROM generate_series(1, 50) AS g;

DROP TABLE IF EXISTS e2e.nopk CASCADE;
CREATE TABLE e2e.nopk (
  label text,
  value int
);
INSERT INTO e2e.nopk (label, value) VALUES ('a', 1), ('b', 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ro') THEN
    CREATE ROLE ro LOGIN PASSWORD 'ro';
  END IF;
END$$;
GRANT USAGE ON SCHEMA e2e TO ro;
GRANT SELECT ON ALL TABLES IN SCHEMA e2e TO ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA e2e GRANT SELECT ON TABLES TO ro;
