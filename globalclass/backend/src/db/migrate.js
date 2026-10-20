import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Any constant works; it only has to be the same in every core-api instance.
const MIGRATION_LOCK_ID = 43001;
const MAX_ATTEMPTS = 10;

// Runs on every core-api start (see package.json "start"). The schema uses
// CREATE ... IF NOT EXISTS, so re-running is harmless, but several replicas
// starting at once can still collide inside Postgres' catalog. The advisory
// lock makes them take turns.
async function migrate() {
  const sql = fs.readFileSync(
    path.join(__dirname, 'migrations/001_init.sql'),
    'utf8'
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let client;
    try {
      client = await pool.connect();
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      try {
        await client.query(sql);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      }
      console.log('Migration complete');
      return;
    } catch (err) {
      console.error(`Migration attempt ${attempt} failed:`, err.message);
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      client?.release();
    }
  }
}

migrate()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
