// Loads a small sample catalog and a default member so the API has something to show.
// Safe to re-run: existing ISBNs, barcodes and emails are skipped.
const config = require('../config');
const { createPool, migrate } = require('.');

const books = [
  { isbn: '9780132350884', title: 'Clean Code', author: 'Robert C. Martin', publisher: 'Prentice Hall', published_year: 2008, genre: 'Software', copies: 3 },
  { isbn: '9780201616224', title: 'The Pragmatic Programmer', author: 'Andrew Hunt, David Thomas', publisher: 'Addison-Wesley', published_year: 1999, genre: 'Software', copies: 2 },
  { isbn: '9781449373320', title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', publisher: "O'Reilly", published_year: 2017, genre: 'Software', copies: 1 },
  { isbn: '9780441172719', title: 'Dune', author: 'Frank Herbert', publisher: 'Ace', published_year: 1965, genre: 'Fiction', copies: 2 },
  { isbn: '9780062316097', title: 'Sapiens', author: 'Yuval Noah Harari', publisher: 'Harper', published_year: 2015, genre: 'History', copies: 1 },
];

// The repo is public, so this is a placeholder address; change it on the member's page.
const members = [{ name: 'Sandeep Singh', email: 'sandeep@example.com', phone: null, notify_sms: 0 }];

(async () => {
  const pool = createPool(config.db);
  try {
    await migrate(pool);
    for (const { copies, ...book } of books) {
      await pool.query('INSERT IGNORE INTO books SET ?', [book]);
      const [[{ id }]] = await pool.query('SELECT id FROM books WHERE isbn = ?', [book.isbn]);
      for (let i = 1; i <= copies; i++) {
        await pool.query('INSERT IGNORE INTO copies (book_id, barcode, location) VALUES (?, ?, ?)', [id, `LIB-${book.isbn.slice(-6)}-${i}`, `Shelf ${book.genre[0]}${i}`]);
      }
    }
    for (const m of members) await pool.query('INSERT IGNORE INTO members SET ?', [m]);
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM copies) AS copies, (SELECT COUNT(*) FROM members) AS members');
    console.log(`Seeded: ${counts.books} books, ${counts.copies} copies, ${counts.members} members.`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
