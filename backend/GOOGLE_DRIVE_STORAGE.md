# Google Drive Hosting for Encrypted Files

This backend can serve encrypted video files from **Google Drive** while keeping the app's current `/storage/...` flow unchanged.

It supports **two modes**:

1. **Manual mapping mode** using `backend/data/google_drive_index.json`
2. **Dynamic folder mode** using a single Google Drive folder URL/ID + Drive API access

## How it works

1. The Flutter app requests encrypted content from the backend using `/storage/<relativePath>`.
2. The backend validates the student's token and month subscription.
3. The backend looks up the requested encrypted file in `backend/data/google_drive_index.json`.
4. The backend responds with a `302` redirect to the Google Drive direct-download URL.

## Setup steps

## Option A: Dynamic folder mode

Use this if your Google Drive folder structure matches your local encrypted structure, for example:

```text
encrypted/
  M1/
    S1/
      file1.enc
      file2.enc
```

### Required environment variables

Add these to your hosting platform:

- `GOOGLE_DRIVE_ROOT_FOLDER` = the Google Drive folder URL or folder ID
- `GOOGLE_DRIVE_API_KEY` = Google Drive API key for public file metadata lookup

Optional:

- `GOOGLE_DRIVE_ACCESS_TOKEN` = can be used instead of API key
- `GOOGLE_DRIVE_URL_STYLE` = `usercontent` (default) or `uc`

### How it works

When the app requests `/storage/encrypted/...`, the backend:

1. validates the user token
2. checks the student is subscribed to the month
3. traverses the Google Drive folder tree dynamically
4. finds the file by folder/file name
5. redirects to its Google Drive direct-download URL

### Important note

A plain folder link by itself is **not enough** for downloads. The backend still needs **Drive API access** to resolve each file dynamically from that folder.

---

## Option B: Manual mapping mode

### 1) Upload the encrypted files to Google Drive

Upload the contents of the local `encrypted/` folder to Google Drive.

With the new playback architecture, each record is expected to be one **single-file paged container** such as:

```text
encrypted/M1/S1/(Record) M1 S1 Math.mp4.enc
```

> Important: every encrypted file must be shared so it can be downloaded by direct link.

Recommended sharing mode:

- **Anyone with the link**
- **Viewer**

### 2) Generate the mapping file

Run:

```bash
npm --prefix backend run drive:index
```

This creates or updates:

```text
backend/data/google_drive_index.json
```

### 3) Fill the mapping file

Each key is a file path from `backend/data/catalog.json`.

Replace each empty value with either:

- the Google Drive **file ID**, or
- the full Google Drive **share URL**

Example:

```json
{
  "encrypted/M1/S1/(Record) M1 S1 Math.mp4.enc": "1AbCdEfGhIjKlMnOpQrStUvWxYz123456"
}
```

### 4) Deploy / redeploy the backend

After updating `google_drive_index.json`, push the changes to GitHub and redeploy your backend.

## Optional environment variables

### `GOOGLE_DRIVE_INDEX_PATH`

Overrides the default path of the drive index file.

Default:

```text
backend/data/google_drive_index.json
```

### `GOOGLE_DRIVE_URL_STYLE`

Controls how direct download URLs are generated from a Google Drive file ID.

Supported values:

- `usercontent` (default)
- `uc`

### `GOOGLE_DRIVE_ROOT_FOLDER`

The Google Drive folder URL or folder ID used for **dynamic folder mode**.

Examples:

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz123456
```

or:

```text
1AbCdEfGhIjKlMnOpQrStUvWxYz123456
```

### `GOOGLE_DRIVE_API_KEY`

Google Drive API key used for dynamic folder lookup.

### `GOOGLE_DRIVE_ACCESS_TOKEN`

Optional alternative to API key for dynamic folder lookup.

## Notes

- Google Drive is convenient, but it may enforce bandwidth/quota limits.
- Large files may sometimes be throttled by Google Drive.
- If you later want stronger control and more stable downloads, move to dedicated object storage.