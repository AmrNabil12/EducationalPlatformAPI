-- Educational Platform DB bootstrap (PostgreSQL)
-- Creates required tables for DB mode backend (src/server_db.js)
--
-- IMPORTANT:
-- The current secure playback architecture uses:
--   1) backend/data/catalog.json
--   2) encrypted/ encrypted files (single-file or chunked)
--   3) /videos/:videoId/license + /storage/:fileName
--
-- This means `math_records` is now OPTIONAL and only needed if you still want
-- the legacy plain-link redirect mode (`/videos/:videoId/plain`) for database
-- record links.
--
-- If you are using the encrypted/chunked local-decryption flow, you can leave
-- all `math_records.m1..m12` values as NULL.

BEGIN;

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

CREATE INDEX IF NOT EXISTS idx_student_serials_serial_upper
  ON student_serials ((UPPER(serial_no)));

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
