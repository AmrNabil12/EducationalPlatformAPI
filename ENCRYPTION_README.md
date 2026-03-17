## Video Encryption & Decryption Guide

This document explains the exact encryption technique used in this project, what is required for it to work, and how encryption/decryption flows are performed.

---

## 1) Cryptography Used

### Primary content encryption
- **Algorithm:** AES-256-GCM
- **Mode:** AEAD (Authenticated Encryption with Associated Data)
- **Key size:** 32 bytes (256-bit)
- **Nonce/IV size:** 12 bytes (96-bit)
- **Auth tag:** 16 bytes (128-bit)
- **Container format:** single encrypted file using a **paged random-access container**

### Paged encrypted container
- Each video is stored as **one `.enc` file**.
- The encrypted file contains:
  - a small header
  - fixed-size encrypted pages
  - one nonce + auth tag per page
- This allows the player to request only the needed byte range and decrypt only the required page(s), instead of creating one giant plaintext file.

### Key wrapping (data-key protection)
- Each video is encrypted with a random per-video **data key** (AES-256 key).
- That data key is wrapped/encrypted using a server-side **master key** (also 32 bytes) using **AES-256-GCM**.

### Device delivery key exchange
- Backend unwraps the video data key (using master key), then encrypts it for the app using device public key:
  - **RSA PKCS#1 v1.5 padding** (`RSA_PKCS1_PADDING`)
- On Android, the app decrypts this using a **native Android Keystore-backed RSA private key**.

### Local content-key protection
- After first authorization, the content key is cached locally on Android.
- The cached content key is protected using:
  - **Android Keystore** master key
  - `AES/GCM/NoPadding`
- Subsequent playback can reuse the protected local key instead of depending on repeated license unwrap work.

---

## 2) Requirements of This Encryption Scheme

1. **Master key must exist and be valid**
   - `MASTER_KEY_B64` is required in `backend/.env` (or exported environment).
   - Must decode to exactly **32 bytes**.

2. **Unique nonce per AES-GCM encryption with the same key**
   - For each encryption operation, a fresh 12-byte nonce is generated using secure random.
   - Reusing nonce with same key in GCM is cryptographically unsafe.

3. **Integrity tag must be verified**
   - AES-GCM decrypt must validate auth tag.
   - If ciphertext or metadata is tampered, decryption fails.

4. **Secure random source is required**
   - Data keys and nonces are generated with CSPRNG (`os.urandom` in Python, `crypto` in Node).

5. **Catalog metadata must remain consistent**
   - Video encryption nonce and wrapped key metadata in `backend/data/catalog.json` must match the encrypted file.

6. **Device keypair persistence**
   - App must keep RSA private key locally (secure storage), and backend needs the matching public key for license response.

---

## 3) Encryption Flow (Admin Side)

Implemented by: `admin_tools/encrypt.py`

1. Read clear video bytes from `videos/`.
2. Generate random `data_key` (32 bytes).
3. Split the clear video logically into fixed-size **pages** inside one container.
4. For each page:
   - generate a fresh random nonce
   - encrypt the page using AES-256-GCM(data_key, page_nonce, page_index_as_aad)
5. Generate random `wrap_nonce` (12 bytes).
6. Wrap `data_key` using AES-256-GCM(master_key, wrap_nonce).
7. Write one encrypted paged container file to `encrypted/<original_name>.enc`.
8. Write metadata to catalog (`backend/data/catalog.json`):
   - key-wrap nonce
   - wrapped data key
   - relative encrypted path
   - total plain size
   - page size
   - page count

---

## 4) Secure License Flow (Current Design)

Implemented mainly in: `backend/src/server.js`, `flutter_app/lib/services/key_service.dart`, `flutter_app/lib/services/crypto_service.dart`

1. App authenticates with serial + device id and uploads public key.
2. App requests `/videos/:videoId/license`.
3. Backend verifies serial/device session.
4. Backend unwraps video data key using master key + wrap nonce.
5. Backend encrypts data key with app RSA public key.
6. Android app unwraps the returned encrypted data key using the **native Android Keystore RSA private key**.
7. Android app stores the decrypted content key locally in protected form.
8. During playback, the player requests byte ranges from a local proxy.
9. The local proxy decrypts only the required paged range and streams the clear bytes to the player.

---

## 5) Playback Architecture (On-Demand Decrypt)

Current production playback path is:

- encrypted file stays encrypted on disk
- player requests bytes/ranges
- local playback proxy asks native crypto layer to decrypt only the requested paged range
- decrypted bytes are returned directly to the player

This avoids:

- segmented multi-file video packaging for playback
- generating one giant plaintext `.mp4` before playback
- repeated backend unwrap work on every play

---

## 6) Operational Checklist

- Ensure `MASTER_KEY_B64` is present and valid (32-byte decoded).
- Keep encrypted files and catalog synchronized.
- If using remote file hosting (Google Drive), re-upload the regenerated `.enc` files and refresh `backend/data/google_drive_index.json`.
- Protect `backend/.env` and never expose master key in client.
- Keep Android Keystore data intact on the device after first authorization so content keys can be reused locally.

---

## 7) Quick Commands

Encrypt videos:

```bash
python admin_tools/encrypt.py --videos-dir videos --catalog backend/data/catalog.json --page-size-mb 1
```

Run backend:

```bash
npm --prefix backend run dev
```

Run Flutter app:

```bash
cmd /c "cd /d d:\Mobile Projects\EducationalPlatform\flutter_app && flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000"
```
