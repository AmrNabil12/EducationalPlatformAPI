const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const ENV_PATH = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: ENV_PATH });

function readEnvValueFromFile(key) {
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;

      const parsedKey = match[1];
      if (parsedKey !== key) continue;

      let value = match[2] || '';
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      return value.trim();
    }
  } catch {
    // ignore and return empty below
  }

  return '';
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const PORT = Number(process.env.PORT || 4000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MASTER_KEY_B64 = String(process.env.MASTER_KEY_B64 || '').trim();

const dataDir = path.join(__dirname, '..', 'data');
const catalogPath = path.join(dataDir, 'catalog.json');

const DATABASE_URL = (process.env.DATABASE_URL || readEnvValueFromFile('DATABASE_URL') || '').trim();
const DATABASE_SSL = String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true';
const GOOGLE_DRIVE_INDEX_PATH = process.env.GOOGLE_DRIVE_INDEX_PATH
  ? path.resolve(process.env.GOOGLE_DRIVE_INDEX_PATH)
  : path.join(dataDir, 'google_drive_index.json');
const GOOGLE_DRIVE_URL_STYLE = String(process.env.GOOGLE_DRIVE_URL_STYLE || 'usercontent')
  .trim()
  .toLowerCase();
const GOOGLE_DRIVE_ROOT_FOLDER = String(
  process.env.GOOGLE_DRIVE_ROOT_FOLDER
  || process.env.GOOGLE_DRIVE_FOLDER_URL
  || process.env.GOOGLE_DRIVE_FOLDER_ID
  || '',
).trim();
const GOOGLE_DRIVE_API_KEY = String(process.env.GOOGLE_DRIVE_API_KEY || '').trim();
const GOOGLE_DRIVE_ACCESS_TOKEN = String(process.env.GOOGLE_DRIVE_ACCESS_TOKEN || '').trim();
const QUIZ_APP_SCRIPT_URL = String(
  process.env.QUIZ_APP_SCRIPT_URL
  || 'https://script.google.com/macros/s/AKfycbyneLSkCmSLpcIYyb9HpSe4WAaJrc99NvkZMRT89GBIcfdP_YjcjNULu_YeFv1upX7RDA/exec',
).trim();
const QUIZ_APP_SCRIPT_SECRET = String(process.env.QUIZ_APP_SCRIPT_SECRET || '').trim();

const STUDENT_SERIALS_TABLE = process.env.STUDENT_SERIALS_TABLE || 'student_serials';
const ADMIN_SERIALS_TABLE = process.env.ADMIN_SERIALS_TABLE || 'admin_serials';

let googleDriveIndexCache = {
  mtimeMs: -1,
  value: {},
};
const googleDriveChildrenCache = new Map();
const googleDrivePathUrlCache = new Map();

if (!DATABASE_URL) {
  console.error(`Missing DATABASE_URL. Configure remote database connection in ${ENV_PATH}`);
  process.exit(1);
}

function sanitizeSqlIdentifier(value) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return identifier;
}

const studentTable = sanitizeSqlIdentifier(STUDENT_SERIALS_TABLE);
const adminTable = sanitizeSqlIdentifier(ADMIN_SERIALS_TABLE);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

const MONTHS = Array.from({ length: 12 }, (_, i) => `M${i + 1}`);

function normalizeSerial(serial) {
  return String(serial || '').trim().toUpperCase();
}

function normalizeManagedSerial(serial) {
  const normalized = normalizeSerial(serial);
  return /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(normalized) ? normalized : '';
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeGender(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'male' || normalized === 'female' ? normalized : '';
}

function normalizePhoneNumber(value) {
  const normalized = String(value || '').trim();
  return /^01[0125]\d{8}$/.test(normalized) ? normalized : '';
}

function normalizeGmailAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9._%+-]+@gmail\.com$/.test(normalized) ? normalized : '';
}

function decodePublicKeyPemHeader(req) {
  const encoded = String(req.get('x-student-public-key-b64') || '').trim();
  if (!encoded) return '';
  try {
    return Buffer.from(encoded, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
}

function isDesktopClientRequest(req) {
  const platform = String(req.get('x-client-platform') || '').trim().toLowerCase();
  return platform === 'windows' || platform === 'linux' || platform === 'macos';
}

function normalizeAvatarDataUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(normalized)) {
    return null;
  }
  return normalized.length <= 1_500_000 ? normalized : null;
}

function normalizeAllowedMonths(value) {
  let tokens = [];

  if (Array.isArray(value)) {
    tokens = value.map((v) => String(v));
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];

    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          tokens = parsed.map((v) => String(v));
        }
      } catch {
        tokens = raw.slice(1, -1).split(/[\s,;|]+/);
      }
    } else if (raw.startsWith('{') && raw.endsWith('}')) {
      tokens = raw.slice(1, -1).split(/[\s,;|]+/);
    } else {
      tokens = raw.split(/[\s,;|]+/);
    }
  }

  const normalized = tokens
    .map((token) => String(token).replace(/["'{}]/g, '').trim().toUpperCase())
    .filter((month) => /^M(1[0-2]|[1-9])$/.test(month));

  return MONTHS.filter((month) => normalized.includes(month));
}

function readCatalog() {
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const decoded = JSON.parse(raw);
    return {
      videos: Array.isArray(decoded?.videos) ? decoded.videos : [],
      pdfs:   Array.isArray(decoded?.pdfs)   ? decoded.pdfs   : [],
    };
  } catch {
    return { videos: [], pdfs: [] };
  }
}

function writeCatalog(catalog) {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(
    catalogPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      videos: Array.isArray(catalog?.videos) ? catalog.videos : [],
      pdfs: Array.isArray(catalog?.pdfs) ? catalog.pdfs : [],
    }, null, 2)}\n`,
    'utf8',
  );
}

function buildChunkManifest(video) {
  const chunks = Array.isArray(video?.storage?.chunks) ? video.storage.chunks : [];
  return chunks.map((chunk, index) => {
    const relativePath = String(chunk?.relativePath || '').replaceAll('\\', '/');
    const fileName = path.basename(String(chunk?.fileName || relativePath || ''));
    return {
      index: Number(chunk?.index) || index,
      fileName,
      url: `/storage/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
      nonceB64: String(chunk?.nonceB64 || ''),
      plainSize: Number(chunk?.plainSize) || 0,
      encryptedSize: Number(chunk?.encryptedSize) || 0,
      relativePath,
    };
  }).filter((chunk) => chunk.relativePath || chunk.fileName);
}

function buildPagedContentUrl(video) {
  const relativePath = String(video?.storage?.relativePath || '').replaceAll('\\', '/');
  if (!relativePath) return '';
  return `/storage/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

function aesGcmDecrypt(key, nonceB64, encryptedB64) {
  const iv = Buffer.from(String(nonceB64 || ''), 'base64');
  const encrypted = Buffer.from(String(encryptedB64 || ''), 'base64');
  if (encrypted.length <= 16) {
    throw new Error('Wrapped key payload is invalid');
  }

  const authTag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function getStudentBySerial(client, serial) {
  let result;
  try {
    result = await client.query(
      `SELECT id, serial_no, full_name, gender, phone_number, parent_phone_number, email, avatar_data_url, device_id, active, allowed_months, public_key_pem
       FROM "${studentTable}"
       WHERE UPPER(serial_no) = UPPER($1)
       LIMIT 1`,
      [serial],
    );
  } catch (error) {
    if (error?.code !== '42703') throw error;
    result = await client.query(
      `SELECT id, serial_no, full_name, gender, phone_number, parent_phone_number, email, device_id, active, allowed_months, public_key_pem
       FROM "${studentTable}"
       WHERE UPPER(serial_no) = UPPER($1)
       LIMIT 1`,
      [serial],
    );
  }

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function getAdminBySerial(client, serial) {
  let result;
  try {
    result = await client.query(
      `SELECT id, serial_no, device_id, public_key_pem, active, created_at, updated_at
       FROM "${adminTable}"
       WHERE UPPER(serial_no) = UPPER($1)
       LIMIT 1`,
      [serial],
    );
  } catch (error) {
    if (error?.code !== '42703') throw error;
    result = await client.query(
      `SELECT id, serial_no, device_id, active, created_at, updated_at
       FROM "${adminTable}"
       WHERE UPPER(serial_no) = UPPER($1)
       LIMIT 1`,
      [serial],
    );
  }

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

function mapStudentProfile(row) {
  return {
    fullName: String(row?.full_name || '').trim(),
    email: String(row?.email || '').trim(),
    phoneNumber: String(row?.phone_number || '').trim(),
    parentPhoneNumber: String(row?.parent_phone_number || '').trim(),
    gender: String(row?.gender || '').trim(),
    avatarDataUrl: String(row?.avatar_data_url || '').trim(),
  };
}

function mapAdminSerialRow(row) {
  return {
    serial: String(row?.serial_no || '').trim().toUpperCase(),
    fullName: String(row?.full_name || '').trim(),
    email: String(row?.email || '').trim(),
    phoneNumber: String(row?.phone_number || '').trim(),
    active: row?.active !== false,
    createdAt: row?.created_at || null,
  };
}

function normalizeMonthCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^M(1[0-2]|[1-9])$/.test(normalized) ? normalized : '';
}

function normalizeSessionCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^S\d+$/.test(normalized) ? normalized : '';
}

async function ensureCatalogSessions(client, catalog) {
  const pairs = new Map();

  for (const entry of [...(catalog?.videos || []), ...(catalog?.pdfs || [])]) {
    const month = normalizeMonthCode(entry?.month);
    const session = normalizeSessionCode(entry?.session);
    if (!month || !session) continue;
    pairs.set(`${month}:${session}`, { month, session });
  }

  for (const pair of pairs.values()) {
    await client.query(
      `INSERT INTO sessions (month_code, session_code, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (month_code, session_code) DO NOTHING`,
      [pair.month, pair.session, `${pair.month} ${pair.session}`],
    );
  }
}

async function loadSessionMap(client) {
  const result = await client.query(
    `SELECT id, month_code, session_code, title, video_metadata
     FROM sessions`,
  );

  const map = new Map();
  for (const row of result.rows) {
    const month = normalizeMonthCode(row.month_code);
    const session = normalizeSessionCode(row.session_code);
    if (!month || !session) continue;
    map.set(`${month}:${session}`, row);
  }
  return map;
}

function normalizeSessionVideoMetadata(value) {
  let raw = value && typeof value === 'object' ? value : null;
  if (!raw && typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      raw = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      raw = null;
    }
  }
  if (!raw) {
    return null;
  }

  const id = String(raw.id || '').trim();
  const wrappedKeyB64 = String(raw?.encryption?.keyWrap?.wrappedKeyB64 || '').trim();
  const wrapNonceB64 = String(raw?.encryption?.keyWrap?.nonceB64 || '').trim();
  const storageMode = String(raw?.storage?.mode || 'paged').trim().toLowerCase() || 'paged';
  const totalPlainSize = Number(raw?.storage?.totalPlainSize);
  const pageSize = Number(raw?.storage?.pageSize);
  const pageCount = Number(raw?.storage?.pageCount);
  const createdAtRaw = String(raw.createdAt || '').trim();
  const createdAtDate = createdAtRaw ? new Date(createdAtRaw) : new Date();
  const googleDriveUrl = String(raw.google_drive_url || raw.googleDriveUrl || '').trim();

  if (!id || !wrappedKeyB64 || !wrapNonceB64) {
    return null;
  }

  return {
    id,
    encryption: {
      algorithm: String(raw?.encryption?.algorithm || 'AES-256-GCM').trim() || 'AES-256-GCM',
      nonceB64: String(raw?.encryption?.nonceB64 || '').trim(),
      keyWrap: {
        algorithm: String(raw?.encryption?.keyWrap?.algorithm || 'AES-256-GCM').trim() || 'AES-256-GCM',
        nonceB64: wrapNonceB64,
        wrappedKeyB64,
      },
    },
    storage: {
      mode: storageMode,
      totalPlainSize: Number.isFinite(totalPlainSize) ? totalPlainSize : null,
      pageSize: Number.isFinite(pageSize) ? pageSize : null,
      pageCount: Number.isFinite(pageCount) ? pageCount : null,
    },
    googleDriveUrl,
    createdAt: Number.isNaN(createdAtDate.getTime())
      ? new Date().toISOString()
      : createdAtDate.toISOString(),
  };
}

function buildSessionVideoRecord(row) {
  const month = normalizeMonthCode(row?.month_code);
  const session = normalizeSessionCode(row?.session_code);
  const title = normalizeName(row?.title);
  const metadata = normalizeSessionVideoMetadata(row?.video_metadata);

  if (!month || !session || !title || !metadata) {
    return null;
  }

  return {
    id: metadata.id,
    title,
    month,
    session,
    durationSec: null,
    encryption: metadata.encryption,
    storage: metadata.storage,
    googleDriveUrl: metadata.googleDriveUrl,
    createdAt: metadata.createdAt,
  };
}

function buildSessionVideoContentUrl(videoId) {
  return `/videos/${encodeURIComponent(String(videoId || '').trim())}/content`;
}

function buildPdfSessionContentUrl(pdfId) {
  return `/pdfs/${encodeURIComponent(String(pdfId || '').trim())}/content`;
}

async function loadVideoEnabledSessionRows(client) {
  const result = await client.query(
    `SELECT id, month_code, session_code, title, video_metadata
     FROM sessions
     WHERE video_metadata IS NOT NULL`,
  );

  return result.rows
    .map((row) => ({
      ...row,
      normalizedVideo: buildSessionVideoRecord(row),
    }))
    .filter((row) => row.normalizedVideo);
}

async function findVideoSessionRowByVideoId(client, videoId) {
  const result = await client.query(
    `SELECT id, month_code, session_code, title, video_metadata
     FROM sessions
     WHERE video_metadata IS NOT NULL
       AND video_metadata->>'id' = $1
     LIMIT 1`,
    [String(videoId || '').trim()],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  const normalizedVideo = buildSessionVideoRecord(row);
  if (!normalizedVideo) {
    return null;
  }

  return {
    ...row,
    normalizedVideo,
  };
}

function buildPdfSessionRecord(row) {
  const id = String(row?.id || '').trim();
  const month = normalizeMonthCode(row?.month_code);
  const session = normalizeSessionCode(row?.session_code);
  const title = normalizeName(row?.title);
  const googleDriveUrl = normalizeGoogleDriveValue(row?.google_drive_url);

  if (!id || !month || !session || !title || !googleDriveUrl) {
    return null;
  }

  return {
    id,
    title,
    month,
    session,
    downloadUrl: buildPdfSessionContentUrl(id),
    googleDriveUrl,
  };
}

async function loadPdfSessionRows(client) {
  let result;
  try {
    result = await client.query(
      `SELECT id, month_code, session_code, title, google_drive_url
       FROM pdf_sessions`,
    );
  } catch (error) {
    if (error?.code === '42P01') {
      return [];
    }
    throw error;
  }

  return result.rows
    .map((row) => ({
      ...row,
      normalizedPdf: buildPdfSessionRecord(row),
    }))
    .filter((row) => row.normalizedPdf);
}

async function findPdfSessionRowByPdfId(client, pdfId) {
  let result;
  try {
    result = await client.query(
      `SELECT id, month_code, session_code, title, google_drive_url
       FROM pdf_sessions
       WHERE id = $1
       LIMIT 1`,
      [String(pdfId || '').trim()],
    );
  } catch (error) {
    if (error?.code === '42P01') {
      return null;
    }
    throw error;
  }

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  const normalizedPdf = buildPdfSessionRecord(row);
  if (!normalizedPdf) {
    return null;
  }

  return {
    ...row,
    normalizedPdf,
  };
}

function normalizePendingEncryptedVideoRecord(value) {
  const raw = value && typeof value === 'object' ? value : null;
  if (!raw) {
    return { error: 'video record is required' };
  }

  const id = String(raw.id || '').trim() || crypto.randomUUID();
  const title = normalizeName(raw.title);
  const month = normalizeMonthCode(raw.month);
  const session = normalizeSessionCode(raw.session);
  const wrappedKeyB64 = String(raw?.encryption?.keyWrap?.wrappedKeyB64 || '').trim();
  const wrapNonceB64 = String(raw?.encryption?.keyWrap?.nonceB64 || '').trim();
  const googleDriveUrl = String(raw.googleDriveUrl || raw.google_drive_url || '').trim();
  const totalPlainSize = Number(raw?.storage?.totalPlainSize);
  const pageSize = Number(raw?.storage?.pageSize);
  const pageCount = Number(raw?.storage?.pageCount);
  const createdAtRaw = String(raw.createdAt || '').trim();
  const createdAtDate = createdAtRaw ? new Date(createdAtRaw) : new Date();

  if (!title) {
    return { error: 'Encrypted video title is required' };
  }
  if (!month) {
    return { error: 'Encrypted video month must be in the form M1..M12' };
  }
  if (!session) {
    return { error: 'Encrypted video session must be in the form S1, S2, ...' };
  }
  if (!wrappedKeyB64 || !wrapNonceB64) {
    return { error: 'Encrypted video key-wrap metadata is missing' };
  }
  if (!googleDriveUrl) {
    return { error: 'Encrypted video Google Drive URL is required' };
  }

  return {
    record: {
      id,
      title,
      month,
      session,
      googleDriveUrl,
      videoMetadata: {
        id,
        encryption: {
          algorithm: String(raw?.encryption?.algorithm || 'AES-256-GCM').trim() || 'AES-256-GCM',
          nonceB64: String(raw?.encryption?.nonceB64 || '').trim(),
          keyWrap: {
            algorithm: String(raw?.encryption?.keyWrap?.algorithm || 'AES-256-GCM').trim() || 'AES-256-GCM',
            nonceB64: wrapNonceB64,
            wrappedKeyB64,
          },
        },
        storage: {
          mode: String(raw?.storage?.mode || 'paged').trim().toLowerCase() || 'paged',
          totalPlainSize: Number.isFinite(totalPlainSize) ? totalPlainSize : null,
          pageSize: Number.isFinite(pageSize) ? pageSize : null,
          pageCount: Number.isFinite(pageCount) ? pageCount : null,
        },
        google_drive_url: googleDriveUrl,
        createdAt: Number.isNaN(createdAtDate.getTime())
          ? new Date().toISOString()
          : createdAtDate.toISOString(),
      },
    },
  };
}

function normalizePendingPdfRecord(value) {
  const raw = value && typeof value === 'object' ? value : null;
  if (!raw) {
    return { error: 'pdf record is required' };
  }

  const id = String(raw.id || '').trim() || crypto.randomUUID();
  const title = normalizeName(raw.title);
  const month = normalizeMonthCode(raw.month);
  const session = normalizeSessionCode(raw.session);
  const googleDriveUrl = normalizeGoogleDriveValue(
    raw.googleDriveUrl || raw.google_drive_url,
  );
  const createdAtRaw = String(raw.createdAt || '').trim();
  const createdAtDate = createdAtRaw ? new Date(createdAtRaw) : new Date();

  if (!title) {
    return { error: 'PDF title is required' };
  }
  if (!month) {
    return { error: 'PDF month must be in the form M1..M12' };
  }
  if (!session) {
    return { error: 'PDF session must be in the form S1, S2, ...' };
  }
  if (!googleDriveUrl) {
    return { error: 'PDF Google Drive URL is required' };
  }

  return {
    record: {
      id,
      title,
      month,
      session,
      googleDriveUrl,
      createdAt: Number.isNaN(createdAtDate.getTime())
        ? new Date().toISOString()
        : createdAtDate.toISOString(),
    },
  };
}

function normalizeAdminQuizPayload(value) {
  const raw = value && typeof value === 'object' ? value : null;
  if (!raw) {
    return { error: 'quiz payload is required' };
  }

  const month = normalizeMonthCode(raw.month);
  const session = normalizeSessionCode(raw.session);
  const driveFolderId = extractGoogleDriveId(raw.driveFolderUrl || raw.drive_folder_url || raw.driveFolderId || raw.drive_folder_id);
  const questionCount = Number(raw.questionCount);

  if (!month) {
    return { error: 'Quiz month must be in the form M1..M12' };
  }
  if (!session) {
    return { error: 'Quiz session must be in the form S1, S2, ...' };
  }
  if (!driveFolderId) {
    return { error: 'Quiz Google Drive folder URL is invalid' };
  }
  if (!Number.isInteger(questionCount) || questionCount <= 0) {
    return { error: 'Quiz question count must be a positive integer' };
  }

  let metadata;
  try {
    metadata = normalizeQuizMetadata(raw.metadata);
  } catch (error) {
    return { error: `Invalid quiz metadata: ${error.message}` };
  }

  if (metadata.length !== questionCount) {
    return {
      error: `Quiz metadata count (${metadata.length}) does not match questionCount (${questionCount})`,
    };
  }

  return {
    record: {
      month,
      session,
      driveFolderId,
      questionCount,
      metadata,
    },
  };
}

async function getSessionById(client, sessionId) {
  const result = await client.query(
    `SELECT id, month_code, session_code, title
     FROM sessions
     WHERE id = $1
     LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] || null;
}

async function getQuizSessionConfig(client, sessionId) {
  const result = await client.query(
    `SELECT id, session_id, drive_folder_id, encrypted_metadata, question_count, created_at, updated_at
     FROM quiz_sessions
     WHERE session_id = $1
     LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] || null;
}

async function loadQuizEnabledSessionIds(client) {
  const result = await client.query(
    'SELECT session_id::text AS session_id FROM quiz_sessions',
  );
  return new Set(result.rows.map((row) => String(row.session_id || '')));
}

function extractMonthNumber(value) {
  const match = String(value || '').trim().toUpperCase().match(/^M(1[0-2]|[1-9])$/);
  if (!match) return null;
  return Number(match[1]) || null;
}

async function buildAuthorizedMonthsPayload(client, allowedMonths) {
  const catalog = readCatalog();
  await ensureCatalogSessions(client, catalog);
  await syncLegacyCatalogVideosToSessions(client, catalog);
  const sessionMap = await loadSessionMap(client);
  const videoRows = await loadVideoEnabledSessionRows(client);
  const pdfRows = await loadPdfSessionRows(client);
  const quizEnabledSessionIds = await loadQuizEnabledSessionIds(client);

  const months = allowedMonths.map((month) => {
    const videos = videoRows
      .filter((row) => normalizeMonthCode(row.month_code) === month)
      .map((row) => row.normalizedVideo);

    const pdfs = pdfRows
      .filter((row) => normalizeMonthCode(row.month_code) === month)
      .map((row) => row.normalizedPdf);

    const quizzes = Array.from(sessionMap.values())
      .filter((row) => normalizeMonthCode(row.month_code) === month)
      .map((row) => ({
        month,
        session: normalizeSessionCode(row.session_code),
        sessionId: row?.id ? String(row.id) : '',
        hasQuiz: Boolean(row?.id && quizEnabledSessionIds.has(String(row.id))),
      }))
      .filter((quiz) => quiz.session && quiz.hasQuiz && quiz.sessionId);

    return { month, videos, pdfs, quizzes };
  });

  return months;
}

async function getLatestAvailableMonthNumber(client) {
  const result = await client.query('SELECT month_code FROM sessions');
  let latest = 0;
  for (const row of result.rows) {
    const monthNumber = extractMonthNumber(row.month_code);
    if (monthNumber && monthNumber > latest) latest = monthNumber;
  }
  return latest;
}

async function loadQuizTotalPointsMap(client, sessionIds) {
  const totals = new Map();
  for (const sessionId of sessionIds) {
    if (!sessionId) continue;

    const quizSessionConfig = await getQuizSessionConfig(client, sessionId);
    if (!quizSessionConfig) {
      totals.set(sessionId, 0);
      continue;
    }
    totals.set(sessionId, buildFolderQuizMetadataDefinition(quizSessionConfig).totalPoints);
  }
  return totals;
}

function buildLast30DayActivity(quizRows, videoRows) {
  const counts = new Map();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let offset = 29; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - offset);
    counts.set(day.toISOString().slice(0, 10), 0);
  }

  for (const row of [...quizRows, ...videoRows]) {
    const key = new Date(row.activity_at).toISOString().slice(0, 10);
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return Array.from(counts.entries()).map(([date, count]) => ({ date, count }));
}

async function buildStudentDashboardPayload(client, authState, monthsPayload = null) {
  const months = monthsPayload || await buildAuthorizedMonthsPayload(client, authState.allowedMonths);
  const latestAvailableMonthNumber = await getLatestAvailableMonthNumber(client);
  const enrolledMonthNumbers = new Set(
    authState.allowedMonths
      .map((month) => extractMonthNumber(month))
      .filter((value) => Number.isInteger(value)),
  );

  let missingMonthsCount = 0;
  for (let monthNumber = 1; monthNumber <= latestAvailableMonthNumber; monthNumber += 1) {
    if (!enrolledMonthNumbers.has(monthNumber)) {
      missingMonthsCount += 1;
    }
  }

  const videoIds = Array.from(new Set(
    months.flatMap((month) => month.videos.map((video) => String(video.id || ''))).filter(Boolean),
  ));
  const quizSessionIds = Array.from(new Set(
    months.flatMap((month) => month.quizzes.map((quiz) => String(quiz.sessionId || ''))).filter(Boolean),
  ));

  let hasVideoWatchHistory = false;
  try {
    const watchHistoryResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM student_video_watches
       WHERE student_id = $1`,
      [authState.student.id],
    );
    hasVideoWatchHistory = (Number(watchHistoryResult.rows[0]?.count) || 0) > 0;
  } catch (error) {
    if (error?.code !== '42P01') throw error;
  }

  let watchedVideos = [];
  if (videoIds.length > 0) {
    try {
      const result = await client.query(
        `SELECT video_id, qualified_at AS activity_at
         FROM student_video_watches
         WHERE student_id = $1 AND video_id = ANY($2::text[])`,
        [authState.student.id, videoIds],
      );
      watchedVideos = result.rows;
    } catch (error) {
      if (error?.code !== '42P01') throw error;
    }
  }

  let solvedQuizRows = [];
  if (quizSessionIds.length > 0) {
    const result = await client.query(
      `SELECT session_id::text AS session_id, score, created_at AS activity_at
       FROM quiz_results
       WHERE student_id = $1 AND session_id = ANY($2::uuid[])`,
      [authState.student.id, quizSessionIds],
    );
    solvedQuizRows = result.rows;
  }

  const quizTotalPointsBySessionId = await loadQuizTotalPointsMap(client, quizSessionIds);
  let performanceScorePercent = 0;
  if (solvedQuizRows.length > 0) {
    const percentageSum = solvedQuizRows.reduce((sum, row) => {
      const totalPoints = Number(quizTotalPointsBySessionId.get(String(row.session_id || ''))) || 0;
      if (totalPoints <= 0) return sum;
      return sum + ((Number(row.score) || 0) / totalPoints) * 100;
    }, 0);
    performanceScorePercent = percentageSum / solvedQuizRows.length;
  }

  const totalVideos = videoIds.length;
  const totalQuizzes = quizSessionIds.length;
  const watchedVideosCount = watchedVideos.length;
  const solvedQuizzesCount = solvedQuizRows.length;
  const isDefaultState = !hasVideoWatchHistory && solvedQuizzesCount === 0;

  if (isDefaultState) {
    const enrolledMonthsCount = authState.allowedMonths.length;
    return {
      generatedAt: new Date().toISOString(),
      isDefaultState: true,
      hasVideoWatchHistory: false,
      enrolledMonthsCount,
      missingMonthsCount: Math.max(latestAvailableMonthNumber - enrolledMonthsCount, 0),
      latestAvailableMonthNumber,
      totalVideos,
      watchedVideosCount: 0,
      videoProgressPercent: 0,
      totalQuizzes,
      solvedQuizzesCount: 0,
      quizProgressPercent: null,
      performanceScorePercent: null,
      activity: [],
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    isDefaultState: false,
    hasVideoWatchHistory,
    enrolledMonthsCount: authState.allowedMonths.length,
    missingMonthsCount,
    latestAvailableMonthNumber,
    totalVideos,
    watchedVideosCount,
    videoProgressPercent: totalVideos > 0 ? (watchedVideosCount / totalVideos) * 100 : 0,
    totalQuizzes,
    solvedQuizzesCount,
    quizProgressPercent: totalQuizzes > 0 ? (solvedQuizzesCount / totalQuizzes) * 100 : 0,
    performanceScorePercent,
    activity: buildLast30DayActivity(solvedQuizRows, watchedVideos),
  };
}

function normalizeQuizMetadata(rawValue) {
  if (!rawValue) return [];
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    parsed = JSON.parse(rawValue);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Quiz metadata must be a JSON array');
  }

  return parsed.map((entry, index) => {
    const options = Array.isArray(entry?.options)
      ? entry.options.map((option) => String(option ?? '').trim())
      : [];
    const correctOptionIndex = Number.isInteger(entry?.correct)
      ? Number(entry.correct)
      : Number.isInteger(entry?.correctOptionIndex)
        ? Number(entry.correctOptionIndex)
        : -1;
    const points = Number(entry?.points ?? 1);
    if (options.length < 2) {
      throw new Error(`Quiz metadata item ${index + 1} must have at least 2 options`);
    }
    if (correctOptionIndex < 0 || correctOptionIndex >= options.length) {
      throw new Error(`Quiz metadata item ${index + 1} has invalid correct option index`);
    }
    return {
      questionNumber: Number(entry?.q ?? index + 1) || index + 1,
      options,
      correctOptionIndex,
      points: Number.isFinite(points) && points >= 0 ? points : 1,
    };
  });
}

function createGoogleDriveViewUrl(fileId) {
  const normalizedFileId = String(fileId || '').trim();
  if (!normalizedFileId) return '';
  return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(normalizedFileId)}`;
}

function httpsGetJsonByAbsoluteUrl(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const request = https.get(url, (response) => {
      let body = '';
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = String(response.headers.location || '').trim();
          if (!location) {
            reject(new Error(`Quiz Apps Script redirect (${response.statusCode}) did not include a location header`));
            return;
          }
          if (redirectCount >= 5) {
            reject(new Error('Quiz Apps Script redirected too many times'));
            return;
          }

          const nextUrl = new URL(location, url).toString();
          resolve(httpsGetJsonByAbsoluteUrl(nextUrl, redirectCount + 1));
          return;
        }

        if (response.statusCode >= 400) {
          reject(new Error(`Request failed with status ${response.statusCode}`));
          return;
        }

        const trimmedBody = String(body || '').trim();
        const normalizedBody = trimmedBody.replace(/^\)\]\}'\s*/, '');

        if (!normalizedBody) {
          resolve([]);
          return;
        }

        if (contentType.includes('text/html') || normalizedBody.startsWith('<!DOCTYPE html') || normalizedBody.startsWith('<html')) {
          const snippet = normalizedBody.replace(/\s+/g, ' ').slice(0, 180);
          reject(new Error(`Quiz Apps Script returned HTML instead of JSON. Check that QUIZ_APP_SCRIPT_URL is deployed as a public Web App and that drive_folder_id is valid. Response snippet: ${snippet}`));
          return;
        }

        try {
          resolve(JSON.parse(normalizedBody));
        } catch {
          const snippet = normalizedBody.replace(/\s+/g, ' ').slice(0, 180);
          reject(new Error(`Invalid JSON returned from quiz Apps Script URL. Check the Apps Script response format. Response snippet: ${snippet}`));
        }
      });
    });
    request.on('error', reject);
  });
}

function httpsPostJsonByAbsoluteUrl(rawUrl, payload, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const request = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(body.length),
        },
      },
      (response) => {
        let responseBody = '';
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 300 && response.statusCode < 400) {
            const location = String(response.headers.location || '').trim();
            if (!location) {
              reject(new Error(`Quiz Apps Script redirect (${response.statusCode}) did not include a location header`));
              return;
            }
            if (redirectCount >= 5) {
              reject(new Error('Quiz Apps Script redirected too many times'));
              return;
            }

            const nextUrl = new URL(location, url).toString();
            // Apps Script often responds to POST /exec with a 302 to a
            // script.googleusercontent.com endpoint that should be followed
            // as GET. Preserve POST only for 307/308.
            if (response.statusCode === 307 || response.statusCode === 308) {
              resolve(httpsPostJsonByAbsoluteUrl(nextUrl, payload, redirectCount + 1));
              return;
            }
            resolve(httpsGetJsonByAbsoluteUrl(nextUrl, redirectCount + 1));
            return;
          }

          const trimmedBody = String(responseBody || '').trim();
          const normalizedBody = trimmedBody.replace(/^\)\]\}'\s*/, '');

          if (!normalizedBody) {
            resolve({});
            return;
          }

          if (contentType.includes('text/html') || normalizedBody.startsWith('<!DOCTYPE html') || normalizedBody.startsWith('<html')) {
            const snippet = normalizedBody.replace(/\s+/g, ' ').slice(0, 180);
            reject(new Error(`Quiz Apps Script returned HTML instead of JSON (status ${response.statusCode}, host ${url.hostname}). Ensure Web App access is "Anyone" and the /exec URL is current. Response snippet: ${snippet}`));
            return;
          }

          let parsed = null;
          try {
            parsed = JSON.parse(normalizedBody);
          } catch {
            const snippet = normalizedBody.replace(/\s+/g, ' ').slice(0, 180);
            reject(new Error(`Invalid JSON returned from quiz Apps Script URL. Check the Apps Script response format. Response snippet: ${snippet}`));
            return;
          }

          if (response.statusCode >= 400) {
            reject(new Error(String(parsed?.error || `Quiz Apps Script request failed with status ${response.statusCode}`)));
            return;
          }

          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
            reject(new Error(String(parsed.error)));
            return;
          }

          resolve(parsed);
        });
      },
    );

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function fetchQuizFolderFiles(quizSessionConfig) {
  const baseUrl = String(QUIZ_APP_SCRIPT_URL || '').trim();
  const rawFolderValue = String(quizSessionConfig?.drive_folder_id || '').trim();
  const folderId = extractGoogleDriveId(rawFolderValue) || rawFolderValue;
  if (!baseUrl || !folderId) {
    throw new Error('Quiz session is missing QUIZ_APP_SCRIPT_URL or drive_folder_id');
  }

  const url = new URL(baseUrl);
  // Always attach folder identifiers. This keeps listing working even if
  // QUIZ_APP_SCRIPT_URL is configured as script.googleusercontent.com.
  url.searchParams.set('folderId', folderId);
  url.searchParams.set('driveFolderId', folderId);
  const fileList = await httpsGetJsonByAbsoluteUrl(url.toString());
  if (!Array.isArray(fileList)) {
    throw new Error('Quiz Apps Script did not return an array');
  }

  return fileList
    .map((file, index) => ({
      index,
      name: String(file?.name || ''),
      id: String(file?.id || ''),
    }))
    .filter((file) => file.name && file.id)
    .sort((a, b) => {
      const aNum = Number.parseInt(a.name, 10);
      const bNum = Number.parseInt(b.name, 10);
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
      return a.name.localeCompare(b.name);
    });
}

async function uploadQuizQuestionImageViaAppsScript({
  driveFolderUrl,
  driveFolderId,
  questionNumber,
  originalFileName,
  imageBase64,
}) {
  const baseUrl = String(QUIZ_APP_SCRIPT_URL || '').trim();
  if (!baseUrl) {
    throw new Error('QUIZ_APP_SCRIPT_URL is required to upload quiz images');
  }

  const payload = {
    action: 'uploadQuizImage',
    folderId: String(driveFolderId || '').trim(),
    driveFolderId: String(driveFolderId || '').trim(),
    driveFolderUrl: String(driveFolderUrl || '').trim(),
    questionNumber,
    originalFileName: String(originalFileName || '').trim(),
    imageBase64: String(imageBase64 || '').trim(),
  };
  if (QUIZ_APP_SCRIPT_SECRET) {
    payload.secret = QUIZ_APP_SCRIPT_SECRET;
  }

  const result = await httpsPostJsonByAbsoluteUrl(baseUrl, payload);
  if (!result || typeof result !== 'object') {
    throw new Error('Quiz Apps Script did not return a valid upload response');
  }
  if (Array.isArray(result)) {
    throw new Error('Quiz Apps Script returned a file list instead of an upload result. Ensure doPost returns { file: { id, fileName, questionNumber, imageUrl } }.');
  }
  if (result.error) {
    throw new Error(String(result.error));
  }
  const file = result.file;
  const fileId = String(file?.id || '').trim();
  if (!file || !fileId) {
    throw new Error(`Quiz Apps Script upload response is missing file.id. Response: ${JSON.stringify(result).slice(0, 280)}`);
  }

  return result;
}

function encryptJsonForStudent(publicKeyPem, payload) {
  const json = JSON.stringify(payload);
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    dataKey,
  );

  return {
    encryptedPackageB64: Buffer.concat([encrypted, authTag]).toString('base64'),
    encryptedPackageKeyB64: encryptedKey.toString('base64'),
    packageNonceB64: iv.toString('base64'),
  };
}

function buildFolderQuizMetadataDefinition(quizSessionConfig) {
  const metadata = normalizeQuizMetadata(quizSessionConfig.encrypted_metadata);
  const questions = metadata.map((entry, index) => ({
    index,
    questionNumber: entry.questionNumber,
    options: entry.options,
    correctOptionIndex: entry.correctOptionIndex,
    points: entry.points,
  }));

  return {
    questionCount: questions.length,
    totalPoints: questions.reduce((sum, question) => sum + (Number(question.points) || 0), 0),
    questions,
  };
}

async function buildFolderQuizDefinition(quizSessionConfig) {
  const metadataDefinition = buildFolderQuizMetadataDefinition(quizSessionConfig);
  const files = await fetchQuizFolderFiles(quizSessionConfig);
  if (files.length !== metadataDefinition.questions.length) {
    throw new Error(`Quiz folder image count (${files.length}) does not match metadata count (${metadataDefinition.questions.length})`);
  }

  const questions = metadataDefinition.questions.map((entry, index) => ({
    index,
    questionNumber: entry.questionNumber,
    fileId: files[index].id,
    fileName: files[index].name,
    imageUrl: createGoogleDriveViewUrl(files[index].id),
    options: entry.options,
    correctOptionIndex: entry.correctOptionIndex,
    points: entry.points,
  }));

  return {
    questionCount: questions.length,
    totalPoints: questions.reduce((sum, question) => sum + (Number(question.points) || 0), 0),
    questions,
  };
}

function mapFolderQuizQuestionForPlayer(question) {
  return {
    id: `folder-question-${question.index + 1}`,
    imageUrl: String(question.imageUrl || ''),
    imageFileName: String(question.fileName || ''),
    imageDownloadUrl: createGoogleDriveDownloadUrl(question.fileId),
    optionsCount: Array.isArray(question.options) ? question.options.length : 0,
    points: Number(question.points) || 0,
  };
}

async function buildQuizStatusPayload(client, studentId, sessionRow, publicKeyPem = '') {
  const quizSessionConfig = await getQuizSessionConfig(client, sessionRow.id);
  if (!quizSessionConfig) {
    return {
      hasQuiz: false,
      attempted: false,
      deliveryMode: 'folder_sync',
      sessionId: String(sessionRow.id),
      month: String(sessionRow.month_code || ''),
      session: String(sessionRow.session_code || ''),
      totalQuestions: 0,
      totalPoints: 0,
    };
  }

  const definition = buildFolderQuizMetadataDefinition(quizSessionConfig);
  const hasQuiz = definition.questionCount > 0;
  if (!studentId) {
    return {
      hasQuiz,
      attempted: false,
      deliveryMode: 'folder_sync',
      sessionId: String(sessionRow.id),
      month: String(sessionRow.month_code || ''),
      session: String(sessionRow.session_code || ''),
      totalQuestions: definition.questionCount,
      totalPoints: definition.totalPoints,
    };
  }

  const result = await client.query(
    `SELECT id, score, total_questions, student_answers, time_taken_seconds, created_at
     FROM quiz_results
     WHERE student_id = $1 AND session_id = $2
     LIMIT 1`,
    [studentId, sessionRow.id],
  );

  if (result.rowCount === 0) {
    return {
      hasQuiz,
      attempted: false,
      deliveryMode: 'folder_sync',
      sessionId: String(sessionRow.id),
      month: String(sessionRow.month_code || ''),
      session: String(sessionRow.session_code || ''),
      totalQuestions: definition.questionCount,
      totalPoints: definition.totalPoints,
    };
  }

  const row = result.rows[0];
  const studentAnswers = Array.isArray(row.student_answers) ? row.student_answers : [];
  return {
    hasQuiz,
    attempted: true,
    deliveryMode: 'folder_sync',
    sessionId: String(sessionRow.id),
    month: String(sessionRow.month_code || ''),
    session: String(sessionRow.session_code || ''),
    totalQuestions: definition.questionCount,
    totalPoints: definition.totalPoints,
    result: {
      id: String(row.id),
      score: Number(row.score) || 0,
      totalQuestions: Number(row.total_questions) || 0,
      totalPoints: definition.totalPoints,
      studentAnswers,
      timeTakenSeconds: Number(row.time_taken_seconds) || 0,
      createdAt: row.created_at,
    },
  };
}

async function buildQuizContentPayload(
  client,
  sessionRow,
  publicKeyPem = '',
  allowPlainMetadataKey = false,
) {
  const quizSessionConfig = await getQuizSessionConfig(client, sessionRow.id);
  if (!quizSessionConfig) {
    return {
      hasQuiz: false,
      attempted: false,
      deliveryMode: 'folder_sync',
      sessionId: String(sessionRow.id),
      month: String(sessionRow.month_code || ''),
      session: String(sessionRow.session_code || ''),
      totalQuestions: 0,
      totalPoints: 0,
      questions: [],
    };
  }

  const definition = await buildFolderQuizDefinition(quizSessionConfig);
  if (!publicKeyPem && !allowPlainMetadataKey) {
    throw new Error('Missing student public key for encrypted quiz metadata');
  }

  const quizPayload = {
    version: 1,
    sessionId: String(sessionRow.id),
    month: String(sessionRow.month_code || ''),
    session: String(sessionRow.session_code || ''),
    questions: definition.questions.map((question) => ({
      q: question.questionNumber,
      options: question.options,
      correct: question.correctOptionIndex,
      points: question.points,
    })),
  };

  let encryptedPackage;
  if (publicKeyPem) {
    encryptedPackage = encryptJsonForStudent(publicKeyPem, quizPayload);
  } else {
    const json = JSON.stringify(quizPayload);
    const dataKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    encryptedPackage = {
      encryptedPackageB64: Buffer.concat([encrypted, authTag]).toString('base64'),
      encryptedPackageKeyB64: '',
      plainPackageKeyB64: dataKey.toString('base64'),
      packageNonceB64: iv.toString('base64'),
    };
  }

  return {
    hasQuiz: definition.questionCount > 0,
    attempted: false,
    deliveryMode: 'folder_sync',
    sessionId: String(sessionRow.id),
    month: String(sessionRow.month_code || ''),
    session: String(sessionRow.session_code || ''),
    totalQuestions: definition.questionCount,
    totalPoints: definition.totalPoints,
    questions: definition.questions.map(mapFolderQuizQuestionForPlayer),
    sync: {
      driveFolderId: String(quizSessionConfig.drive_folder_id || ''),
      appsScriptUrl: String(QUIZ_APP_SCRIPT_URL || ''),
      imageAssets: definition.questions.map((question) => ({
        index: question.index,
        fileName: String(question.fileName || ''),
        imageUrl: String(question.imageUrl || ''),
        imageDownloadUrl: createGoogleDriveDownloadUrl(question.fileId),
      })),
      encryptedMetadataB64: encryptedPackage.encryptedPackageB64,
      encryptedMetadataKeyB64: encryptedPackage.encryptedPackageKeyB64,
      plainMetadataKeyB64: allowPlainMetadataKey
        ? String(encryptedPackage.plainPackageKeyB64 || '')
        : '',
      metadataNonceB64: encryptedPackage.packageNonceB64,
    },
  };
}

function createGoogleDriveDownloadUrl(fileId) {
  const normalizedFileId = String(fileId || '').trim();
  if (!normalizedFileId) return '';

  if (GOOGLE_DRIVE_URL_STYLE === 'uc') {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(normalizedFileId)}`;
  }

  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(normalizedFileId)}&export=download&confirm=t`;
}

function normalizeGoogleDriveValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    return createGoogleDriveDownloadUrl(value);
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!host.includes('drive.google.com') && !host.includes('googleusercontent.com')) {
      return value;
    }

    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/i);
    const fileId = fileMatch?.[1] || url.searchParams.get('id');
    if (!fileId) {
      return value;
    }

    return createGoogleDriveDownloadUrl(fileId);
  } catch {
    return value;
  }
}

function extractGoogleDriveId(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const folderMatch = url.pathname.match(/\/folders\/([^/]+)/i);
    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/i);
    return folderMatch?.[1] || fileMatch?.[1] || url.searchParams.get('id') || '';
  } catch {
    return '';
  }
}

function escapeGoogleDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function hasGoogleDriveDynamicLookupConfig() {
  return Boolean(extractGoogleDriveId(GOOGLE_DRIVE_ROOT_FOLDER) && (GOOGLE_DRIVE_API_KEY || GOOGLE_DRIVE_ACCESS_TOKEN));
}

function googleDriveApiGetJson(pathname, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, 'https://www.googleapis.com');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    if (GOOGLE_DRIVE_API_KEY) {
      url.searchParams.set('key', GOOGLE_DRIVE_API_KEY);
    }

    const headers = {};
    if (GOOGLE_DRIVE_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${GOOGLE_DRIVE_ACCESS_TOKEN}`;
    }

    const req = https.get(url, { headers }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = {};
        }

        if (response.statusCode >= 400) {
          const message = parsed?.error?.message || `Google Drive API request failed with status ${response.statusCode}`;
          reject(new Error(message));
          return;
        }

        resolve(parsed);
      });
    });

    req.on('error', reject);
  });
}

function googleDriveApiRequest(method, pathname, {
  params = {},
  headers = {},
  body = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, 'https://www.googleapis.com');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    if (GOOGLE_DRIVE_API_KEY) {
      url.searchParams.set('key', GOOGLE_DRIVE_API_KEY);
    }

    const requestHeaders = { ...headers };
    if (GOOGLE_DRIVE_ACCESS_TOKEN) {
      requestHeaders.Authorization = `Bearer ${GOOGLE_DRIVE_ACCESS_TOKEN}`;
    }
    if (body && !requestHeaders['Content-Length'] && !requestHeaders['content-length']) {
      requestHeaders['Content-Length'] = String(body.length);
    }

    const req = https.request(url, { method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const rawText = rawBuffer.toString('utf8');
        let parsed = null;
        try {
          parsed = rawText ? JSON.parse(rawText) : null;
        } catch {
          parsed = null;
        }

        if (response.statusCode >= 400) {
          const message = parsed?.error?.message
            || rawText.trim()
            || `Google Drive API request failed with status ${response.statusCode}`;
          reject(new Error(message));
          return;
        }

        resolve({
          statusCode: response.statusCode,
          bodyText: rawText,
          bodyJson: parsed,
          headers: response.headers,
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function googleDriveFindChild(parentId, childName, { folderOnly = false } = {}) {
  const cacheKey = `${parentId}|${folderOnly ? 'folder' : 'item'}|${childName}`;
  if (googleDriveChildrenCache.has(cacheKey)) {
    return googleDriveChildrenCache.get(cacheKey);
  }

  const filters = [
    `'${escapeGoogleDriveQueryValue(parentId)}' in parents`,
    `name = '${escapeGoogleDriveQueryValue(childName)}'`,
    'trashed = false',
  ];

  if (folderOnly) {
    filters.push("mimeType = 'application/vnd.google-apps.folder'");
  }

  const result = await googleDriveApiGetJson('/drive/v3/files', {
    q: filters.join(' and '),
    fields: 'files(id,name,mimeType)',
    pageSize: 10,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  const files = Array.isArray(result?.files) ? result.files : [];
  const match = files.find((file) => !folderOnly || file?.mimeType === 'application/vnd.google-apps.folder') || null;
  googleDriveChildrenCache.set(cacheKey, match);
  return match;
}

async function googleDriveListFolderFiles(parentId) {
  const result = await googleDriveApiGetJson('/drive/v3/files', {
    q: [
      `'${escapeGoogleDriveQueryValue(parentId)}' in parents`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id,name,mimeType)',
    pageSize: 200,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  return Array.isArray(result?.files) ? result.files : [];
}

async function googleDriveDeleteFile(fileId) {
  await googleDriveApiRequest('DELETE', `/drive/v3/files/${encodeURIComponent(String(fileId || '').trim())}`, {
    params: {
      supportsAllDrives: true,
    },
  });
}

async function googleDriveUploadFile({
  folderId,
  fileName,
  mimeType,
  bytes,
}) {
  if (!GOOGLE_DRIVE_ACCESS_TOKEN) {
    throw new Error('GOOGLE_DRIVE_ACCESS_TOKEN is required to upload quiz images to Drive');
  }

  const boundary = `educational-platform-${crypto.randomBytes(12).toString('hex')}`;
  const metadataPart = Buffer.from(
    JSON.stringify({
      name: fileName,
      parents: [folderId],
    }),
    'utf8',
  );
  const prefix = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    'utf8',
  );
  const middle = Buffer.from(
    `\r\n--${boundary}\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([prefix, metadataPart, middle, bytes, suffix]);

  const response = await googleDriveApiRequest('POST', '/upload/drive/v3/files', {
    params: {
      uploadType: 'multipart',
      supportsAllDrives: true,
      fields: 'id,name,mimeType',
    },
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  return response.bodyJson || {};
}

async function resolveGoogleDriveUrlFromFolder(relativePath) {
  if (!hasGoogleDriveDynamicLookupConfig()) {
    return '';
  }

  const normalizedRelativePath = normalizeRelativeStoragePath(relativePath);
  if (!normalizedRelativePath) return '';

  if (googleDrivePathUrlCache.has(normalizedRelativePath)) {
    return googleDrivePathUrlCache.get(normalizedRelativePath);
  }

  const rootFolderId = extractGoogleDriveId(GOOGLE_DRIVE_ROOT_FOLDER);
  const parts = normalizedRelativePath.split('/').filter(Boolean);
  const candidatePartLists = [parts];
  if (parts[0]?.toLowerCase() === 'encrypted') {
    candidatePartLists.push(parts.slice(1));
  }

  for (const candidateParts of candidatePartLists) {
    if (candidateParts.length === 0) continue;

    let currentParentId = rootFolderId;
    let failed = false;

    for (let i = 0; i < candidateParts.length - 1; i += 1) {
      const folder = await googleDriveFindChild(currentParentId, candidateParts[i], { folderOnly: true });
      if (!folder?.id) {
        failed = true;
        break;
      }
      currentParentId = folder.id;
    }

    if (failed) {
      continue;
    }

    const file = await googleDriveFindChild(currentParentId, candidateParts[candidateParts.length - 1]);
    if (file?.id) {
      const url = createGoogleDriveDownloadUrl(file.id);
      googleDrivePathUrlCache.set(normalizedRelativePath, url);
      return url;
    }
  }

  googleDrivePathUrlCache.set(normalizedRelativePath, '');
  return '';
}

function loadGoogleDriveIndex() {
  try {
    const stats = fs.statSync(GOOGLE_DRIVE_INDEX_PATH);
    if (googleDriveIndexCache.mtimeMs === stats.mtimeMs) {
      return googleDriveIndexCache.value;
    }

    const raw = fs.readFileSync(GOOGLE_DRIVE_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const value = parsed && typeof parsed === 'object' ? parsed : {};

    googleDriveIndexCache = {
      mtimeMs: stats.mtimeMs,
      value,
    };

    return value;
  } catch {
    googleDriveIndexCache = {
      mtimeMs: -1,
      value: {},
    };
    return {};
  }
}

async function syncLegacyCatalogVideosToSessions(client, catalog) {
  for (const video of catalog?.videos || []) {
    const normalized = normalizeEncryptedVideoCatalogRecord(video);
    if (normalized.error) {
      continue;
    }

    const record = normalized.record;
    const videoMetadata = {
      id: record.id,
      encryption: record.encryption,
      storage: {
        mode: String(record?.storage?.mode || 'paged').trim().toLowerCase() || 'paged',
        totalPlainSize: Number(record?.storage?.totalPlainSize) || null,
        pageSize: Number(record?.storage?.pageSize) || null,
        pageCount: Number(record?.storage?.pageCount) || null,
      },
      createdAt: String(record.createdAt || '').trim() || new Date().toISOString(),
    };

    await client.query(
      `INSERT INTO sessions (month_code, session_code, title, video_metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (month_code, session_code)
       DO UPDATE SET title = COALESCE(NULLIF(EXCLUDED.title, ''), sessions.title),
                     video_metadata = COALESCE(sessions.video_metadata, EXCLUDED.video_metadata)`,
      [
        record.month,
        record.session,
        record.title,
        JSON.stringify(videoMetadata),
      ],
    );
  }
}

function saveGoogleDriveIndex(index) {
  fs.mkdirSync(path.dirname(GOOGLE_DRIVE_INDEX_PATH), { recursive: true });
  fs.writeFileSync(
    GOOGLE_DRIVE_INDEX_PATH,
    `${JSON.stringify(index && typeof index === 'object' ? index : {}, null, 2)}\n`,
    'utf8',
  );

  googleDriveIndexCache = {
    mtimeMs: -1,
    value: index && typeof index === 'object' ? index : {},
  };
  googleDrivePathUrlCache.clear();
}

function normalizeRelativeStoragePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function resolveGoogleDriveIndexEntry(index, relativePath) {
  const normalizedRelativePath = normalizeRelativeStoragePath(relativePath);
  const withoutEncryptedPrefix = normalizedRelativePath.replace(/^encrypted\//i, '');

  const candidateKeys = [
    normalizedRelativePath,
    withoutEncryptedPrefix,
    `/${normalizedRelativePath}`,
    `/${withoutEncryptedPrefix}`,
  ];

  for (const key of candidateKeys) {
    if (key && Object.prototype.hasOwnProperty.call(index, key)) {
      return index[key];
    }
  }

  return null;
}

function hasPublishedGoogleDriveTarget(storageEntry) {
  const directCandidates = [
    storageEntry?.googleDriveUrl,
    storageEntry?.driveUrl,
    storageEntry?.downloadUrl,
    storageEntry?.publicUrl,
    storageEntry?.googleDriveFileId,
    storageEntry?.driveFileId,
    storageEntry?.fileId,
  ];

  return directCandidates.some((candidate) => Boolean(normalizeGoogleDriveValue(candidate)));
}

function isStorageEntryPublished(index, storageEntry) {
  if (!storageEntry || typeof storageEntry !== 'object') {
    return false;
  }

  if (hasPublishedGoogleDriveTarget(storageEntry)) {
    return true;
  }

  const relativePath = normalizeRelativeStoragePath(storageEntry.relativePath);
  if (!relativePath) {
    return false;
  }

  return Boolean(resolveGoogleDriveIndexEntry(index, relativePath));
}

function isCatalogVideoPublished(index, video) {
  const storage = video?.storage || {};
  if (isStorageEntryPublished(index, storage)) {
    return true;
  }

  const chunks = Array.isArray(storage?.chunks) ? storage.chunks : [];
  return chunks.some((chunk) => isStorageEntryPublished(index, chunk));
}

async function resolveGoogleDriveUrl(relativePath, storageEntry) {
  const directCandidates = [
    storageEntry?.googleDriveUrl,
    storageEntry?.driveUrl,
    storageEntry?.downloadUrl,
    storageEntry?.publicUrl,
    storageEntry?.googleDriveFileId,
    storageEntry?.driveFileId,
    storageEntry?.fileId,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeGoogleDriveValue(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const index = loadGoogleDriveIndex();
  const mappedEntry = resolveGoogleDriveIndexEntry(index, relativePath);
  if (typeof mappedEntry === 'string') {
    const normalized = normalizeGoogleDriveValue(mappedEntry);
    if (normalized) {
      return normalized;
    }
  }

  if (mappedEntry && typeof mappedEntry === 'object') {
    const mappedCandidates = [
      mappedEntry.googleDriveUrl,
      mappedEntry.driveUrl,
      mappedEntry.downloadUrl,
      mappedEntry.publicUrl,
      mappedEntry.googleDriveFileId,
      mappedEntry.driveFileId,
      mappedEntry.fileId,
    ];

    for (const candidate of mappedCandidates) {
      const normalized = normalizeGoogleDriveValue(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }

  return resolveGoogleDriveUrlFromFolder(relativePath);
}

function findCatalogStorageMatch(catalogVideos, relativePath) {
  const normalizedRelativePath = normalizeRelativeStoragePath(relativePath);

  for (const video of catalogVideos) {
    const storage = video?.storage || {};
    const singleRelativePath = normalizeRelativeStoragePath(storage.relativePath);
    if (singleRelativePath && singleRelativePath === normalizedRelativePath) {
      return { video, storageEntry: storage };
    }

    const chunks = Array.isArray(storage.chunks) ? storage.chunks : [];
    for (const chunk of chunks) {
      const chunkRelativePath = normalizeRelativeStoragePath(chunk?.relativePath);
      if (chunkRelativePath && chunkRelativePath === normalizedRelativePath) {
        return { video, storageEntry: chunk };
      }
    }
  }

  return null;
}

function sanitizeStorageName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
  return normalized || 'video';
}

function normalizeEncryptedCatalogRelativePath(value) {
  const normalized = normalizeRelativeStoragePath(value);
  if (!normalized) return '';

  if (/^encrypted\//i.test(normalized)) {
    return normalized;
  }

  const parts = normalized.split('/').filter(Boolean);
  const encryptedIndex = parts.findIndex((part) => part.toLowerCase() === 'encrypted');
  if (encryptedIndex >= 0) {
    return parts.slice(encryptedIndex).join('/');
  }

  return normalized;
}

function inferMonthAndSessionFromRelativePath(relativePath) {
  const match = normalizeEncryptedCatalogRelativePath(relativePath)
    .match(/^encrypted\/(M(1[0-2]|[1-9]))\/(S\d+)\//i);
  if (!match) {
    return { month: '', session: '' };
  }

  return {
    month: normalizeMonthCode(match[1]),
    session: normalizeSessionCode(match[3]),
  };
}

function normalizeEncryptedVideoCatalogRecord(value) {
  const raw = value && typeof value === 'object' ? value : null;
  if (!raw) {
    return { error: 'video record is required' };
  }

  const relativePath = normalizeEncryptedCatalogRelativePath(raw?.storage?.relativePath);
  const inferred = inferMonthAndSessionFromRelativePath(relativePath);
  const month = normalizeMonthCode(raw.month) || inferred.month;
  const session = normalizeSessionCode(raw.session) || inferred.session;
  const title = normalizeName(raw.title);
  const id = String(raw.id || '').trim() || crypto.randomUUID();
  const sourceFile = String(raw.sourceFile || '').trim();
  const storageMode = String(raw?.storage?.mode || 'paged').trim().toLowerCase() || 'paged';

  if (!title) {
    return { error: 'Encrypted video title is required' };
  }
  if (!month) {
    return { error: 'Encrypted video month must be in the form M1..M12' };
  }
  if (!session) {
    return { error: 'Encrypted video session must be in the form S1, S2, ...' };
  }
  if (!relativePath || !/^encrypted\//i.test(relativePath)) {
    return { error: 'Encrypted video relativePath must point to encrypted/... on the server' };
  }

  const wrappedKeyB64 = String(raw?.encryption?.keyWrap?.wrappedKeyB64 || '').trim();
  const wrapNonceB64 = String(raw?.encryption?.keyWrap?.nonceB64 || '').trim();
  if (!wrappedKeyB64 || !wrapNonceB64) {
    return { error: 'Encrypted video key-wrap metadata is missing' };
  }

  const rawDurationSec = raw?.durationSec;
  const rawTotalPlainSize = raw?.storage?.totalPlainSize;
  const rawPageSize = raw?.storage?.pageSize;
  const rawPageCount = raw?.storage?.pageCount;
  const durationSec = rawDurationSec === null || rawDurationSec === undefined || rawDurationSec === ''
    ? NaN
    : Number(rawDurationSec);
  const totalPlainSize = rawTotalPlainSize === null || rawTotalPlainSize === undefined || rawTotalPlainSize === ''
    ? NaN
    : Number(rawTotalPlainSize);
  const pageSize = rawPageSize === null || rawPageSize === undefined || rawPageSize === ''
    ? NaN
    : Number(rawPageSize);
  const pageCount = rawPageCount === null || rawPageCount === undefined || rawPageCount === ''
    ? NaN
    : Number(rawPageCount);
  const createdAtRaw = String(raw.createdAt || '').trim();
  const createdAtDate = createdAtRaw ? new Date(createdAtRaw) : new Date();

  return {
    record: {
      id,
      title,
      month,
      session,
      sourceFile,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      encryption: {
        algorithm: String(raw?.encryption?.algorithm || 'AES-256-GCM').trim() || 'AES-256-GCM',
        nonceB64: String(raw?.encryption?.nonceB64 || '').trim(),
        keyWrap: {
          algorithm: String(raw?.encryption?.keyWrap?.algorithm || 'AES-256-GCM').trim() || 'AES-256-GCM',
          nonceB64: wrapNonceB64,
          wrappedKeyB64,
        },
      },
      storage: {
        mode: storageMode,
        relativePath,
        totalPlainSize: Number.isFinite(totalPlainSize) ? totalPlainSize : null,
        pageSize: Number.isFinite(pageSize) ? pageSize : null,
        pageCount: Number.isFinite(pageCount) ? pageCount : null,
      },
      createdAt: Number.isNaN(createdAtDate.getTime())
        ? new Date().toISOString()
        : createdAtDate.toISOString(),
    },
  };
}

async function getStudentFromToken(client, reqUser) {
  if (String(reqUser?.role || '').trim().toLowerCase() === 'admin') {
    return { error: 'Invalid student session', status: 403 };
  }

  const serial = normalizeSerial(reqUser.serial);
  const deviceId = String(reqUser.deviceId || '').trim();

  if (!serial || !deviceId) {
    return { error: 'Invalid session payload' };
  }

  const student = await getStudentBySerial(client, serial);
  if (!student || student.active === false) {
    return { error: 'Invalid student session', status: 401 };
  }

  const boundDeviceId = String(student.device_id || '').trim();
  if (!boundDeviceId || boundDeviceId !== deviceId) {
    return { error: 'Session/device mismatch', status: 403 };
  }

  return {
    student,
    allowedMonths: normalizeAllowedMonths(student.allowed_months),
  };
}

async function getAdminFromToken(client, reqUser) {
  const role = String(reqUser?.role || '').trim().toLowerCase();
  const serial = normalizeSerial(reqUser?.serial);
  const deviceId = String(reqUser?.deviceId || '').trim();
  if (role !== 'admin' || !serial || !deviceId) {
    return { error: 'Invalid admin session', status: 403 };
  }

  const admin = await getAdminBySerial(client, serial);
  if (!admin || admin.active === false) {
    return { error: 'Invalid admin session', status: 401 };
  }

  const boundDeviceId = String(admin.device_id || '').trim();
  if (!boundDeviceId || boundDeviceId !== deviceId) {
    return { error: 'Session/device mismatch', status: 403 };
  }

  return {
    admin,
  };
}

async function getContentAccessFromToken(client, reqUser) {
  const role = String(reqUser?.role || '').trim().toLowerCase();
  if (role === 'admin') {
    const adminState = await getAdminFromToken(client, reqUser);
    if (adminState.error) {
      return adminState;
    }

    return {
      role: 'admin',
      admin: adminState.admin,
      student: {
        id: null,
        public_key_pem: String(adminState.admin.public_key_pem || '').trim(),
      },
      allowedMonths: MONTHS,
      readOnly: true,
    };
  }

  const studentState = await getStudentFromToken(client, reqUser);
  if (studentState.error) {
    return studentState;
  }

  return {
    ...studentState,
    role: 'student',
    readOnly: false,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    const db = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: true, db: db.rows[0]?.ok === 1 });
  } catch {
    return res.status(500).json({ ok: false, db: false });
  }
});

app.post('/auth/signup', async (req, res) => {
  const serial = normalizeSerial(req.body.serial);
  const fullName = normalizeName(req.body.name);
  const gender = normalizeGender(req.body.gender);
  const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
  const parentPhoneNumber = normalizePhoneNumber(req.body.parentPhoneNumber);
  const email = normalizeGmailAddress(req.body.email);

  if (!fullName) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!serial) {
    return res.status(400).json({ error: 'serial is required' });
  }
  if (!gender) {
    return res.status(400).json({ error: 'gender must be either male or female' });
  }
  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber must match 01[0|1|2|5]XXXXXXXX' });
  }
  if (!parentPhoneNumber) {
    return res.status(400).json({ error: 'parentPhoneNumber must match 01[0|1|2|5]XXXXXXXX' });
  }
  if (!email) {
    return res.status(400).json({ error: 'email must be a valid gmail address' });
  }

  const client = await pool.connect();
  try {
    const existing = await getStudentBySerial(client, serial);
    if (!existing) {
      return res.status(404).json({ error: 'Serial number not found' });
    }
    if (existing?.active === false) {
      return res.status(403).json({ error: 'This serial is inactive' });
    }

    await client.query(
      `UPDATE "${studentTable}"
       SET full_name = $1,
           gender = $2,
           phone_number = $3,
           parent_phone_number = $4,
           email = $5,
           updated_at = NOW()
       WHERE UPPER(serial_no) = UPPER($6)`,
      [
        fullName,
        gender,
        phoneNumber,
        parentPhoneNumber,
        email,
        serial,
      ],
    );

    return res.status(201).json({
      message: 'Sign up successful',
      student: {
        serial,
        fullName,
        gender,
        phoneNumber,
        parentPhoneNumber,
        email,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Sign-up query failed: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/auth/login', async (req, res) => {
  const serial = normalizeSerial(req.body.serial);
  const role = String(req.body.role || 'student').trim().toLowerCase();
  const deviceId = String(req.body.deviceId || '').trim();
  const publicKeyPem = String(req.body.publicKeyPem || '').trim();

  if (!serial) {
    return res.status(400).json({ error: 'serial is required' });
  }

  if (role !== 'student' && role !== 'admin') {
    return res.status(400).json({ error: 'role must be either student or admin' });
  }

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required for sign-in' });
  }

  const client = await pool.connect();
  try {
    if (role === 'admin') {
      const admin = await getAdminBySerial(client, serial);
      if (!admin) {
        return res.status(401).json({ error: 'Admin serial number not found' });
      }
      if (admin.active === false) {
        return res.status(403).json({ error: 'Admin serial is inactive' });
      }

      const existingDeviceId = String(admin.device_id || '').trim();
      if (!existingDeviceId) {
        await client.query(
          `UPDATE "${adminTable}"
           SET device_id = $1,
               updated_at = NOW()
           WHERE UPPER(serial_no) = UPPER($2)`,
          [deviceId, serial],
        );
      } else if (existingDeviceId !== deviceId) {
        return res.status(403).json({
          error: 'This admin serial is already bound to another device',
        });
      }

      if (publicKeyPem) {
        try {
          await client.query(
            `UPDATE "${adminTable}"
             SET public_key_pem = $1,
                 updated_at = NOW()
             WHERE UPPER(serial_no) = UPPER($2)`,
            [publicKeyPem, serial],
          );
        } catch (error) {
          if (error?.code !== '42703') throw error;
        }
      }

      const token = jwt.sign({ role: 'admin', serial, deviceId }, JWT_SECRET, {
        expiresIn: '30d',
      });

      return res.json({
        token,
        role: 'admin',
        user: {
          serial,
          role: 'admin',
          deviceId,
          displayName: 'Admin',
        },
      });
    }

    const student = await getStudentBySerial(client, serial);
    if (!student) {
      return res.status(401).json({ error: 'Serial number not found' });
    }

    if (student.active === false) {
      return res.status(403).json({ error: 'Serial is inactive' });
    }

    const existingDeviceId = String(student.device_id || '').trim();
    if (!existingDeviceId) {
      await client.query(
        `UPDATE "${studentTable}"
         SET device_id = $1
         WHERE UPPER(serial_no) = UPPER($2)`,
        [deviceId, serial],
      );
    } else if (existingDeviceId !== deviceId) {
      return res.status(403).json({
        error: 'This serial is already bound to another device',
      });
    }

    if (publicKeyPem) {
      await client.query(
        `UPDATE "${studentTable}"
         SET public_key_pem = $1
         WHERE UPPER(serial_no) = UPPER($2)`,
        [publicKeyPem, serial],
      );
    }

    const allowedMonths = normalizeAllowedMonths(student.allowed_months);
    const token = jwt.sign({ role: 'student', serial, deviceId }, JWT_SECRET, { expiresIn: '30d' });

    return res.json({
      token,
      role: 'student',
      user: {
        serial,
        role: 'student',
        deviceId,
        availableMonths: allowedMonths,
        displayName: String(student.full_name || '').trim(),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Login query failed: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/student/profile', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status).json({ error: authState.error });
    }

    return res.json(mapStudentProfile(authState.student));
  } catch (error) {
    return res.status(500).json({ error: `Failed to load student profile: ${error.message}` });
  } finally {
    client.release();
  }
});

app.put('/student/profile', authMiddleware, async (req, res) => {
  const fullName = normalizeName(req.body.fullName);
  const gender = normalizeGender(req.body.gender);
  const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
  const parentPhoneNumber = normalizePhoneNumber(req.body.parentPhoneNumber);
  const email = normalizeGmailAddress(req.body.email);

  if (!fullName) {
    return res.status(400).json({ error: 'fullName is required' });
  }
  if (!gender) {
    return res.status(400).json({ error: 'gender must be either male or female' });
  }
  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber must match 01[0|1|2|5]XXXXXXXX' });
  }
  if (!parentPhoneNumber) {
    return res.status(400).json({ error: 'parentPhoneNumber must match 01[0|1|2|5]XXXXXXXX' });
  }
  if (!email) {
    return res.status(400).json({ error: 'email must be a valid gmail address' });
  }

  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status).json({ error: authState.error });
    }

    await client.query(
      `UPDATE "${studentTable}"
       SET full_name = $1,
           gender = $2,
           phone_number = $3,
           parent_phone_number = $4,
           email = $5,
           updated_at = NOW()
       WHERE id = $6`,
      [
        fullName,
        gender,
        phoneNumber,
        parentPhoneNumber,
        email,
        authState.student.id,
      ],
    );

    const refreshed = await getStudentBySerial(client, authState.student.serial_no);
    return res.json({
      message: 'Profile updated successfully',
      profile: mapStudentProfile(refreshed || authState.student),
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to update student profile: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/admin/serials', authMiddleware, async (req, res) => {
  const query = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const hasQuery = query.length > 0;
    const params = hasQuery
      ? [`%${query}%`, limit]
      : [limit];
    const result = await client.query(
      hasQuery
        ? `SELECT serial_no, full_name, email, phone_number, active, created_at
           FROM "${studentTable}"
           WHERE UPPER(serial_no) LIKE UPPER($1)
              OR UPPER(COALESCE(full_name, '')) LIKE UPPER($1)
              OR UPPER(COALESCE(email, '')) LIKE UPPER($1)
              OR COALESCE(phone_number, '') LIKE $1
           ORDER BY created_at DESC, serial_no ASC
           LIMIT $2`
        : `SELECT serial_no, full_name, email, phone_number, active, created_at
           FROM "${studentTable}"
           ORDER BY created_at DESC, serial_no ASC
           LIMIT $1`,
      params,
    );

    return res.json({
      serials: result.rows.map(mapAdminSerialRow),
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to load serials: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/serials', authMiddleware, async (req, res) => {
  const rawSerials = Array.isArray(req.body.serials) ? req.body.serials : [];
  const serials = rawSerials
    .map((serial) => normalizeManagedSerial(serial))
    .filter(Boolean);

  if (serials.length === 0) {
    return res.status(400).json({ error: 'At least one valid serial is required' });
  }

  const uniqueSerials = Array.from(new Set(serials));
  if (uniqueSerials.length !== serials.length) {
    return res.status(400).json({ error: 'Duplicate serials were provided in the same request' });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const inserted = [];
    const duplicates = [];

    for (const serial of uniqueSerials) {
      const result = await client.query(
        `INSERT INTO "${studentTable}" (serial_no, active, allowed_months)
         VALUES ($1, TRUE, '')
         ON CONFLICT (serial_no) DO NOTHING
         RETURNING serial_no, full_name, email, phone_number, active, created_at`,
        [serial],
      );

      if (result.rowCount > 0) {
        inserted.push(mapAdminSerialRow(result.rows[0]));
      } else {
        duplicates.push(serial);
      }
    }

    return res.status(inserted.length > 0 ? 201 : 200).json({
      inserted,
      duplicates,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to create serials: ${error.message}` });
  } finally {
    client.release();
  }
});

app.patch('/admin/serials/status', authMiddleware, async (req, res) => {
  const rawSerials = Array.isArray(req.body.serials) ? req.body.serials : [];
  const serials = Array.from(new Set(
    rawSerials.map((serial) => normalizeManagedSerial(serial)).filter(Boolean),
  ));
  const active = req.body.active === true;

  if (serials.length === 0) {
    return res.status(400).json({ error: 'At least one valid serial is required' });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const result = await client.query(
      `UPDATE "${studentTable}"
       SET active = $1,
           updated_at = NOW()
       WHERE UPPER(serial_no) = ANY($2::text[])
       RETURNING serial_no, full_name, email, phone_number, active, created_at`,
      [active, serials.map((serial) => serial.toUpperCase())],
    );

    return res.json({
      updated: result.rows.map(mapAdminSerialRow),
      requestedCount: serials.length,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to update serial status: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/videos', authMiddleware, async (req, res) => {
  const normalized = normalizePendingEncryptedVideoRecord(req.body?.video);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const videoRecord = normalized.record;
    await client.query(
      `INSERT INTO sessions (month_code, session_code, title, video_metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (month_code, session_code)
       DO UPDATE SET title = EXCLUDED.title,
                     video_metadata = EXCLUDED.video_metadata`,
      [
        videoRecord.month,
        videoRecord.session,
        videoRecord.title,
        JSON.stringify(videoRecord.videoMetadata),
      ],
    );

    return res.status(201).json({
      message: 'Encrypted video session saved successfully',
      video: {
        id: videoRecord.id,
        title: videoRecord.title,
        month: videoRecord.month,
        session: videoRecord.session,
        googleDriveUrl: videoRecord.googleDriveUrl,
        catalogUpdated: true,
        catalogMessage: 'Session table updated successfully',
        googleDriveIndexUpdated: false,
        googleDriveIndexMessage: '',
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to add video record: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/pdfs', authMiddleware, async (req, res) => {
  const normalized = normalizePendingPdfRecord(req.body?.pdf);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const pdfRecord = normalized.record;

    await client.query(
      `INSERT INTO sessions (month_code, session_code, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (month_code, session_code) DO NOTHING`,
      [pdfRecord.month, pdfRecord.session, `${pdfRecord.month} ${pdfRecord.session}`],
    );

    await client.query(
      `INSERT INTO pdf_sessions (id, month_code, session_code, title, google_drive_url, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, NOW())
       ON CONFLICT (id)
       DO UPDATE SET month_code = EXCLUDED.month_code,
                     session_code = EXCLUDED.session_code,
                     title = EXCLUDED.title,
                     google_drive_url = EXCLUDED.google_drive_url,
                     updated_at = NOW()`,
      [
        pdfRecord.id,
        pdfRecord.month,
        pdfRecord.session,
        pdfRecord.title,
        pdfRecord.googleDriveUrl,
        pdfRecord.createdAt,
      ],
    );

    return res.status(201).json({
      message: 'PDF session saved successfully',
      pdf: pdfRecord,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to add PDF record: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/quizzes/image', authMiddleware, async (req, res) => {
  const driveFolderUrl = String(req.body?.driveFolderUrl || req.body?.drive_folder_url || '').trim();
  const driveFolderId = extractGoogleDriveId(driveFolderUrl || req.body?.driveFolderId || req.body?.drive_folder_id);
  const questionNumber = Number(req.body?.questionNumber);
  const imageBase64 = String(req.body?.imageBase64 || '').trim();
  const originalFileName = String(req.body?.originalFileName || '').trim();

  if (!driveFolderId) {
    return res.status(400).json({ error: 'A valid Google Drive folder URL is required' });
  }
  if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
    return res.status(400).json({ error: 'questionNumber must be a positive integer' });
  }
  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 is required' });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    let bytes;
    try {
      bytes = Buffer.from(imageBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'imageBase64 is not valid base64 data' });
    }
    if (!bytes.length) {
      return res.status(400).json({ error: 'imageBase64 decoded to an empty file' });
    }

    const uploadResponse = await uploadQuizQuestionImageViaAppsScript({
      driveFolderUrl,
      driveFolderId,
      questionNumber,
      originalFileName,
      imageBase64,
    });
    const uploadedFile = uploadResponse?.file || {};

    return res.status(201).json({
      message: String(uploadResponse?.message || 'Quiz question image uploaded successfully'),
      file: {
        id: String(uploadedFile?.id || ''),
        fileName: String(uploadedFile?.fileName || uploadedFile?.name || ''),
        questionNumber,
        imageUrl: String(uploadedFile?.imageUrl || createGoogleDriveViewUrl(String(uploadedFile?.id || ''))),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to upload quiz image: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/quizzes', authMiddleware, async (req, res) => {
  const normalized = normalizeAdminQuizPayload(req.body?.quiz);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const quizRecord = normalized.record;
    const uploadedQuestionFiles = (await fetchQuizFolderFiles({ drive_folder_id: quizRecord.driveFolderId }))
      .filter((file) => Number.isFinite(Number.parseInt(String(file?.name || ''), 10)));
    if (uploadedQuestionFiles.length !== quizRecord.questionCount) {
      return res.status(400).json({
        error: `The Google Drive folder currently contains ${uploadedQuestionFiles.length} quiz image file(s), but questionCount is ${quizRecord.questionCount}. Upload every question image before finishing.`,
      });
    }

    const sessionInsert = await client.query(
      `INSERT INTO sessions (month_code, session_code, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (month_code, session_code)
       DO UPDATE SET title = COALESCE(sessions.title, EXCLUDED.title)
       RETURNING id, month_code, session_code`,
      [quizRecord.month, quizRecord.session, `${quizRecord.month} ${quizRecord.session}`],
    );

    let sessionRow = sessionInsert.rows[0] || null;
    if (!sessionRow) {
      const existing = await client.query(
        `SELECT id, month_code, session_code
         FROM sessions
         WHERE month_code = $1 AND session_code = $2
         LIMIT 1`,
        [quizRecord.month, quizRecord.session],
      );
      sessionRow = existing.rows[0] || null;
    }
    if (!sessionRow?.id) {
      throw new Error('Could not resolve or create the target session row');
    }

    await client.query(
      `INSERT INTO quiz_sessions (session_id, drive_folder_id, encrypted_metadata, question_count, updated_at)
       VALUES ($1::uuid, $2, $3, $4, NOW())
       ON CONFLICT (session_id)
       DO UPDATE SET drive_folder_id = EXCLUDED.drive_folder_id,
                     encrypted_metadata = EXCLUDED.encrypted_metadata,
                     question_count = EXCLUDED.question_count,
                     updated_at = NOW()`,
      [
        String(sessionRow.id),
        quizRecord.driveFolderId,
        JSON.stringify(quizRecord.metadata),
        quizRecord.questionCount,
      ],
    );

    return res.status(201).json({
      message: 'Quiz session saved successfully',
      quiz: {
        sessionId: String(sessionRow.id),
        month: quizRecord.month,
        session: quizRecord.session,
        driveFolderId: quizRecord.driveFolderId,
        questionCount: quizRecord.questionCount,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to add quiz session: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/google-drive-index', authMiddleware, async (req, res) => {
  const relativePath = normalizeRelativeStoragePath(req.body.relativePath);
  const rawGoogleDriveUrl = String(req.body.googleDriveUrl || '').trim();

  if (!relativePath) {
    return res.status(400).json({ error: 'relativePath is required' });
  }
  if (!rawGoogleDriveUrl) {
    return res.status(400).json({ error: 'googleDriveUrl is required' });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const index = loadGoogleDriveIndex();
    index[relativePath] = rawGoogleDriveUrl;
    saveGoogleDriveIndex(index);

    return res.status(200).json({
      message: 'Remote Google Drive index updated successfully',
      entry: {
        relativePath,
        googleDriveUrl: rawGoogleDriveUrl,
        googleDriveIndexUpdated: true,
        googleDriveIndexMessage: 'Remote Google Drive index updated successfully',
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to update Google Drive index: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/admin/encrypted-videos/catalog', authMiddleware, async (req, res) => {
  const normalized = normalizeEncryptedVideoCatalogRecord(req.body?.video);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  const client = await pool.connect();
  try {
    const adminState = await getAdminFromToken(client, req.user);
    if (adminState.error) {
      return res.status(adminState.status || 403).json({ error: adminState.error });
    }

    const videoRecord = normalized.record;
    await client.query(
      `INSERT INTO sessions (month_code, session_code, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (month_code, session_code)
       DO UPDATE SET title = EXCLUDED.title`,
      [videoRecord.month, videoRecord.session, videoRecord.title],
    );

    const catalog = readCatalog();
    const existingIndex = catalog.videos.findIndex((entry) => {
      const entryId = String(entry?.id || '').trim();
      const entryRelativePath = normalizeEncryptedCatalogRelativePath(
        entry?.storage?.relativePath,
      );
      return entryId === videoRecord.id || entryRelativePath === videoRecord.storage.relativePath;
    });

    if (existingIndex >= 0) {
      catalog.videos[existingIndex] = {
        ...catalog.videos[existingIndex],
        ...videoRecord,
      };
    } else {
      catalog.videos.push(videoRecord);
    }

    writeCatalog(catalog);

    return res.status(existingIndex >= 0 ? 200 : 201).json({
      message: 'Encrypted video record synced to remote catalog successfully',
      video: videoRecord,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to sync encrypted video catalog: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/videos', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const months = await buildAuthorizedMonthsPayload(client, authState.allowedMonths);
    return res.json({ generatedAt: new Date().toISOString(), months });
  } catch (error) {
    return res.status(500).json({ error: `Failed to query months: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/student/dashboard', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const dashboard = await buildStudentDashboardPayload(client, authState);
    return res.json(dashboard);
  } catch (error) {
    return res.status(500).json({ error: `Failed to load student dashboard: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/quiz/status/:sessionId', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const sessionRow = await getSessionById(client, req.params.sessionId);
    if (!sessionRow) {
      return res.status(404).json({ error: 'Quiz session not found' });
    }

    const month = normalizeMonthCode(sessionRow.month_code);
    if (!month || !authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month || 'this month'}` });
    }

    const payload = await buildQuizStatusPayload(
      client,
      authState.student.id,
      sessionRow,
      String(authState.student.public_key_pem || '').trim(),
    );
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ error: `Failed to load quiz status: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/quiz/content/:sessionId', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const sessionRow = await getSessionById(client, req.params.sessionId);
    if (!sessionRow) {
      return res.status(404).json({ error: 'Quiz session not found' });
    }

    const month = normalizeMonthCode(sessionRow.month_code);
    if (!month || !authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month || 'this month'}` });
    }

    const requestPublicKeyPem = decodePublicKeyPemHeader(req);
    const allowPlainMetadataKey = isDesktopClientRequest(req);
    const effectivePublicKeyPem = allowPlainMetadataKey
      ? requestPublicKeyPem
      : (requestPublicKeyPem || String(authState.student.public_key_pem || '').trim());

    const payload = await buildQuizContentPayload(
      client,
      sessionRow,
      effectivePublicKeyPem,
      allowPlainMetadataKey,
    );
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ error: `Failed to load quiz content: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/quiz/submit/:sessionId', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const sessionRow = await getSessionById(client, req.params.sessionId);
    if (!sessionRow) {
      return res.status(404).json({ error: 'Quiz session not found' });
    }

    const month = normalizeMonthCode(sessionRow.month_code);
    if (!month || !authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month || 'this month'}` });
    }

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    const timeTakenSeconds = Number(req.body?.timeTakenSeconds);

    if (!answers) {
      return res.status(400).json({ error: 'answers must be an array' });
    }
    if (!Number.isFinite(timeTakenSeconds) || timeTakenSeconds < 0) {
      return res.status(400).json({ error: 'timeTakenSeconds must be a non-negative number' });
    }

    const quizSessionConfig = await getQuizSessionConfig(client, sessionRow.id);
    let totalQuestions = 0;
    let normalizedAnswers = [];
    let score = 0;

    if (!quizSessionConfig) {
      return res.status(404).json({ error: 'This session does not have a quiz yet' });
    }

    const definition = buildFolderQuizMetadataDefinition(quizSessionConfig);
    totalQuestions = definition.questions.length;
    if (totalQuestions === 0) {
      return res.status(404).json({ error: 'This session does not have a quiz yet' });
    }
    if (answers.length !== totalQuestions) {
      return res.status(400).json({ error: `answers length must equal ${totalQuestions}` });
    }

    normalizedAnswers = answers.map((value, index) => {
      if (value === null) return null;
      if (!Number.isInteger(value)) {
        throw new Error(`Answer at index ${index} must be an integer or null`);
      }
      const optionIndex = Number(value);
      const optionsCount = definition.questions[index].options.length;
      if (optionIndex < 0 || optionIndex >= optionsCount) {
        throw new Error(`Answer at index ${index} is out of range`);
      }
      return optionIndex;
    });

    for (let i = 0; i < definition.questions.length; i += 1) {
      if (normalizedAnswers[i] === Number(definition.questions[i].correctOptionIndex)) {
        score += Number(definition.questions[i].points) || 0;
      }
    }

    const unanswered = normalizedAnswers.some((value) => value === null);
    if (unanswered) {
      return res.status(400).json({ error: 'You have unanswered questions. Please complete the quiz before submitting.' });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id
       FROM quiz_results
       WHERE student_id = $1 AND session_id = $2
       LIMIT 1`,
      [authState.student.id, sessionRow.id],
    );
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      const payload = await buildQuizStatusPayload(
        client,
        authState.student.id,
        sessionRow,
        String(authState.student.public_key_pem || '').trim(),
      );
      return res.status(409).json({
        error: 'Quiz already submitted for this session',
        ...payload,
      });
    }

    await client.query(
      `INSERT INTO quiz_results (
        student_id,
        session_id,
        score,
        total_questions,
        student_answers,
        time_taken_seconds
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        authState.student.id,
        sessionRow.id,
        score,
        totalQuestions,
        JSON.stringify(normalizedAnswers),
        Math.floor(timeTakenSeconds),
      ],
    );

    await client.query('COMMIT');

    const payload = await buildQuizStatusPayload(
      client,
      authState.student.id,
      sessionRow,
      String(authState.student.public_key_pem || '').trim(),
    );
    return res.status(201).json(payload);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    return res.status(500).json({ error: `Failed to submit quiz: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/videos/:videoId/activity', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const watchedSeconds = Math.floor(Number(req.body?.watchedSeconds));
    if (!Number.isFinite(watchedSeconds) || watchedSeconds < 0) {
      return res.status(400).json({ error: 'watchedSeconds must be a non-negative number' });
    }

    const monthsPayload = await buildAuthorizedMonthsPayload(client, authState.allowedMonths);
    let matchedVideo = null;
    for (const month of monthsPayload) {
      for (const video of month.videos) {
        if (String(video.id || '') === req.params.videoId) {
          matchedVideo = video;
          break;
        }
      }
      if (matchedVideo) break;
    }

    if (!matchedVideo) {
      return res.status(404).json({ error: 'Video not found for this student' });
    }

    if (watchedSeconds >= 3600) {
      try {
        await client.query(
          `INSERT INTO student_video_watches (
            student_id,
            video_id,
            month_code,
            session_code,
            watched_seconds,
            qualified_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (student_id, video_id) DO UPDATE
          SET watched_seconds = GREATEST(student_video_watches.watched_seconds, EXCLUDED.watched_seconds),
              updated_at = NOW()`,
          [
            authState.student.id,
            String(matchedVideo.id || ''),
            String(matchedVideo.month || ''),
            String(matchedVideo.session || 'S1'),
            watchedSeconds,
          ],
        );
      } catch (error) {
        if (error?.code !== '42P01') throw error;
      }
    }

    const dashboard = await buildStudentDashboardPayload(client, authState, monthsPayload);
    return res.json({
      recorded: watchedSeconds >= 3600,
      dashboard,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to record video activity: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post('/videos/:videoId/license', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const sessionRow = await findVideoSessionRowByVideoId(client, req.params.videoId);
    if (!sessionRow) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = sessionRow.normalizedVideo;
    const month = String(video.month || '').toUpperCase();
    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

    const storageMode = String(video?.storage?.mode || 'paged').toLowerCase();

    if (!MASTER_KEY_B64) {
      return res.status(500).json({ error: 'Server is missing MASTER_KEY_B64' });
    }

    const masterKey = Buffer.from(MASTER_KEY_B64, 'base64');
    if (masterKey.length !== 32) {
      return res.status(500).json({ error: 'MASTER_KEY_B64 must decode to 32 bytes' });
    }

    let dataKey;
    try {
      dataKey = aesGcmDecrypt(
        masterKey,
        video.encryption?.keyWrap?.nonceB64,
        video.encryption?.keyWrap?.wrappedKeyB64,
      );
    } catch {
      return res.status(500).json({ error: 'Failed to unwrap data key' });
    }

    const allowPlainDataKey = isDesktopClientRequest(req);
    const publicKeyPem = String(req.body.publicKeyPem || authState.student.public_key_pem || '').trim();
    if (!publicKeyPem && !allowPlainDataKey) {
      return res.status(400).json({ error: 'Missing student public key' });
    }

    let encryptedDataKey = Buffer.alloc(0);
    if (!allowPlainDataKey) {
      try {
        encryptedDataKey = crypto.publicEncrypt(
          {
            key: publicKeyPem,
            padding: crypto.constants.RSA_PKCS1_PADDING,
          },
          dataKey,
        );
      } catch {
        return res.status(400).json({ error: 'Invalid public key format' });
      }
    }

    const chunkManifest = [];
    const contentUrl = buildSessionVideoContentUrl(video.id);
    const totalPlainSize = Number(video?.storage?.totalPlainSize) || null;
    const pageSize = Number(video?.storage?.pageSize) || null;
    const pageCount = Number(video?.storage?.pageCount) || null;

    return res.json({
      videoId: String(video.id || ''),
      storageMode,
      algorithm: 'AES-256-GCM',
      videoNonceB64: storageMode === 'single' ? String(video.encryption?.nonceB64 || '') : '',
      encryptedDataKeyB64: encryptedDataKey.toString('base64'),
      plainDataKeyB64: allowPlainDataKey ? dataKey.toString('base64') : '',
      contentUrl,
      requiresAuthForContent: true,
      totalPlainSize,
      pageSize,
      pageCount,
      chunks: chunkManifest,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to issue playback license: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/videos/:videoId/content', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const sessionRow = await findVideoSessionRowByVideoId(client, req.params.videoId);
    if (!sessionRow) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = sessionRow.normalizedVideo;
    const month = String(video.month || '').toUpperCase();
    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

    const directGoogleDriveUrl = normalizeGoogleDriveValue(video.googleDriveUrl);
    if (directGoogleDriveUrl) {
      return res.redirect(302, directGoogleDriveUrl);
    }

    return res.status(404).json({
      error: `Missing google_drive_url for session video ${video.id}.`,
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to resolve encrypted content URL: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/pdfs/:pdfId/content', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const pdfRow = await findPdfSessionRowByPdfId(client, req.params.pdfId);
    if (!pdfRow) {
      return res.status(404).json({ error: 'PDF not found' });
    }

    const pdf = pdfRow.normalizedPdf;
    const month = String(pdf.month || '').toUpperCase();
    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

    return res.redirect(302, pdf.googleDriveUrl);
  } catch (error) {
    return res.status(500).json({ error: `Failed to resolve PDF URL: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get(/^\/storage\/(.+)$/, authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const requestedRelativePath = decodeURIComponent(String(req.params[0] || ''));
    const normalizedRelativePath = normalizeRelativeStoragePath(requestedRelativePath);

    const catalog = readCatalog();
    const matched = findCatalogStorageMatch(catalog.videos, normalizedRelativePath);

    if (!matched) {
      return res.status(404).json({ error: 'Video metadata not found' });
    }

    const month = String(matched.video.month || '').toUpperCase();
    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

    const driveUrl = await resolveGoogleDriveUrl(normalizedRelativePath, matched.storageEntry);
    if (!driveUrl) {
      return res.status(404).json({
        error: `Missing Google Drive mapping for ${normalizedRelativePath}. Update ${GOOGLE_DRIVE_INDEX_PATH} or configure GOOGLE_DRIVE_ROOT_FOLDER with Drive API access.`,
      });
    }

    return res.redirect(302, driveUrl);
  } catch (error) {
    return res.status(500).json({ error: `Failed to resolve encrypted content URL: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get(/^\/pdf\/(.+)$/, authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getContentAccessFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const requestedRelativePath = decodeURIComponent(String(req.params[0] || ''));
    const normalizedRelativePath = normalizeRelativeStoragePath(requestedRelativePath);

    const catalog = readCatalog();
    const matchedPdf = catalog.pdfs.find((pdf) => {
      const rel = normalizeRelativeStoragePath(String(pdf?.storage?.relativePath || ''));
      return rel === normalizedRelativePath;
    });

    if (!matchedPdf) {
      return res.status(404).json({ error: 'PDF not found in catalog' });
    }

    const month = String(matchedPdf.month || '').toUpperCase();
    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

    const driveUrl = await resolveGoogleDriveUrl(normalizedRelativePath, matchedPdf?.storage);
    if (!driveUrl) {
      return res.status(404).json({
        error: `Missing Google Drive mapping for ${normalizedRelativePath}. Update google_drive_index.json.`,
      });
    }

    return res.redirect(302, driveUrl);
  } catch (error) {
    return res.status(500).json({ error: `Failed to resolve PDF URL: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/videos/:videoId/plain', authMiddleware, async (req, res) => {
  return res.status(410).json({
    error: 'Legacy plain video records are no longer supported. Publish sessions through the catalog instead.',
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend (DB mode) listening on ${BASE_URL}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use. Backend is likely already running.`);
    console.log(`Use the existing backend instance at ${BASE_URL} or stop the old process first.`);
    process.exit(0);
  }

  throw error;
});
