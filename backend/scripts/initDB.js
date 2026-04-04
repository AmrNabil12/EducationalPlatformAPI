const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function normalizeMonthCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^M(1[0-2]|[1-9])$/.test(normalized) ? normalized : '';
}

function normalizeSessionCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^S\d+$/.test(normalized) ? normalized : '';
}

function loadCatalogSessionPairs() {
  const catalogPath = path.join(__dirname, '..', 'data', 'catalog.json');
  const raw = fs.readFileSync(catalogPath, 'utf8');
  const catalog = JSON.parse(raw);
  const pairs = new Map();

  for (const entry of [...(catalog?.videos || []), ...(catalog?.pdfs || [])]) {
    const month = normalizeMonthCode(entry?.month);
    const session = normalizeSessionCode(entry?.session);
    if (!month || !session) continue;
    pairs.set(`${month}:${session}`, {
      month,
      session,
      title: `${month} ${session}`,
    });
  }

  return Array.from(pairs.values());
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  const databaseSsl = String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true';

  if (!databaseUrl) {
    console.error('Missing DATABASE_URL in backend/.env');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'sql', 'init_db.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    await client.query(sql);
    const sessionPairs = loadCatalogSessionPairs();
    for (const pair of sessionPairs) {
      await client.query(
        `INSERT INTO sessions (month_code, session_code, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (month_code, session_code) DO NOTHING`,
        [pair.month, pair.session, pair.title],
      );
    }
    console.log('Database initialized successfully using backend/sql/init_db.sql');
    console.log(`Auto-seeded ${sessionPairs.length} session pair(s) from backend/data/catalog.json`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
});