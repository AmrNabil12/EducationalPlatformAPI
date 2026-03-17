# Why run `server_db.js`?

This project currently has **two backend modes**:

## 1) `src/server.js` (legacy/local-file mode)
- Reads student serials from `backend/data/serials.json`
- Reads video catalog from `backend/data/catalog.json`
- Suitable for quick local testing without a real database

## 2) `src/server_db.js` (remote-database mode) 
This is the mode you asked for, because your requirements are database-driven:

- Student enters serial → backend searches serial in PostgreSQL table (`student_serials`)
- If serial exists and has no device yet → backend binds `device_id` on first login
- If serial does not exist → backend rejects login
- Student month access is read from DB (`allowed_months`)
- Video/record links are read from DB table (`math_records`, columns `m1..m12`)
- Playback route redirects to the month record link from DB

So, to enforce serial/device binding + month subscriptions from a **real remote DB**, you must run:

```bash
npm --prefix backend run dev
```

(`dev` is configured to start `src/server_db.js`.)

---

## Why `localhost:4000` during development?

`localhost:4000` is **only for local development on your machine**.

- While you are building/testing, your phone/emulator calls your local backend.
- In production, students should call a **hosted backend URL** (for example: `https://api.yourschool.com`).

So students do **not** run your local server. They use your deployed API.

---

## Why students should NOT connect directly to PostgreSQL

Even if you want "just verify serial + load sessions", direct DB connection from app is unsafe:

1. DB credentials would be inside the APK (can be extracted).
2. Students could query/modify tables directly.
3. You lose server-side validation/rate limiting/audit logs.
4. You cannot safely enforce serial-device binding logic.

Correct architecture is:

`Student App -> Backend API (server_db.js) -> PostgreSQL`

---

## About encrypted download and no clear video storage

Your requirement is correct:
- student downloads encrypted file
- app decrypts only for playback
- clear MP4 should not remain on device

Important note about current codebase:
- current Flutter flow still writes a decrypted temp `.mp4` before playback (legacy behavior).
- to fully satisfy your strict rule, playback must be refactored to **on-the-fly decryption stream** (memory/stream pipeline) and prevent persistent clear cache.

If you want, this can be implemented as next step with a dedicated native playback pipeline.

---

## Required env vars for `server_db.js`

In `backend/.env`:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
DATABASE_SSL=true
STUDENT_SERIALS_TABLE=student_serials
MATH_RECORDS_TABLE=math_records
```

If `DATABASE_URL` is empty, `server_db.js` will stop immediately with:

`Missing DATABASE_URL...`

---

## DB schema bootstrap

Use:

`backend/sql/init_db.sql`

It creates and seeds:
- `student_serials`
- `math_records`

---

## If login fails with: `relation "student_serials" does not exist`

Your DB is connected, but schema/tables were not created yet.

Run:

```bash
npm --prefix backend run db:init
```

Then restart backend:

```bash
npm --prefix backend run dev
```

This executes `backend/sql/init_db.sql` and creates both required tables.
