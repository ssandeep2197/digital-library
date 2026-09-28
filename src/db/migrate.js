const config = require('../config');
const { createPool, migrate } = require('.');

(async () => {
  const pool = createPool(config.db);
  try {
    await migrate(pool);
    console.log(`Schema is up to date in ${config.db.database}.`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
