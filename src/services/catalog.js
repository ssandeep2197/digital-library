const { notFound, conflict } = require('../errors');
const { withTransaction } = require('../db');

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const COPY_COUNTS = `
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.status <> 'lost') AS total_copies,
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.status = 'available') AS available_copies`;

function createCatalog({ pool }) {
  async function listBooks({ q, author, genre, available, page, limit, offset }) {
    const where = [];
    const params = [];
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push('(b.title LIKE ? OR b.author LIKE ? OR b.isbn = ?)');
      params.push(like, like, q.replace(/[\s-]/g, ''));
    }
    if (author) {
      where.push('b.author LIKE ?');
      params.push(`%${escapeLike(author)}%`);
    }
    if (genre) {
      where.push('b.genre = ?');
      params.push(genre);
    }
    if (available === true) where.push("EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id AND c.status = 'available')");
    if (available === false) where.push("NOT EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id AND c.status = 'available')");
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM books b ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT b.*, ${COPY_COUNTS} FROM books b ${whereSql} ORDER BY b.title, b.id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { total, page, limit, items: rows.map(bookOut) };
  }

  async function getBook(id) {
    const [[book]] = await pool.query(`SELECT b.*, ${COPY_COUNTS} FROM books b WHERE b.id = ?`, [id]);
    if (!book) throw notFound(`Book ${id} not found`);
    return bookOut(book);
  }

  async function createBook(fields) {
    try {
      const [result] = await pool.query('INSERT INTO books SET ?', [fields]);
      return getBook(result.insertId);
    } catch (err) {
      throw duplicate(err, `A book with ISBN ${fields.isbn} already exists`);
    }
  }

  async function updateBook(id, fields) {
    await getBook(id);
    if (Object.keys(fields).length) {
      try {
        await pool.query('UPDATE books SET ? WHERE id = ?', [fields, id]);
      } catch (err) {
        throw duplicate(err, `A book with ISBN ${fields.isbn} already exists`);
      }
    }
    return getBook(id);
  }

  // Removing books and copies also removes their past loans and reservations. Refused while
  // a copy is out or held, someone is waiting for the book, or a past loan has an unpaid
  // fine (deleting it would wipe what the member owes).
  async function assertCopiesRemovable(conn, copyIds, what) {
    if (!copyIds.length) return;
    const [[{ onLoan }]] = await conn.query("SELECT COUNT(*) AS onLoan FROM copies WHERE id IN (?) AND status = 'on_loan'", [copyIds]);
    if (onLoan) throw conflict(`${what} is checked out. Check it in first.`, 'copy_on_loan');
    const [[{ held }]] = await conn.query("SELECT COUNT(*) AS held FROM copies WHERE id IN (?) AND status = 'on_hold'", [copyIds]);
    if (held) throw conflict(`${what} is on hold for a member. Cancel that reservation first.`, 'copy_on_hold');
    const [[{ fines }]] = await conn.query(
      'SELECT COUNT(*) AS fines FROM loans WHERE copy_id IN (?) AND returned_at IS NOT NULL AND fine_paid = 0 AND fine_cents > 0',
      [copyIds],
    );
    if (fines) throw conflict(`${what} has an unpaid late fine on a past loan. Record the member's payment first.`, 'fines_owed');
  }

  async function deleteBook(id) {
    return withTransaction(pool, async (conn) => {
      const [[book]] = await conn.query('SELECT * FROM books WHERE id = ? FOR UPDATE', [id]);
      if (!book) throw notFound(`Book ${id} not found`);
      const [copies] = await conn.query('SELECT id FROM copies WHERE book_id = ? FOR UPDATE', [id]);
      const copyIds = copies.map((c) => c.id);
      await assertCopiesRemovable(conn, copyIds, `A copy of “${book.title}”`);
      const [[{ waiting }]] = await conn.query("SELECT COUNT(*) AS waiting FROM reservations WHERE book_id = ? AND status IN ('waiting','ready')", [id]);
      if (waiting) throw conflict(`${waiting} member(s) are waiting for “${book.title}”. Cancel their reservations first.`, 'has_reservations');

      await conn.query('DELETE FROM reservations WHERE book_id = ?', [id]);
      if (copyIds.length) await conn.query('DELETE FROM loans WHERE copy_id IN (?)', [copyIds]);
      await conn.query('DELETE FROM copies WHERE book_id = ?', [id]);
      await conn.query('DELETE FROM books WHERE id = ?', [id]);
      return { id, deleted: true, copiesDeleted: copyIds.length };
    });
  }

  async function deleteCopy(copyId) {
    return withTransaction(pool, async (conn) => {
      const [[copy]] = await conn.query('SELECT * FROM copies WHERE id = ? FOR UPDATE', [copyId]);
      if (!copy) throw notFound(`Copy ${copyId} not found`);
      await assertCopiesRemovable(conn, [copy.id], `Copy ${copy.barcode}`);
      await conn.query('UPDATE reservations SET copy_id = NULL WHERE copy_id = ?', [copy.id]);
      await conn.query('DELETE FROM loans WHERE copy_id = ?', [copy.id]);
      await conn.query('DELETE FROM copies WHERE id = ?', [copy.id]);
      return { id: copy.id, deleted: true };
    });
  }

  async function listCopies(bookId) {
    await getBook(bookId);
    const [rows] = await pool.query(
      `SELECT c.id, c.barcode, c.status, c.location, l.id AS loan_id, l.due_at, r.id AS reservation_id, r.expires_at AS hold_expires_at
         FROM copies c
         LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
         LEFT JOIN reservations r ON r.copy_id = c.id AND r.status = 'ready'
        WHERE c.book_id = ? ORDER BY c.id`,
      [bookId],
    );
    return rows.map((c) => ({
      id: c.id,
      barcode: c.barcode,
      status: c.status,
      location: c.location,
      dueAt: c.due_at,
      loanId: c.loan_id,
      holdReservationId: c.reservation_id,
      holdExpiresAt: c.hold_expires_at,
    }));
  }

  async function getCopy(copyId) {
    const [[copy]] = await pool.query('SELECT * FROM copies WHERE id = ?', [copyId]);
    if (!copy) throw notFound(`Copy ${copyId} not found`);
    return copy;
  }

  async function addCopy(bookId, { barcode, location }) {
    await getBook(bookId);
    try {
      const [result] = await pool.query('INSERT INTO copies (book_id, barcode, location) VALUES (?, ?, ?)', [bookId, barcode, location]);
      return getCopy(result.insertId);
    } catch (err) {
      throw duplicate(err, `Barcode ${barcode} is already in use`);
    }
  }

  async function updateCopyLocation(copyId, location) {
    await getCopy(copyId);
    await pool.query('UPDATE copies SET location = ? WHERE id = ?', [location, copyId]);
    return getCopy(copyId);
  }

  // Everything a patron or the desk needs to answer "can I get this book, and when?"
  async function availability(bookId) {
    const book = await getBook(bookId);
    const [statusRows] = await pool.query('SELECT status, COUNT(*) AS n FROM copies WHERE book_id = ? GROUP BY status', [bookId]);
    const byStatus = { available: 0, on_loan: 0, on_hold: 0, maintenance: 0, lost: 0 };
    for (const { status, n } of statusRows) byStatus[status] = n;
    const [[{ waiting }]] = await pool.query("SELECT COUNT(*) AS waiting FROM reservations WHERE book_id = ? AND status = 'waiting'", [bookId]);
    const [[{ next_due }]] = await pool.query(
      'SELECT MIN(l.due_at) AS next_due FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.book_id = ? AND l.returned_at IS NULL',
      [bookId],
    );
    return {
      bookId: book.id,
      title: book.title,
      available: byStatus.available > 0,
      copies: byStatus,
      totalCopies: book.totalCopies,
      waitingReservations: waiting,
      nextDueAt: next_due,
    };
  }

  return { listBooks, getBook, createBook, updateBook, deleteBook, deleteCopy, listCopies, getCopy, addCopy, updateCopyLocation, availability };
}

function bookOut(b) {
  return {
    id: b.id,
    isbn: b.isbn,
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    publishedYear: b.published_year,
    genre: b.genre,
    description: b.description,
    totalCopies: Number(b.total_copies),
    availableCopies: Number(b.available_copies),
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

function duplicate(err, message) {
  return err.code === 'ER_DUP_ENTRY' ? conflict(message, 'duplicate') : err;
}

module.exports = { createCatalog };
