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
app.use(express.json({ limit: '2mb' }));

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
const QUIZ_APP_SCRIPT_URL = String(process.env.QUIZ_APP_SCRIPT_URL || '').trim();

const STUDENT_SERIALS_TABLE = process.env.STUDENT_SERIALS_TABLE || 'student_serials';
const MATH_RECORDS_TABLE = process.env.MATH_RECORDS_TABLE || 'math_records';

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
const recordsTable = sanitizeSqlIdentifier(MATH_RECORDS_TABLE);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

const MONTHS = Array.from({ length: 12 }, (_, i) => `M${i + 1}`);

function normalizeSerial(serial) {
  return String(serial || '').trim().toUpperCase();
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

function monthColumn(month) {
  return `m${month.slice(1)}`;
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
  const result = await client.query(
    `SELECT id, serial_no, device_id, active, allowed_months, public_key_pem
     FROM "${studentTable}"
     WHERE UPPER(serial_no) = UPPER($1)
     LIMIT 1`,
    [serial],
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function getRecordsRows(client) {
  const monthColumnsSql = MONTHS.map((month) => `"${monthColumn(month)}"`).join(', ');

  try {
    const withRecordNo = await client.query(
      `SELECT record_no, ${monthColumnsSql}
       FROM "${recordsTable}"
       ORDER BY record_no ASC`,
    );
    return withRecordNo.rows.map((row, index) => ({
      ...row,
      record_no: Number(row.record_no) || index + 1,
    }));
  } catch (error) {
    if (error?.code !== '42703') throw error;

    const fallback = await client.query(
      `SELECT ROW_NUMBER() OVER ()::int AS record_no, ${monthColumnsSql}
       FROM "${recordsTable}"`,
    );
    return fallback.rows;
  }
}

function normalizeRecordUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';

  try {
    const url = new URL(value);
    if (!url.hostname.toLowerCase().includes('drive.google.com')) {
      return value;
    }

    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/i);
    const fileId = fileMatch?.[1] || url.searchParams.get('id');
    if (!fileId) {
      return value;
    }

    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  } catch {
    return value;
  }
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
    `SELECT id, month_code, session_code, title
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

async function getQuizQuestions(client, sessionId) {
  const result = await client.query(
    `SELECT id, image_url, correct_option_index, options_count, points, created_at
     FROM quiz_questions
     WHERE session_id = $1
     ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return result.rows;
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
    `SELECT session_id::text AS session_id FROM quiz_sessions
     UNION
     SELECT DISTINCT session_id::text AS session_id FROM quiz_questions`,
  );
  return new Set(result.rows.map((row) => String(row.session_id || '')));
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

function httpsGetJsonByAbsoluteUrl(rawUrl) {
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

async function fetchQuizFolderFiles(quizSessionConfig) {
  const baseUrl = String(QUIZ_APP_SCRIPT_URL || '').trim();
  const rawFolderValue = String(quizSessionConfig?.drive_folder_id || '').trim();
  const folderId = extractGoogleDriveId(rawFolderValue) || rawFolderValue;
  if (!baseUrl || !folderId) {
    throw new Error('Quiz session is missing QUIZ_APP_SCRIPT_URL or drive_folder_id');
  }

  const url = new URL(baseUrl);
  url.searchParams.set('folderId', folderId);
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

async function buildFolderQuizDefinition(quizSessionConfig) {
  const metadata = normalizeQuizMetadata(quizSessionConfig.encrypted_metadata);
  const files = await fetchQuizFolderFiles(quizSessionConfig);
  if (files.length !== metadata.length) {
    throw new Error(`Quiz folder image count (${files.length}) does not match metadata count (${metadata.length})`);
  }

  const questions = metadata.map((entry, index) => ({
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

function mapQuizQuestionForPlayer(question) {
  return {
    id: String(question.id || ''),
    imageUrl: String(question.image_url || ''),
    optionsCount: Number(question.options_count) || 0,
    points: Number(question.points) || 0,
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

function mapQuizQuestionForReview(question, studentAnswers, index) {
  const answer = Array.isArray(studentAnswers) ? studentAnswers[index] : null;
  const normalizedStudentChoice = Number.isInteger(answer) ? answer : null;
  return {
    id: String(question.id || ''),
    imageUrl: String(question.image_url || ''),
    optionsCount: Number(question.options_count) || 0,
    points: Number(question.points) || 0,
    studentChoiceIndex: normalizedStudentChoice,
    correctOptionIndex: Number(question.correct_option_index),
    isCorrect: normalizedStudentChoice === Number(question.correct_option_index),
  };
}

async function buildQuizStatusPayload(client, studentId, sessionRow, publicKeyPem = '') {
  const quizSessionConfig = await getQuizSessionConfig(client, sessionRow.id);
  if (quizSessionConfig) {
    const definition = await buildFolderQuizDefinition(quizSessionConfig);
    if (!publicKeyPem) {
      throw new Error('Missing student public key for encrypted quiz metadata');
    }
    const encryptedPackage = encryptJsonForStudent(publicKeyPem, {
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
    });
    const sync = {
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
      metadataNonceB64: encryptedPackage.packageNonceB64,
    };
    const result = await client.query(
      `SELECT id, score, total_questions, student_answers, time_taken_seconds, created_at
       FROM quiz_results
       WHERE student_id = $1 AND session_id = $2
       LIMIT 1`,
      [studentId, sessionRow.id],
    );

    const hasQuiz = definition.questionCount > 0;
    if (result.rowCount === 0) {
      return {
        hasQuiz,
        attempted: false,
        deliveryMode: 'folder_sync',
        sessionId: String(sessionRow.id),
        month: String(sessionRow.month_code || ''),
        session: String(sessionRow.session_code || ''),
        sync,
        totalQuestions: definition.questionCount,
        totalPoints: definition.totalPoints,
        questions: definition.questions.map(mapFolderQuizQuestionForPlayer),
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
      sync,
      result: {
        id: String(row.id),
        score: Number(row.score) || 0,
        totalQuestions: Number(row.total_questions) || 0,
        totalPoints: definition.totalPoints,
        studentAnswers,
        timeTakenSeconds: Number(row.time_taken_seconds) || 0,
        createdAt: row.created_at,
      },
      questions: definition.questions.map((question, index) => ({
        id: `folder-question-${question.index + 1}`,
        imageUrl: String(question.imageUrl || ''),
        imageFileName: String(question.fileName || ''),
        imageDownloadUrl: createGoogleDriveDownloadUrl(question.fileId),
        optionsCount: Array.isArray(question.options) ? question.options.length : 0,
        points: Number(question.points) || 0,
        studentChoiceIndex: Number.isInteger(studentAnswers[index]) ? Number(studentAnswers[index]) : null,
        correctOptionIndex: Number(question.correctOptionIndex),
        isCorrect: Number.isInteger(studentAnswers[index]) && Number(studentAnswers[index]) === Number(question.correctOptionIndex),
      })),
    };
  }

  const questions = await getQuizQuestions(client, sessionRow.id);
  const result = await client.query(
    `SELECT id, score, total_questions, student_answers, time_taken_seconds, created_at
     FROM quiz_results
     WHERE student_id = $1 AND session_id = $2
     LIMIT 1`,
    [studentId, sessionRow.id],
  );

  const questionCount = questions.length;
  const totalPoints = questions.reduce((sum, question) => sum + (Number(question.points) || 0), 0);
  const hasQuiz = questionCount > 0;

  if (result.rowCount === 0) {
    return {
      hasQuiz,
      attempted: false,
      sessionId: String(sessionRow.id),
      month: String(sessionRow.month_code || ''),
      session: String(sessionRow.session_code || ''),
      totalQuestions: questionCount,
      totalPoints,
      questions: questions.map(mapQuizQuestionForPlayer),
    };
  }

  const row = result.rows[0];
  const studentAnswers = Array.isArray(row.student_answers) ? row.student_answers : [];
  return {
    hasQuiz,
    attempted: true,
    sessionId: String(sessionRow.id),
    month: String(sessionRow.month_code || ''),
    session: String(sessionRow.session_code || ''),
    result: {
      id: String(row.id),
      score: Number(row.score) || 0,
      totalQuestions: Number(row.total_questions) || 0,
      totalPoints,
      studentAnswers,
      timeTakenSeconds: Number(row.time_taken_seconds) || 0,
      createdAt: row.created_at,
    },
    questions: questions.map((question, index) => mapQuizQuestionForReview(question, studentAnswers, index)),
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

async function getStudentFromToken(client, reqUser) {
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    const db = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: true, db: db.rows[0]?.ok === 1 });
  } catch {
    return res.status(500).json({ ok: false, db: false });
  }
});

app.post('/auth/login', async (req, res) => {
  const serial = normalizeSerial(req.body.serial);
  const deviceId = String(req.body.deviceId || '').trim();
  const publicKeyPem = String(req.body.publicKeyPem || '').trim();

  if (!serial || !deviceId) {
    return res.status(400).json({ error: 'serial and deviceId are required' });
  }

  const client = await pool.connect();
  try {
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
    const token = jwt.sign({ serial, deviceId }, JWT_SECRET, { expiresIn: '30d' });

    return res.json({
      token,
      student: {
        serial,
        deviceId,
        availableMonths: allowedMonths,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: `Login query failed: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/videos', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const allowedMonths = authState.allowedMonths;
    const catalog = readCatalog();
    await ensureCatalogSessions(client, catalog);
    const sessionMap = await loadSessionMap(client);
    const quizEnabledSessionIds = await loadQuizEnabledSessionIds(client);

    let months = allowedMonths.map((month) => {
      // Videos
      const videos = catalog.videos
        .filter((video) => String(video?.month || '').toUpperCase() === month)
        .map((video) => ({
          id:          String(video.id || ''),
          title:       String(video.title || 'Record'),
          month,
          session:     String(video.session || 'S1').toUpperCase(),
          durationSec: Number.isFinite(video.durationSec) ? Number(video.durationSec) : null,
        }))
        .filter((v) => v.id);

      // PDFs
      const pdfs = catalog.pdfs
        .filter((pdf) => String(pdf?.month || '').toUpperCase() === month)
        .map((pdf) => {
          const relativePath = String(pdf?.storage?.relativePath || '').replaceAll('\\', '/');
          const downloadUrl  = relativePath
            ? `/pdf/${relativePath.split('/').map(encodeURIComponent).join('/')}`
            : '';
          return {
            id:          String(pdf.id || ''),
            title:       String(pdf.title || 'PDF'),
            month,
            session:     String(pdf.session || 'S1').toUpperCase(),
            downloadUrl,
          };
        })
        .filter((p) => p.id && p.downloadUrl);

      const quizSessions = new Map();
      for (const video of videos) {
        quizSessions.set(String(video.session || '').toUpperCase(), true);
      }
      for (const pdf of pdfs) {
        quizSessions.set(String(pdf.session || '').toUpperCase(), true);
      }

      const quizzes = Array.from(quizSessions.keys()).map((sessionCode) => {
        const sessionRow = sessionMap.get(`${month}:${sessionCode}`);
        return {
          month,
          session: sessionCode,
          sessionId: sessionRow?.id ? String(sessionRow.id) : '',
          hasQuiz: Boolean(sessionRow?.id && quizEnabledSessionIds.has(String(sessionRow.id))),
        };
      }).filter((quiz) => quiz.hasQuiz && quiz.sessionId);

      return { month, videos, pdfs, quizzes };
    });

    // Fallback to legacy math_records if no catalog videos exist at all
    const hasCatalogVideos = months.some((month) => month.videos.length > 0);
    if (!hasCatalogVideos) {
      const records = await getRecordsRows(client);
      months = allowedMonths.map((month) => {
        const monthKey = monthColumn(month);
        const videos = records
          .map((record) => {
            const url = normalizeRecordUrl(record[monthKey]);
            if (!url) return null;
            return {
              id: `${month}_${record.record_no}`,
              title: `Record ${record.record_no}`,
              month,
              session: 'S1',
              durationSec: null,
            };
          })
          .filter(Boolean);

        const sessionRow = sessionMap.get(`${month}:S1`);
        return {
          month,
          videos,
          pdfs: [],
          quizzes: sessionRow?.id && quizEnabledSessionIds.has(String(sessionRow.id))
            ? [{ month, session: 'S1', sessionId: String(sessionRow.id), hasQuiz: true }]
            : [],
        };
      });
    }

    return res.json({ generatedAt: new Date().toISOString(), months });
  } catch (error) {
    return res.status(500).json({ error: `Failed to query months: ${error.message}` });
  } finally {
    client.release();
  }
});

app.get('/quiz/status/:sessionId', authMiddleware, async (req, res) => {
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

    if (quizSessionConfig) {
      const definition = await buildFolderQuizDefinition(quizSessionConfig);
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
    } else {
      const questions = await getQuizQuestions(client, sessionRow.id);
      totalQuestions = questions.length;
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
        const optionsCount = Number(questions[index].options_count) || 0;
        if (optionIndex < 0 || optionIndex >= optionsCount) {
          throw new Error(`Answer at index ${index} is out of range`);
        }
        return optionIndex;
      });

      for (let i = 0; i < questions.length; i += 1) {
        if (normalizedAnswers[i] === Number(questions[i].correct_option_index)) {
          score += Number(questions[i].points) || 0;
        }
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

app.post('/videos/:videoId/license', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    const catalog = readCatalog();
    const video = catalog.videos.find((entry) => String(entry?.id || '') === req.params.videoId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const month = String(video.month || '').toUpperCase();
    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

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

    const publicKeyPem = String(req.body.publicKeyPem || authState.student.public_key_pem || '').trim();
    if (!publicKeyPem) {
      return res.status(400).json({ error: 'Missing student public key' });
    }

    let encryptedDataKey;
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

    const storageMode = String(video?.storage?.mode || 'single').toLowerCase();
    const chunkManifest = storageMode === 'chunked' ? buildChunkManifest(video) : [];
    const contentUrl = storageMode === 'chunked' ? '' : buildPagedContentUrl(video);
    const totalPlainSize = Number(video?.storage?.totalPlainSize) || null;
    const pageSize = Number(video?.storage?.pageSize) || null;
    const pageCount = Number(video?.storage?.pageCount) || null;

    return res.json({
      videoId: String(video.id || ''),
      storageMode,
      algorithm: 'AES-256-GCM',
      videoNonceB64: storageMode === 'single' ? String(video.encryption?.nonceB64 || '') : '',
      encryptedDataKeyB64: encryptedDataKey.toString('base64'),
      plainDataKeyB64: '',
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

app.get(/^\/storage\/(.+)$/, authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
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
    const authState = await getStudentFromToken(client, req.user);
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
  const match = String(req.params.videoId || '').match(/^(M(1[0-2]|[1-9]))_(\d+)$/i);
  if (!match) {
    return res.status(400).json({ error: 'Invalid video id format' });
  }

  const month = match[1].toUpperCase();
  const recordNo = Number(match[3]);

  const client = await pool.connect();
  try {
    const authState = await getStudentFromToken(client, req.user);
    if (authState.error) {
      return res.status(authState.status || 401).json({ error: authState.error });
    }

    if (!authState.allowedMonths.includes(month)) {
      return res.status(403).json({ error: `You are not subscribed to ${month}` });
    }

    const monthKey = monthColumn(month);
    let row;

    try {
      const byRecordNo = await client.query(
        `SELECT "${monthKey}" AS link
         FROM "${recordsTable}"
         WHERE record_no = $1
         LIMIT 1`,
        [recordNo],
      );
      row = byRecordNo.rows[0];
    } catch (error) {
      if (error?.code !== '42703') {
        throw error;
      }

      const byOffset = await client.query(
        `SELECT "${monthKey}" AS link
         FROM "${recordsTable}"
         OFFSET $1 LIMIT 1`,
        [Math.max(0, recordNo - 1)],
      );
      row = byOffset.rows[0];
    }

    const link = normalizeRecordUrl(row?.link);
    if (!link) {
      return res.status(404).json({ error: 'Record link not found for this month/record' });
    }

    return res.redirect(302, link);
  } catch (error) {
    return res.status(500).json({ error: `Failed to get record link: ${error.message}` });
  } finally {
    client.release();
  }
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