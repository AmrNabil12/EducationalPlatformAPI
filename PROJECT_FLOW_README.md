# Educational Platform - End-to-End Project Flow

This document explains the **full system flow** of the Educational Platform project in practical terms:

- what each part of the system does,
- how the student interacts with it,
- how the backend makes decisions,
- how the database tables are used,
- how encrypted content is delivered,
- and what happens in the most important success/failure scenarios.

It is intended to be the **single high-level reference** for understanding the complete project.

---

## 1) System Purpose

This project is an educational video platform where:

- a student signs in using a **serial number**,
- the serial becomes bound to one specific device,
- the backend decides which months/videos the student is allowed to access,
- encrypted video files are hosted remotely,
- the mobile app downloads the encrypted file,
- the app obtains a playback license from the backend,
- the video is decrypted **on-demand** during playback,
- and the content key is cached locally in a protected way so repeated playback is faster and more secure.

The design tries to balance:

- access control,
- practical content protection,
- offline/local playback,
- and acceptable playback performance.

---

## 2) Main Parts of the System

The project is made of these major parts:

### A. Admin / Content Preparation Layer

Files involved:

- `admin_tools/encrypt.py`
- `videos/`
- `encrypted/`
- `backend/data/catalog.json`

This layer is responsible for:

- reading the original clear video files,
- encrypting them,
- producing the metadata catalog,
- and preparing files that will later be uploaded to remote hosting (for example Google Drive).

### B. Backend API Layer

Main file:

- `backend/src/server_db.js`

This layer is responsible for:

- authenticating students,
- binding serials to devices,
- checking month access rights,
- issuing playback licenses,
- mapping encrypted file paths to hosted files,
- and redirecting the app to the hosted encrypted asset.

### C. Database Layer

Important schema file:

- `backend/sql/init_db.sql`

This layer stores:

- student serial numbers,
- whether a serial is active,
- which months a student can access,
- device binding state,
- and optional legacy record links.

### D. Flutter Mobile App Layer

Important files:

- `flutter_app/lib/main.dart`
- `flutter_app/lib/screens/login_screen.dart`
- `flutter_app/lib/screens/months_screen.dart`
- `flutter_app/lib/screens/video_player_screen.dart`
- `flutter_app/lib/services/api_service.dart`
- `flutter_app/lib/services/auth_service.dart`
- `flutter_app/lib/services/device_service.dart`
- `flutter_app/lib/services/key_service.dart`
- `flutter_app/lib/services/crypto_service.dart`
- `flutter_app/lib/services/playback_service.dart`

This layer is responsible for:

- storing the student session,
- generating or retrieving the device identity,
- requesting the student’s available content,
- downloading encrypted files,
- requesting the playback license,
- caching content keys securely on Android,
- and streaming decrypted bytes to the player on demand.

### E. Android Native Crypto Layer

Important file:

- `flutter_app/android/app/src/main/kotlin/com/example/flutter_app/MainActivity.kt`

This layer is responsible for:

- Android Keystore-backed RSA keypair generation,
- protected local key storage,
- wrapped content-key unwrap,
- paged AES-GCM range decryption,
- and secure local reuse of content keys.

### F. Remote File Hosting Layer

Important files:

- `backend/data/google_drive_index.json`
- `backend/GOOGLE_DRIVE_STORAGE.md`

This layer is responsible for hosting encrypted `.enc` files remotely.

Currently the project supports Google Drive-based hosting of encrypted files.

---

## 3) High-Level Architecture

The practical runtime architecture looks like this:

```text
Admin videos/ -> encrypt.py -> encrypted/*.enc + catalog.json
                                 |
                                 -> upload encrypted .enc files to Google Drive

Student App -> Backend API -> PostgreSQL
             -> Backend API -> catalog.json
             -> Backend API -> Google Drive mapping/folder lookup

Student App -> download encrypted .enc file
Student App -> request license / wrapped content key
Student App -> Android Keystore unwrap + cache content key
Student App -> local proxy decrypts only requested ranges during playback
```

---

## 4) Important Stored Data and Files

### 4.1 Clear source videos

Folder:

- `videos/`

These are the original, unencrypted teacher/admin files.

### 4.2 Encrypted content files

Folder:

- `encrypted/`

These are the generated encrypted playback assets.

In the current architecture, **one record becomes one encrypted paged file**, for example:

```text
encrypted/M1/S1/(Record) M1 S1 Math.mp4.enc
```

### 4.3 Video catalog metadata

File:

- `backend/data/catalog.json`

This tells the backend:

- which video exists,
- which month it belongs to,
- where its encrypted file lives,
- which wrapped data key belongs to it,
- what page size is used,
- and how many pages exist.

### 4.4 Google Drive mapping file

File:

- `backend/data/google_drive_index.json`

This maps an internal encrypted file path to a Google Drive file ID or URL.

Example:

```json
{
  "encrypted/M1/S1/(Record) M1 S1 Math.mp4.enc": "<google-drive-file-id-or-url>"
}
```

### 4.5 Local app session and local playback storage

The app stores data locally such as:

- auth token,
- student serial,
- student display name,
- device ID,
- downloaded encrypted files,
- local playback metadata,
- and cached protected content keys.

Some of that is stored through Flutter secure/local storage and some through Android Keystore-backed native storage.

---

## 5) Database Tables That Matter Most

The most important database tables in the current backend DB mode are:

### 5.1 `student_serials`

This is the **core access-control table**.

Important columns:

- `serial_no`
  - the student’s serial number
  - must be unique

- `device_id`
  - empty at first
  - filled when the student logs in successfully for the first time
  - used to permanently bind that serial to one device

- `active`
  - whether the serial is currently allowed to log in
  - if `false`, login is denied

- `allowed_months`
  - the months the student is allowed to access
  - examples: `M1`, `M1,M2,M4`, JSON-like or other supported forms

- `public_key_pem`
  - the device public key stored by the backend
  - used to encrypt the content key for that specific device

- `bound_at`, `created_at`, `updated_at`
  - operational/history fields

This table directly controls:

- whether login succeeds,
- whether device binding succeeds,
- whether a different device is rejected,
- and which month groups appear in the app.

### 5.2 `math_records`

This is mainly a **legacy / optional plain-link table**.

Important columns:

- `record_no`
- `m1` .. `m12`

Each `mX` cell can contain a link for legacy plain-record redirection.

This table is still useful when:

- you want to support `/videos/:videoId/plain`,
- or you still want a fallback/legacy plain-link record access mode.

But for the new secure encrypted playback path, the main source of truth is:

- `student_serials` for permission decisions,
- `catalog.json` for encrypted video metadata,
- Google Drive mapping/folder lookup for hosted encrypted files.

---

## 6) Backend Endpoints and Their Roles

### 6.1 `GET /health`

Purpose:

- confirms the backend is alive,
- confirms DB connectivity.

Used for:

- deployment checks,
- quick operational testing,
- confirming Render/Railway hosting is working.

### 6.2 `POST /auth/login`

Purpose:

- authenticates the student by serial,
- binds the student to a device if first login,
- stores the public key if provided,
- returns JWT session token.

Input includes:

- `serial`
- `deviceId`
- `publicKeyPem`

### 6.3 `GET /videos`

Purpose:

- returns all accessible months and their video items for the logged-in student.

This is where the backend filters the catalog using `allowed_months`.

### 6.4 `POST /videos/:videoId/license`

Purpose:

- verifies the student is allowed to access the requested video,
- unwraps the video’s content key with the server master key,
- re-wraps that content key for the student device public key,
- returns playback metadata for the encrypted paged container.

This is one of the most important endpoints in the secure playback model.

### 6.5 `GET /storage/<relativePath>`

Purpose:

- validates the student token and month subscription,
- resolves the hosted encrypted file,
- redirects the app to the actual encrypted file location on Google Drive.

### 6.6 `GET /videos/:videoId/plain`

Purpose:

- legacy/fallback plain record access based on `math_records`.

This is not the secure encrypted playback route.

---

## 7) Student Interaction Flow - All Major Scenarios

Below are the most important student scenarios and what happens in each case.

---

### Scenario 1: Student opens the app for the very first time

1. App starts.
2. `main.dart` boots the app.
3. `AuthService.getToken()` checks whether a stored token exists.
4. No token is found.
5. App navigates to the login screen.

Student experience:

- sees login screen,
- enters name and serial.

---

### Scenario 2: Student logs in with a valid serial on the first device

1. App gets or creates a local `deviceId` using `DeviceService`.
2. App gets or creates the device public key using `KeyService`.
3. App calls `POST /auth/login`.
4. Backend searches `student_serials` by `serial_no`.
5. Serial exists and `device_id` is empty.
6. Backend stores this device ID into `student_serials.device_id`.
7. Backend optionally stores/updates `public_key_pem`.
8. Backend issues JWT token.
9. App stores token and session info using `AuthService`.
10. App navigates to the months screen.

Result:

- first login succeeds,
- serial becomes permanently bound to this device.

---

### Scenario 3: Student enters an invalid serial

1. App sends login request.
2. Backend finds no matching serial.
3. Backend returns login failure.
4. App shows error.

Result:

- student cannot enter the system.

---

### Scenario 4: Student serial exists but is inactive

1. App sends login request.
2. Backend finds serial.
3. `active = false`.
4. Backend rejects login.

Result:

- student is blocked even if the serial exists.

---

### Scenario 5: Student tries to use the same serial on a different device

1. Backend finds matching serial.
2. `device_id` is already stored.
3. Incoming `deviceId` does not match stored `device_id`.
4. Backend rejects login.

Result:

- serial cannot be reused on another device.

---

### Scenario 6: Returning student opens the app later

1. App starts.
2. Stored token is found.
3. App skips login screen.
4. App opens the months screen directly.

Result:

- student remains signed in until token/session is cleared or becomes invalid.

---

### Scenario 7: Student loads the months screen

1. App calls `GET /videos` with the stored token.
2. Backend validates JWT.
3. Backend loads the student row.
4. Backend reads `allowed_months`.
5. Backend reads `catalog.json`.
6. Backend returns only the months/videos the student is allowed to see.

Result:

- the student does not see unauthorized month groups.

---

### Scenario 8: Student tries to access a month that is not subscribed

1. Even if the UI somehow tries to request that content,
2. backend compares requested video month against `allowed_months`.
3. backend rejects the operation.

Result:

- month-level authorization is enforced server-side, not only in UI.

---

### Scenario 9: Student downloads an encrypted session for the first time

1. Student taps download.
2. App requests `POST /videos/:videoId/license`.
3. Backend verifies student + subscription.
4. Backend unwraps content key using `MASTER_KEY_B64`.
5. Backend re-encrypts content key for student device public key.
6. Backend returns:
   - wrapped content key,
   - `storageMode = paged`,
   - `contentUrl`,
   - page metadata.
7. App downloads the encrypted `.enc` file from `/storage/...` -> Google Drive.
8. App stores local license metadata.
9. App unwraps the content key locally and caches it securely.

Result:

- encrypted asset is available locally,
- protected content key is cached for future use.

---

### Scenario 10: Student plays the downloaded record for the first time

1. Student taps play.
2. App loads local encrypted file + license metadata.
3. App loads cached content key or unwraps it if needed.
4. App starts local playback proxy.
5. Video player requests byte ranges from local proxy.
6. Proxy asks crypto layer to decrypt only the requested paged range.
7. Clear bytes are streamed directly to player.

Result:

- no giant plaintext file is created before playback,
- only requested ranges are decrypted.

---

### Scenario 11: Student plays the same record again later

1. Encrypted file already exists locally.
2. Protected content key is already cached locally.
3. App does not need to re-request the backend license in the normal case.
4. Playback starts using the local protected key.

Result:

- repeated playback is faster,
- startup overhead is reduced,
- backend dependency is reduced for repeat plays.

---

### Scenario 12: App key state is broken or device key was reset

This can happen due to:

- app reinstall,
- cleared app data,
- Android Keystore reset,
- mismatched local state.

Recovery flow:

1. App tries to open playback.
2. Wrapped key unwrap fails.
3. App may reset keypair locally.
4. App requests a fresh license again.
5. Backend stores the fresh public key if needed.
6. Playback metadata is refreshed.

Result:

- student can recover without manual database editing in many cases,
- assuming backend still accepts the device identity/session path.

---

### Scenario 13: Hosted encrypted file is missing from Google Drive

1. Student has valid token.
2. Backend resolves the file path.
3. Google Drive mapping or folder lookup fails.
4. Backend returns error / cannot redirect.

Result:

- playback/download fails,
- admin must update `google_drive_index.json` or fix the hosted file structure.

---

### Scenario 14: Student has network failure during initial download

1. License may succeed.
2. Encrypted file download fails or is incomplete.
3. App reports failure.

Result:

- session is not fully downloaded,
- student should retry download.

---

### Scenario 15: Student is already logged in but token becomes invalid/expired

1. App sends request with old token.
2. Backend rejects authorization.
3. App should treat session as expired.
4. Student needs to sign in again.

Result:

- access is not granted with stale token.

---

### Scenario 16: Student uses legacy plain-record mode

If legacy plain records are still in use:

1. App or backend requests `/videos/:videoId/plain`.
2. Backend checks month access.
3. Backend reads `math_records.m1..m12`.
4. Backend redirects to the plain external link.

Result:

- this path bypasses the encrypted paged playback architecture,
- and should be considered legacy / fallback behavior.

---

## 8) Current Secure Playback Design - Step by Step

The secure encrypted playback path now works like this:

### Step 1: Encrypt content once

Admin runs:

```bash
python admin_tools/encrypt.py --videos-dir videos --catalog backend/data/catalog.json --page-size-mb 1
```

This generates:

- one encrypted paged container `.enc` file per record,
- updated `catalog.json` metadata.

### Step 2: Upload encrypted files

Admin uploads generated `.enc` files to Google Drive.

### Step 3: Connect hosted files to backend

Admin updates:

- `backend/data/google_drive_index.json`

or uses dynamic folder mode.

### Step 4: Student logs in

Backend binds serial to device and receives public key.

### Step 5: Student requests playback license

Backend returns only what is necessary for playback:

- wrapped content key for that device,
- location of encrypted file,
- paged container metadata.

### Step 6: App downloads encrypted file

The file remains encrypted on disk.

### Step 7: App unwraps and protects the content key locally

On Android:

- RSA unwrap happens in native code,
- content key is cached under Android Keystore protection.

### Step 8: Player requests byte ranges

The player talks to a local proxy URI.

### Step 9: Proxy decrypts only requested ranges

The proxy asks the native/dart crypto layer for only the required pages.

### Step 10: Player receives clear bytes only for the requested playback range

This gives on-demand decrypt behavior without splitting the record into many hosted chunk files.

---

## 9) Why This Architecture Is Useful

Compared with the older models, this architecture gives you:

### Better than full plaintext temp-file playback

Because:

- the full video is not decrypted into one giant clear file before playing.

### Better than multi-file chunk hosting

Because:

- you do not need to manage hundreds of hosted chunk files per record.
- one logical record maps to one encrypted hosted file.

### Better repeated playback behavior

Because:

- the content key is cached locally in protected form after first authorization.

### Better Android production performance path

Because:

- Android native crypto is used for the production decrypt path.

---

## 10) Important Operational Notes

### When you re-encrypt videos

You must also:

- update `backend/data/catalog.json`,
- regenerate `backend/data/google_drive_index.json`,
- upload the new `.enc` files,
- and redeploy the backend if needed.

### When you change the playback encryption format

Previously downloaded student sessions may become invalid.

### When Google Drive links change

You must update:

- `backend/data/google_drive_index.json`

or ensure dynamic folder mode still resolves correctly.

### When Android app is reinstalled

Device-local key state may be lost and playback recovery may require a fresh license path.

---

## 11) Most Important Project Files by Responsibility

### Backend

- `backend/src/server_db.js`
  - main production backend logic

- `backend/data/catalog.json`
  - encrypted content metadata

- `backend/data/google_drive_index.json`
  - hosted encrypted file mapping

- `backend/sql/init_db.sql`
  - DB schema bootstrap

- `backend/API.md`
  - API contract reference

### Admin / Content

- `admin_tools/encrypt.py`
  - creates encrypted paged container files and catalog metadata

### Flutter App

- `flutter_app/lib/main.dart`
  - app bootstrap and auth routing

- `flutter_app/lib/screens/login_screen.dart`
  - student login UX

- `flutter_app/lib/screens/months_screen.dart`
  - months/videos list and download/open actions

- `flutter_app/lib/screens/video_player_screen.dart`
  - actual player screen

- `flutter_app/lib/services/api_service.dart`
  - HTTP communication with backend

- `flutter_app/lib/services/auth_service.dart`
  - local auth token/session storage

- `flutter_app/lib/services/device_service.dart`
  - device ID creation/persistence

- `flutter_app/lib/services/key_service.dart`
  - device keypair and wrapped content-key handling

- `flutter_app/lib/services/crypto_service.dart`
  - decrypt operations and native crypto bridge

- `flutter_app/lib/services/playback_service.dart`
  - download + license + local playback proxy orchestration

### Android Native

- `flutter_app/android/app/src/main/kotlin/com/example/flutter_app/MainActivity.kt`
  - Android Keystore integration
  - native RSA unwrap
  - native paged AES-GCM decrypt

---

## 12) Summary

At a business level, the project now works like this:

1. admin encrypts a record into one hosted encrypted paged file,
2. backend authenticates student and enforces serial/device/month rules,
3. app downloads encrypted content and receives a device-bound wrapped content key,
4. Android securely unwraps and caches the content key,
5. playback decrypts only requested ranges on demand,
6. repeated playback is faster because the protected local key is reused.

If you want, the next documentation step I can do is create an additional file such as:

- `STUDENT_SUPPORT_SCENARIOS.md`
- `DEPLOYMENT_CHECKLIST.md`
- or `DATABASE_OPERATIONS_GUIDE.md`

for even more operational detail.