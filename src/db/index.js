const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function createPool(dbConfig) {
  const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    timezone: 'Z',
    decimalNumbers: true,
    namedPlaceholders: false,
  });
  // Keep DEFAULT CURRENT_TIMESTAMP columns in UTC, matching the Dates we write.
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
  return pool;
}

// Runs fn(conn) inside a transaction and commits, or rolls back if it throws.
async function withTransaction(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const statement of statements) await pool.query(statement);
}

module.exports = { createPool, withTransaction, migrate };
