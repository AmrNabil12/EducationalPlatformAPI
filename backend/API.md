# Backend API Contract (DB Mode)

This API contract describes the **remote-database mode** implemented by `backend/src/server_db.js`.

Base URL example: `http://localhost:4000`

---

## 1) Health

`GET /health`

Response (when DB reachable):

```json
{ "ok": true, "db": true }
```

---

## 2) Login + Serial/Device Binding (Database)

`POST /auth/login`

Request:

```json
{
  "serial": "EDU-ABCD-EFGH-IJKL",
  "deviceId": "f98f2e5e-...",
  "publicKeyPem": "-----BEGIN RSA PUBLIC KEY----- ..."
}
```

Rules:

1. serial is searched in remote DB table `student_serials` (configurable).
2. if not found => reject as invalid serial (guess attempt / unauthorized).
3. if found and `device_id` is empty => backend writes current device id (first binding).
4. if found and `device_id` differs => login denied.
5. if serial inactive (`active=false`) => denied.

Success response:

```json
{
  "token": "jwt-token",
  "student": {
    "serial": "EDU-ABCD-EFGH-IJKL",
    "deviceId": "f98f2e5e-...",
    "availableMonths": ["M1", "M2", "M4", "M6"]
  }
}
```

---

## 3) List Student-Allowed Months + Records

`GET /videos`

Headers:

`Authorization: Bearer <token>`

Behavior:

- Reads student subscription months from `student_serials.allowed_months`.
- Reads records table `math_records`.
- Returns only months available for this student.
- For each allowed month, each non-empty record link row becomes one item.

Response:

```json
{
  "generatedAt": "2026-03-15T20:00:00.000Z",
  "months": [
    {
      "month": "M1",
      "videos": [
        {
          "id": "M1_1",
          "title": "Record 1",
          "month": "M1",
          "durationSec": null
        }
      ]
    }
  ]
}
```

---

## 4) Open Record Link by Month + Row

`GET /videos/:videoId/plain`

Headers:

`Authorization: Bearer <token>`

Expected `videoId` format:

- `M1_1`, `M2_3`, ...

Behavior:

1. Validates token and serial/device binding.
2. Confirms student is subscribed to requested month.
3. Reads appropriate month column (`m1..m12`) in `math_records` for requested row.
4. Redirects (302) to the corresponding Google Drive link (normalized to download URL when possible).

Errors:

- `403` if month not subscribed.
- `404` if no link exists for that month/record row.

---

## 5) Playback License (Encrypted Video Mode)

`POST /videos/:videoId/license`

Headers:

`Authorization: Bearer <token>`

Request:

```json
{
  "publicKeyPem": "-----BEGIN PUBLIC KEY----- ..."
}
```

Behavior:

1. Validates token and serial/device binding.
2. Confirms student is subscribed to the requested month.
3. Unwraps the per-video data key using the backend master key.
4. Re-encrypts that data key for the Android device public key.
5. Returns metadata for the **single-file paged encrypted container**.

Paged-mode response example:

```json
{
  "videoId": "87a5e79f-3a21-4838-9395-1bce282137bb",
  "storageMode": "paged",
  "algorithm": "AES-256-GCM",
  "videoNonceB64": "",
  "encryptedDataKeyB64": "...",
  "plainDataKeyB64": "",
  "contentUrl": "/storage/encrypted/M1/S1/(Record)%20M1%20S1%20Math.mp4.enc",
  "requiresAuthForContent": true,
  "totalPlainSize": 247786058,
  "pageSize": 1048576,
  "pageCount": 237,
  "chunks": []
}
```

Notes:

- `storageMode = "paged"` is the new production playback format.
- The client should treat the encrypted file as a random-access paged container and decrypt only requested ranges.
- `plainDataKeyB64` is intentionally empty in production mode.

---

## 6) Required DB Tables

### `student_serials`

- `serial_no` (text, unique)
- `device_id` (text, nullable)
- `active` (boolean)
- `allowed_months` (text or text[]; examples: `M1,M2,M4`)
- `public_key_pem` (text, nullable)

### `math_records`

- optional `record_no` integer (recommended)
- columns `m1`..`m12` (text), where each cell is a Google Drive link for that month’s record row.



