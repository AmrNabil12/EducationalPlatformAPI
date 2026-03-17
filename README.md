# Educational Platform (Flutter + Secure Video Delivery MVP)

This repository contains a full starter implementation for your requested educational platform:

- **Admin-side encryptor** that encrypts local videos and prepares a catalog.
- **Backend** that:
  - validates serial numbers,
  - binds each serial permanently to one device,
  - issues playback licenses only to authorized devices.
- **Flutter app** that:
  - signs in with serial,
  - remembers signed-in device,
  - shows videos grouped by months **M1..M12**,
  - decrypts encrypted videos and plays them with controls (±10s, speed).

---

## 1) Project Structure

```text
videos/                         # put original clear videos here
encrypted/                      # generated encrypted videos
admin_tools/
  encrypt.py                    # encrypt videos into ./encrypted + generate catalog
  requirements.txt
backend/
  API.md
  package.json
  .env.example
  data/
    catalog.json                # produced/updated by admin tool
  scripts/
    seedSerials.js              # generate serial codes
  src/
    server.js
flutter_app/
  pubspec.yaml
  lib/
    main.dart
    models.dart
    screens/
    services/
```

---

## 2) Security Model (Practical MVP)

1. Each video is encrypted using a random **AES-256-GCM data key**.
2. Data key is wrapped using a server-side **master key**.
3. App signs in using `serial + deviceId`.
4. First login binds serial permanently to that device.
5. App generates/stores a local RSA keypair (private key never leaves device).
6. On playback request, backend verifies auth/device and sends video data key encrypted with the app public key.
7. App decrypts key locally, decrypts video, and plays it.

> Important: This dramatically improves security compared to raw cloud-hosted MP4 links, but **no client-side system is 100% unbreakable**. For maximal protection, combine with short-lived signed URLs, watermarking, anti-screen-capture measures, and possibly commercial DRM for premium content.

---

## 3) Admin Flow

### Install Python dependencies

```bash
python -m pip install -r admin_tools/requirements.txt
```

### Generate master key (once)

```bash
python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Put this value in `backend/.env` as `MASTER_KEY_B64`.

### Encrypt videos + produce catalog

```bash
python admin_tools/encrypt.py --videos-dir videos --catalog backend/data/catalog.json
```

This always writes encrypted output files to the project `encrypted/` folder.

---

## 4) Backend Setup

PowerShell:

```powershell
Set-Location backend
npm install
Copy-Item .env.example .env
```

Edit `.env` values, then seed serials:

```powershell
node scripts/seedSerials.js --count=50
```

Run API:

```powershell
npm run dev
```

Server defaults to `http://localhost:4000`.

API details and JSON contract examples are available in `backend/API.md`.

### Remote DB mode (serial binding + month permissions + Google Drive record links)

Backend now supports a database-driven mode using `backend/src/server_db.js` (configured as default `npm run dev`).

Set these in `backend/.env`:

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
DATABASE_SSL=false
STUDENT_SERIALS_TABLE=student_serials
MATH_RECORDS_TABLE=math_records
```

Required tables:

1. `student_serials`
   - `serial_no` text unique
   - `device_id` text nullable (empty until first successful login)
   - `active` boolean
   - `allowed_months` text or text[] (example: `M1,M2,M4,M6`)
   - `public_key_pem` text nullable

2. `math_records`
   - recommended `record_no` int primary key
   - columns `m1`..`m12` (text), each cell holds a Google Drive link for that month record row.

Behavior:
- At first login, serial is searched in DB; if found and device_id is empty, it is set to the student device id.
- If serial is not found => login rejected.
- Student only sees subscribed months from `allowed_months`.
- Record playback route redirects to matching Google Drive link from `math_records`.

---

## 5) Flutter App Setup

```powershell
Set-Location flutter_app
flutter pub get
flutter run
```

For Android emulator, default API URL is already `http://10.0.2.2:4000`.

To override API URL explicitly:

```powershell
flutter run --dart-define=API_BASE_URL=http://YOUR_HOST:4000
```

---

## 6) Current Business Rules Implemented

- Serial starts unbound.
- First successful sign-in permanently binds serial to a device.
- Future sign-in attempts from another device are denied.
- Signed-in device remains remembered (no repeated sign-in unless token invalidated).
- Months `M1..M12` are all visible for all authenticated students.

---

## 7) Next Suggested Enhancements

- Admin dashboard for assigning videos per month without editing files.
- Subscription-month filtering per student.
- Token rotation + refresh tokens.
- Signed/encrypted streaming chunks instead of full-file download.
- Video watermark overlays with student ID.

---

## 8) Important Security Notes

- This is a **stronger protection layer** than uploading raw MP4 files, but client-side playback is never perfectly tamper-proof.
- Decrypted video is currently written to temporary storage for playback convenience. For stricter security, move to chunked in-memory decryption/streaming and immediate chunk disposal.
