BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1) Student serials / subscriptions table
CREATE TABLE IF NOT EXISTS student_serials (
  id BIGSERIAL PRIMARY KEY,
  serial_no TEXT NOT NULL UNIQUE,
  device_id TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- CSV format expected by backend: e.g. "M1,M2,M4,M6"
  -- (backend also supports JSON array text and PostgreSQL array text formats)
  allowed_months TEXT NOT NULL DEFAULT '',
  public_key_pem TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bound_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Create the UNIQUE index AFTER the table exists
-- This ensures one device cannot hijack multiple serials
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_device_binding 
ON student_serials (device_id) 
WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_student_serials_serial_upper
  ON student_serials ((UPPER(serial_no)));

-- 2) Session registry used by quizzes.
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month_code TEXT NOT NULL,
  session_code TEXT NOT NULL,
  title TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (month_code, session_code)
);

CREATE INDEX IF NOT EXISTS idx_sessions_month_session
  ON sessions (month_code, session_code);

-- 3) Quiz questions.
CREATE TABLE IF NOT EXISTS quiz_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  correct_option_index INT NOT NULL CHECK (correct_option_index >= 0),
  options_count INT NOT NULL CHECK (options_count BETWEEN 2 AND 6),
  points INT NOT NULL DEFAULT 1 CHECK (points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_questions_session_id
  ON quiz_questions (session_id, created_at, id);

-- 4) Quiz results.
CREATE TABLE IF NOT EXISTS quiz_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id BIGINT NOT NULL REFERENCES student_serials(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  score INT NOT NULL CHECK (score >= 0),
  total_questions INT NOT NULL CHECK (total_questions >= 0),
  student_answers JSONB NOT NULL,
  time_taken_seconds INT NOT NULL CHECK (time_taken_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT quiz_results_student_answers_array CHECK (jsonb_typeof(student_answers) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_results_student_session_unique
  ON quiz_results (student_id, session_id);

CREATE INDEX IF NOT EXISTS idx_quiz_results_session_id
  ON quiz_results (session_id, created_at);

-- ---------------------------
-- Sample seed data (edit/delete as you like)
-- ---------------------------

INSERT INTO student_serials (serial_no, device_id, active, allowed_months)
VALUES
  ('EDU-ABCD-EFGH-IJKL', NULL, TRUE, 'M1,M2,M4,M6'),
  ('EDU-TEST-0000-0001', NULL, TRUE, 'M1'),
  ('EDU-TEST-0000-0002', NULL, TRUE, 'M2,M3'),
  ('EDU-MJDD-VKRW-4H94', NULL, TRUE, 'M1'),
  ('EDU-Z9FJ-KDR8-BZSG', NULL, TRUE, 'M1'),
  ('EDU-HKR9-STDN-QDWD', NULL, TRUE, 'M1'),
  ('EDU-LZW6-DVCD-GPAW', NULL, TRUE, 'M1'),
  ('EDU-FTC4-GRNJ-3MDR', NULL, TRUE, 'M1'),
  ('EDU-5CWN-M2A2-GM4R', NULL, TRUE, 'M1'),
  ('EDU-PUD2-Q9S5-5NQU', NULL, TRUE, 'M1'),
  ('EDU-U8L7-QMFK-ANXG', NULL, TRUE, 'M1'),
  ('EDU-T8XS-T88R-PT8U', NULL, TRUE, 'M1'),
  ('EDU-3HB2-FETF-HNZV', NULL, TRUE, 'M1'),
  ('EDU-Q5V3-QCYC-U9JB', NULL, TRUE, 'M1'),
  ('EDU-D7NP-C8XE-H73R', NULL, TRUE, 'M1'),
  ('EDU-N5F7-M44W-5PR2', NULL, TRUE, 'M1'),
  ('EDU-EPXS-46U2-ERVP', NULL, TRUE, 'M1'),
  ('EDU-V7XP-R5N5-7UN4', NULL, TRUE, 'M1'),
  ('EDU-7RBV-7P7L-YGFX', NULL, TRUE, 'M1'),
  ('EDU-AZ33-9V2K-NAPH', NULL, TRUE, 'M1'),
  ('EDU-9GRB-FJUL-ZUGW', NULL, TRUE, 'M1'),
  ('EDU-CJ2G-WYAZ-9JN5', NULL, TRUE, 'M1'),
  ('EDU-BLRG-Z5LJ-TJ5G', NULL, TRUE, 'M1')
ON CONFLICT (serial_no) DO NOTHING;

COMMIT;