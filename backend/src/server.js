const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MASTER_KEY_B64 = process.env.MASTER_KEY_B64 || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true';

function sanitizeSqlIdentifier(value, fallback) {
  const candidate = String(value || fallback || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
    throw new Error(`Invalid SQL identifier: ${candidate}`);
  }
  return candidate;
}

const STUDENT_SERIALS_TABLE = sanitizeSqlIdentifier(process.env.STUDENT_SERIALS_TABLE, 'student_serials');
const MATH_RECORDS_TABLE = sanitizeSqlIdentifier(process.env.MATH_RECORDS_TABLE, 'math_records');

const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    })
  : null;

const dataDir = path.join(__dirname, '..', 'data');
const serialsPath = path.join(dataDir, 'serials.json');
const catalogPath = path.join(dataDir, 'catalog.json');
const encryptedDir = path.join(__dirname, '..', '..', 'encrypted');
const decryptedDir = path.join(__dirname, '..', '..', 'decrypted_cache');
const videosDir = path.join(__dirname, '..', '..', 'videos');

function ensureDataFiles() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(serialsPath)) fs.writeFileSync(serialsPath, JSON.stringify({ serials: [] }, null, 2));
  if (!fs.existsSync(catalogPath)) fs.writeFileSync(catalogPath, JSON.stringify({ generatedAt: '', videos: [] }, null, 2));
  if (!fs.existsSync(decryptedDir)) fs.mkdirSync(decryptedDir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeSerial(serial) {
  return String(serial || '').trim().toUpperCase();
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

function aesGcmDecrypt(key, nonceB64, encryptedB64) {
  const iv = Buffer.from(nonceB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function monthList() {
  return Array.from({ length: 12 }, (_, i) => `M${i + 1}`);
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

ensureDataFiles();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/auth/login', (req, res) => {
  const serial = normalizeSerial(req.body.serial);
  const deviceId = String(req.body.deviceId || '').trim();
  const publicKeyPem = String(req.body.publicKeyPem || '').trim();

  if (!serial || !deviceId || !publicKeyPem) {
    return res.status(400).json({ error: 'serial, deviceId, publicKeyPem are required' });
  }

  const serialDb = readJson(serialsPath, { serials: [] });
  const row = serialDb.serials.find((s) => normalizeSerial(s.serial) === serial && s.active !== false);
  if (!row) return res.status(401).json({ error: 'Invalid serial' });

  if (!row.boundDeviceId) {
    row.boundDeviceId = deviceId;
    row.boundAt = new Date().toISOString();
  } else if (row.boundDeviceId !== deviceId) {
    return res.status(403).json({ error: 'This serial is already bound to another device' });
  }

  row.publicKeyPem = publicKeyPem;
  row.lastLoginAt = new Date().toISOString();
  writeJson(serialsPath, serialDb);

  const token = jwt.sign(
    { serial, deviceId },
    JWT_SECRET,
    { expiresIn: '30d' },
  );

  return res.json({
    token,
    student: {
      serial,
      deviceId,
    },
  });
});

app.get('/videos', authMiddleware, (_req, res) => {
  const catalog = readJson(catalogPath, { generatedAt: '', videos: [] });
  const videos = Array.isArray(catalog.videos) ? catalog.videos : [];

  const grouped = monthList().map((month) => ({
    month,
    videos: videos
      .filter((v) => String(v.month || '').toUpperCase() === month)
      .map((v) => ({
        id: v.id,
        title: v.title,
        month,
        durationSec: v.durationSec || null,
      })),
  }));

  return res.json({
    generatedAt: catalog.generatedAt || '',
    months: grouped,
  });
});

app.post('/videos/:videoId/license', authMiddleware, (req, res) => {
  const { serial, deviceId } = req.user;
  const serialDb = readJson(serialsPath, { serials: [] });
  const student = serialDb.serials.find((s) => normalizeSerial(s.serial) === normalizeSerial(serial));

  if (!student || student.active === false) {
    return res.status(401).json({ error: 'Invalid student session' });
  }
  if (student.boundDeviceId !== deviceId) {
    return res.status(403).json({ error: 'Session/device mismatch' });
  }

  const catalog = readJson(catalogPath, { generatedAt: '', videos: [] });
  const video = (catalog.videos || []).find((v) => v.id === req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

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
      video.encryption.keyWrap.nonceB64,
      video.encryption.keyWrap.wrappedKeyB64,
    );
  } catch {
    return res.status(500).json({ error: 'Failed to unwrap data key' });
  }

  const publicKeyPem = String(req.body.publicKeyPem || student.publicKeyPem || '').trim();
  const allowPlainDataKey = req.body?.allowPlainDataKey === true;
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

  const chunkManifest = buildChunkManifest(video);
  const isChunked = chunkManifest.length > 0;
  const relativePath = String(video.storage?.relativePath || '').replaceAll('\\', '/');
  const contentUrl = isChunked || !relativePath
    ? ''
    : `/storage/${relativePath.split('/').map(encodeURIComponent).join('/')}`;

  return res.json({
    videoId: video.id,
    algorithm: 'AES-256-GCM',
    videoNonceB64: isChunked ? '' : video.encryption.nonceB64,
    encryptedDataKeyB64: encryptedDataKey.toString('base64'),
    plainDataKeyB64: allowPlainDataKey ? dataKey.toString('base64') : '',
    contentUrl,
    requiresAuthForContent: true,
    totalPlainSize: Number(video.storage?.totalPlainSize) || null,
    chunks: chunkManifest,
  });
});

// Fast (less secure) playback path:
// no auth check for fastest compatibility with mobile player range requests.
app.get('/videos/:videoId/plain', (req, res) => {
  const catalog = readJson(catalogPath, { generatedAt: '', videos: [] });
  const video = (catalog.videos || []).find((v) => v.id === req.params.videoId);
  if (!video) return res.status(404).json({ error: 'Video not found' });

  // Fastest path (least secure): serve original clear source if present.
  try {
    const sourceRel = String(video.sourceFile || '').replaceAll('\\', '/');
    if (sourceRel) {
      const sourcePath = path.resolve(videosDir, sourceRel);
      if (sourcePath.startsWith(videosDir) && fs.existsSync(sourcePath)) {
        return res.sendFile(sourcePath);
      }
    }
  } catch {
    // Ignore and fallback to decrypt-cache flow below.
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
      video.encryption.keyWrap.nonceB64,
      video.encryption.keyWrap.wrappedKeyB64,
    );
  } catch {
    return res.status(500).json({ error: 'Failed to unwrap data key' });
  }

  const relativePath = String(video.storage?.relativePath || '').replaceAll('\\', '/');
  const encryptedFileName = path.basename(relativePath || `${video.id}.enc`);
  const encryptedPath = path.join(encryptedDir, encryptedFileName);

  if (!encryptedPath.startsWith(encryptedDir)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(encryptedPath)) {
    return res.status(404).json({ error: 'Encrypted file not found' });
  }

  const plainPath = path.join(decryptedDir, `${video.id}.mp4`);

  try {
    const encryptedStat = fs.statSync(encryptedPath);
    const hasCachedPlain = fs.existsSync(plainPath);
    const needsRefresh = !hasCachedPlain || fs.statSync(plainPath).mtimeMs < encryptedStat.mtimeMs;

    if (needsRefresh) {
      const encrypted = fs.readFileSync(encryptedPath);
      if (encrypted.length <= 16) {
        return res.status(500).json({ error: 'Encrypted file is invalid' });
      }

      const authTag = encrypted.subarray(encrypted.length - 16);
      const ciphertext = encrypted.subarray(0, encrypted.length - 16);
      const iv = Buffer.from(video.encryption.nonceB64, 'base64');

      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
      decipher.setAuthTag(authTag);

      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      fs.writeFileSync(plainPath, plain);
    }
  } catch {
    return res.status(500).json({ error: 'Failed to prepare decrypted stream' });
  }

  return res.sendFile(plainPath);
});

app.get(/^\/storage\/(.+)$/, authMiddleware, (req, res) => {
  const requestedRelativePath = decodeURIComponent(String(req.params[0] || '')).replaceAll('\\', '/');
  const normalizedRelativePath = requestedRelativePath.replace(/^\/+/, '');
  const target = path.resolve(__dirname, '..', '..', normalizedRelativePath);

  if (!target.startsWith(encryptedDir)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(target)) {
    return res.status(404).json({ error: 'Encrypted file not found' });
  }

  const catalog = readJson(catalogPath, { generatedAt: '', videos: [] });
  const matchedVideo = (catalog.videos || []).find((video) => {
    const rel = String(video?.storage?.relativePath || '').replaceAll('\\', '/');
    if (rel === normalizedRelativePath) return true;
    const chunks = Array.isArray(video?.storage?.chunks) ? video.storage.chunks : [];
    return chunks.some((chunk) => String(chunk?.relativePath || '').replaceAll('\\', '/') === normalizedRelativePath);
  });

  if (!matchedVideo) {
    return res.status(404).json({ error: 'Video metadata not found' });
  }

  return res.sendFile(target);
});

const server = app.listen(PORT, () => {
  console.log(`Backend listening on ${BASE_URL}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use. Backend is likely already running.`);
    console.log(`Use the existing backend instance at ${BASE_URL} or stop the old process first.`);
    process.exit(0);
  }

  throw error;
});
