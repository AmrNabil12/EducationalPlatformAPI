const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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
    console.log('Database initialized successfully using backend/sql/init_db.sql');
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
});