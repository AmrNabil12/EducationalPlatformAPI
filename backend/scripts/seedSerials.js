const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataPath = path.join(__dirname, '..', 'data', 'serials.json');

function parseCountArg() {
  const arg = process.argv.find((v) => v.startsWith('--count='));
  if (!arg) return 25;
  const parsed = Number(arg.split('=')[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

function randomSegment(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function generateSerial() {
  return `EDU-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}`;
}

function main() {
  const count = parseCountArg();
  const db = fs.existsSync(dataPath)
    ? JSON.parse(fs.readFileSync(dataPath, 'utf8'))
    : { serials: [] };

  const existing = new Set(db.serials.map((s) => String(s.serial || '').toUpperCase()));
  const created = [];

  while (created.length < count) {
    const serial = generateSerial();
    if (existing.has(serial)) continue;
    existing.add(serial);
    created.push(serial);
    db.serials.push({
      serial,
      active: true,
      boundDeviceId: null,
      publicKeyPem: null,
      createdAt: new Date().toISOString(),
      boundAt: null,
      lastLoginAt: null,
    });
  }

  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(db, null, 2));

  console.log(`Created ${created.length} serial(s):`);
  created.forEach((s) => console.log(s));
}

main();
