const { notFound, conflict } = require('../errors');
const { withTransaction } = require('../db');
const { daysOverdue, fineFor } = require('../policy');

function createMembers({ pool, config, circulation }) {
  const { policy } = config;

  async function list({ q, page, limit, offset }) {
    const where = q ? 'WHERE name LIKE ? OR email LIKE ? OR phone = ?' : '';
    const like = q && `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const params = q ? [like, like, q] : [];
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM members ${where}`, params);
    const [rows] = await pool.query(`SELECT * FROM members ${where} ORDER BY name, id LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { total, page, limit, items: rows.map(memberOut) };
  }

  async function get(id) {
    const [[member]] = await pool.query('SELECT * FROM members WHERE id = ?', [id]);
    if (!member) throw notFound(`Member ${id} not found`);
    return memberOut(member);
  }

  async function create(fields) {
    try {
      const [result] = await pool.query('INSERT INTO members SET ?', [fields]);
      return get(result.insertId);
    } catch (err) {
      throw err.code === 'ER_DUP_ENTRY' ? conflict(`A member with email ${fields.email} already exists`, 'duplicate') : err;
    }
  }

  async function update(id, fields) {
    const current = await get(id);
    const next = { phone: current.phone, notify_sms: current.notifySms, ...fields };
    if (next.notify_sms && !next.phone) throw conflict('A phone number is required to enable SMS notifications', 'phone_required');
    if (Object.keys(fields).length) {
      try {
        await pool.query('UPDATE members SET ? WHERE id = ?', [fields, id]);
      } catch (err) {
        throw err.code === 'ER_DUP_ENTRY' ? conflict(`A member with email ${fields.email} already exists`, 'duplicate') : err;
      }
    }
    return get(id);
  }

  // The member's full picture: what they have out, what they're waiting for, what they owe.
  async function account(id) {
    const member = await get(id);
    const now = new Date();
    const [loans] = await pool.query(
      `SELECT l.id, l.checked_out_at, l.due_at, l.renewals, c.barcode, b.id AS book_id, b.title, b.author
         FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
        WHERE l.member_id = ? AND l.returned_at IS NULL ORDER BY l.due_at`,
      [id],
    );
    const [reservations] = await pool.query(
      `SELECT r.id, r.status, r.created_at, r.ready_at, r.expires_at, b.id AS book_id, b.title, c.barcode,
              (SELECT COUNT(*) FROM reservations q WHERE q.book_id = r.book_id AND q.status = 'waiting' AND q.id <= r.id) AS position
         FROM reservations r JOIN books b ON b.id = r.book_id LEFT JOIN copies c ON c.id = r.copy_id
        WHERE r.member_id = ? AND r.status IN ('waiting','ready') ORDER BY r.id`,
      [id],
    );
    const [unpaid] = await pool.query(
      `SELECT l.id, l.returned_at, l.fine_cents, b.title FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
        WHERE l.member_id = ? AND l.returned_at IS NOT NULL AND l.fine_paid = 0 AND l.fine_cents > 0 ORDER BY l.returned_at`,
      [id],
    );

    const openLoans = loans.map((l) => ({
      loanId: l.id,
      bookId: l.book_id,
      title: l.title,
      author: l.author,
      barcode: l.barcode,
      checkedOutAt: l.checked_out_at,
      dueAt: l.due_at,
      renewals: l.renewals,
      overdue: l.due_at < now,
      daysOverdue: daysOverdue(l.due_at, now),
      accruedFineCents: fineFor(l.due_at, now, policy),
    }));
    const unpaidFineCents = unpaid.reduce((s, l) => s + l.fine_cents, 0);
    const accruedFineCents = openLoans.reduce((s, l) => s + l.accruedFineCents, 0);

    return {
      member,
      loans: openLoans,
      reservations: reservations.map((r) => ({
        reservationId: r.id,
        bookId: r.book_id,
        title: r.title,
        status: r.status,
        position: r.status === 'waiting' ? r.position : 0,
        barcode: r.barcode,
        createdAt: r.created_at,
        readyAt: r.ready_at,
        expiresAt: r.expires_at,
      })),
      fines: {
        unpaid: unpaid.map((l) => ({ loanId: l.id, title: l.title, returnedAt: l.returned_at, fineCents: l.fine_cents })),
        unpaidCents: unpaidFineCents,
        accruingCents: accruedFineCents,
        totalCents: unpaidFineCents + accruedFineCents,
        borrowingBlocked: unpaidFineCents + accruedFineCents >= policy.blockAtFineCents,
      },
    };
  }

  async function payFines(id) {
    await get(id);
    const [result] = await pool.query(
      'UPDATE loans SET fine_paid = 1 WHERE member_id = ? AND returned_at IS NOT NULL AND fine_paid = 0',
      [id],
    );
    return { loansSettled: result.affectedRows, outstandingCents: await circulation.outstandingFines(id) };
  }

  async function history(id, { page, limit, offset }) {
    await get(id);
    const [rows] = await pool.query(
      `SELECT l.id, l.checked_out_at, l.due_at, l.returned_at, l.fine_cents, l.fine_paid, b.title, b.author, c.barcode
         FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
        WHERE l.member_id = ? ORDER BY l.checked_out_at DESC, l.id DESC LIMIT ? OFFSET ?`,
      [id, limit, offset],
    );
    return {
      page,
      limit,
      items: rows.map((l) => ({
        loanId: l.id,
        title: l.title,
        author: l.author,
        barcode: l.barcode,
        checkedOutAt: l.checked_out_at,
        dueAt: l.due_at,
        returnedAt: l.returned_at,
        fineCents: l.fine_cents,
        finePaid: Boolean(l.fine_paid),
      })),
    };
  }

  async function notifications(id, { page, limit, offset }) {
    await get(id);
    const [rows] = await pool.query(
      `SELECT id, member_id, channel, type, recipient, subject, body, status, attempts, last_error, created_at, sent_at
         FROM notifications WHERE member_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [id, limit, offset],
    );
    return { page, limit, items: rows.map(notificationOut) };
  }

  // Removes a member and their past records (returned loans, closed reservations, sent
  // notifications). Refused while they still have books out, active reservations or unpaid
  // fines, so nothing the library is owed or holding for them disappears.
  async function remove(id) {
    return withTransaction(pool, async (conn) => {
      const [[member]] = await conn.query('SELECT * FROM members WHERE id = ? FOR UPDATE', [id]);
      if (!member) throw notFound(`Member ${id} not found`);
      const [[{ loans }]] = await conn.query('SELECT COUNT(*) AS loans FROM loans WHERE member_id = ? AND returned_at IS NULL', [id]);
      if (loans) throw conflict(`${member.name} still has ${loans} book(s) checked out. Check them in first.`, 'has_loans');
      const [[{ holds }]] = await conn.query("SELECT COUNT(*) AS holds FROM reservations WHERE member_id = ? AND status IN ('waiting','ready')", [id]);
      if (holds) throw conflict(`${member.name} has ${holds} active reservation(s). Cancel them first.`, 'has_reservations');
      const owed = await circulation.outstandingFines(id);
      if (owed) throw conflict(`${member.name} has unpaid fines. Record the payment first.`, 'fines_owed');

      await conn.query('DELETE FROM notifications WHERE member_id = ?', [id]);
      await conn.query('DELETE FROM reservations WHERE member_id = ?', [id]);
      await conn.query('DELETE FROM loans WHERE member_id = ?', [id]);
      await conn.query('DELETE FROM members WHERE id = ?', [id]);
      return { id, deleted: true };
    });
  }

  return { list, get, create, update, remove, account, payFines, history, notifications };
}

function memberOut(m) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    notifyEmail: Boolean(m.notify_email),
    notifySms: Boolean(m.notify_sms),
    status: m.status,
    createdAt: m.created_at,
  };
}

function notificationOut(n) {
  return {
    id: n.id,
    memberId: n.member_id,
    channel: n.channel,
    type: n.type,
    recipient: n.recipient,
    subject: n.subject,
    body: n.body,
    status: n.status,
    attempts: n.attempts,
    lastError: n.last_error,
    createdAt: n.created_at,
    sentAt: n.sent_at,
  };
}

module.exports = { createMembers, notificationOut };
