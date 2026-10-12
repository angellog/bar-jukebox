#!/usr/bin/env node
// Restore a QueuePlay backup (from super admin → "Download backup") into a database.
//
//   DATABASE_URL=postgresql://... node scripts/restore-backup.js queueplay-backup-2026-10-12-09-30.json
//
// Safe by default: refuses to run if the target already has venues
// (pass --merge to add only rows that don't exist yet).
// After restoring, venues must reconnect Spotify (tokens are not in backups).

const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QueuePlayDB = require('../src/database');

const ORDER = ['subscription_plans', 'venues', 'payments', 'queue', 'playback_history', 'guest_sessions'];
const SERIAL_TABLES = ['payments', 'queue', 'playback_history', 'guest_sessions'];

async function main() {
  const file = process.argv.find(a => a.endsWith('.json'));
  const merge = process.argv.includes('--merge');
  if (!file || !process.env.DATABASE_URL) {
    console.error('Usage: DATABASE_URL=... node scripts/restore-backup.js <backup.json> [--merge]');
    process.exit(2);
  }
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backup.format !== 'queueplay-backup') throw new Error('Not a QueuePlay backup file');

  const db = new QueuePlayDB(process.env.DATABASE_URL);
  await db.initializeSchema();
  const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM venues');
  if (rows[0].n > 0 && !merge) {
    console.error(`Target database already has ${rows[0].n} venue(s). Use an empty database, or pass --merge.`);
    await db.close();
    process.exit(1);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ORDER) {
      const items = (backup.tables[table] || []);
      if (!items.length) continue;
      const { rows: cols } = await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]
      );
      const known = new Set(cols.map(c => c.column_name));
      let inserted = 0;
      for (const raw of items) {
        const row = { ...raw };
        if (table === 'venues') {
          row.admin_key = uuidv4();     // re-created; not stored in backups
          row.spotify_connected = 0;    // venues reconnect Spotify after a restore
        }
        const keys = Object.keys(row).filter(k => known.has(k));
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`;
        const res = await client.query(sql, keys.map(k => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date)) ? JSON.stringify(row[k]) : row[k]));
        inserted += res.rowCount;
      }
      console.log(`${table}: restored ${inserted} of ${items.length}`);
    }
    for (const table of SERIAL_TABLES) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
    }
    await client.query('COMMIT');
    console.log(`\nRestored backup from ${backup.createdAt}. Venues must reconnect Spotify (Music & Speaker → Connect Spotify).`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await db.close();
  }
}

main().catch(err => { console.error('Restore failed:', err.message); process.exit(1); });
