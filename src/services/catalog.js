const { notFound, conflict } = require('../errors');

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

  async function deleteBook(id) {
    await getBook(id);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM copies WHERE book_id = ?', [id]);
    if (n > 0) throw conflict('Remove or mark its copies as lost before deleting a book with copies', 'has_copies');
    const [[{ r }]] = await pool.query('SELECT COUNT(*) AS r FROM reservations WHERE book_id = ?', [id]);
    if (r > 0) throw conflict('This book has reservation history and cannot be deleted', 'has_reservations');
    await pool.query('DELETE FROM books WHERE id = ?', [id]);
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

  return { listBooks, getBook, createBook, updateBook, deleteBook, listCopies, getCopy, addCopy, updateCopyLocation, availability };
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
