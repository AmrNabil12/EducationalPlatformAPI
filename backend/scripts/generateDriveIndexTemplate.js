const fs = require('fs');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const catalogPath = path.join(backendDir, 'data', 'catalog.json');
const outputPath = path.join(backendDir, 'data', 'google_drive_index.json');

function normalizeRelativePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const catalog = readJson(catalogPath, { videos: [] });
const existing = readJson(outputPath, {});
const nextIndex = {};

for (const video of Array.isArray(catalog.videos) ? catalog.videos : []) {
  const storage = video?.storage || {};
  const singleRelativePath = normalizeRelativePath(storage.relativePath);
  if (singleRelativePath) {
    nextIndex[singleRelativePath] = existing[singleRelativePath] || '';
  }

  const chunks = Array.isArray(storage.chunks) ? storage.chunks : [];
  for (const chunk of chunks) {
    const chunkRelativePath = normalizeRelativePath(chunk?.relativePath);
    if (chunkRelativePath) {
      nextIndex[chunkRelativePath] = existing[chunkRelativePath] || '';
    }
  }
}

fs.writeFileSync(outputPath, `${JSON.stringify(nextIndex, null, 2)}\n`, 'utf8');
console.log(`Google Drive index written to ${outputPath}`);
console.log('Fill each value with either a Google Drive file ID or a share URL, then redeploy the backend.');