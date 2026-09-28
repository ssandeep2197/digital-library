const express = require('express');
const v = require('../validate');
const { wrap } = require('./helpers');
const { notificationOut } = require('../services/members');
const { notFound, conflict } = require('../errors');

const copyRef = (body) => ({
  copyId: v.int(body.copyId, 'copyId', { min: 1 }),
  barcode: v.str(body.barcode, 'barcode', { max: 64 }),
});

function circulationRoutes({ pool, circulation, runJobs }) {
  const r = express.Router();

  // Checkout
  r.post('/loans', wrap(async (req, res) =>
    res.status(201).json(await circulation.checkout({ memberId: v.id(req.body.memberId, 'memberId'), ...copyRef(req.body) }))));

  // Check-in
  r.post('/returns', wrap(async (req, res) => res.json(await circulation.checkin(copyRef(req.body)))));

  r.post('/loans/:id/renew', wrap(async (req, res) => res.json(await circulation.renew(v.id(req.params.id, 'id')))));

  r.get('/loans', wrap(async (req, res) => {
    const status = v.oneOf(req.query.status, 'status', ['open', 'overdue', 'returned']) || 'open';
    const { page, limit, offset } = v.paging(req.query);
    const where = { open: 'l.returned_at IS NULL', overdue: 'l.returned_at IS NULL AND l.due_at < ?', returned: 'l.returned_at IS NOT NULL' }[status];
    const [rows] = await pool.query(
      `SELECT l.id AS loanId, l.member_id AS memberId, m.name AS memberName, c.barcode, b.title,
              l.checked_out_at AS checkedOutAt, l.due_at AS dueAt, l.returned_at AS returnedAt, l.renewals, l.overdue_notices AS overdueNotices
         FROM loans l JOIN members m ON m.id = l.member_id JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
        WHERE ${where} ORDER BY l.due_at LIMIT ? OFFSET ?`,
      [...(status === 'overdue' ? [new Date()] : []), limit, offset],
    );
    res.json({ status, page, limit, items: rows });
  }));

  r.post('/reservations', wrap(async (req, res) =>
    res.status(201).json(await circulation.reserve({ bookId: v.id(req.body.bookId, 'bookId'), memberId: v.id(req.body.memberId, 'memberId') }))));

  r.delete('/reservations/:id', wrap(async (req, res) => res.json(await circulation.cancelReservation(v.id(req.params.id, 'id')))));

  // The hold queue for a book, in pickup order.
  r.get('/books/:id/reservations', wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT r.id AS reservationId, r.member_id AS memberId, m.name AS memberName, r.status, r.created_at AS createdAt,
              r.expires_at AS expiresAt, c.barcode
         FROM reservations r JOIN members m ON m.id = r.member_id LEFT JOIN copies c ON c.id = r.copy_id
        WHERE r.book_id = ? AND r.status IN ('ready','waiting')
        ORDER BY r.status = 'waiting', r.id`,
      [v.id(req.params.id, 'id')],
    );
    let position = 0;
    res.json({ items: rows.map((row) => ({ ...row, position: row.status === 'waiting' ? ++position : 0 })) });
  }));

  r.get('/notifications', wrap(async (req, res) => {
    const filters = {
      status: v.oneOf(req.query.status, 'status', ['pending', 'sent', 'failed']),
      channel: v.oneOf(req.query.channel, 'channel', ['email', 'sms']),
      type: v.str(req.query.type, 'type', { max: 40 }),
    };
    const { page, limit, offset } = v.paging(req.query);
    const where = Object.entries(filters).filter(([, val]) => val);
    const [rows] = await pool.query(
      `SELECT * FROM notifications ${where.length ? `WHERE ${where.map(([k]) => `${k} = ?`).join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...where.map(([, val]) => val), limit, offset],
    );
    res.json({ page, limit, items: rows.map(notificationOut) });
  }));

  r.post('/notifications/:id/retry', wrap(async (req, res) => {
    const id = v.id(req.params.id, 'id');
    const [[n]] = await pool.query('SELECT status FROM notifications WHERE id = ?', [id]);
    if (!n) throw notFound(`Notification ${id} not found`);
    if (n.status !== 'failed') throw conflict(`Only failed notifications can be retried (this one is ${n.status})`, 'not_failed');
    await pool.query("UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE id = ?", [new Date(), id]);
    res.json({ id, status: 'pending' });
  }));

  // Runs reminders, overdue notices and hold expiry now instead of waiting for the scheduler.
  r.post('/jobs/run', wrap(async (req, res) => res.json(await runJobs())));

  return r;
}

module.exports = { circulationRoutes };
