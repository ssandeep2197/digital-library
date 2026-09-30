// Creates the schema and a default member. There are no sample books: add real ones from
// the dashboard's Catalog page. Safe to re-run: an existing email is skipped.
const config = require('../config');
const { createPool, migrate } = require('.');

// The repo is public, so this is a placeholder address; change it on the member's page.
const members = [{ name: 'Sandeep Singh', email: 'sandeep@example.com', phone: null, notify_sms: 0 }];

(async () => {
  const pool = createPool(config.db);
  try {
    await migrate(pool);
    for (const m of members) await pool.query('INSERT IGNORE INTO members SET ?', [m]);
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM members) AS members');
    console.log(`Seeded. Database has ${counts.books} books and ${counts.members} members.`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
