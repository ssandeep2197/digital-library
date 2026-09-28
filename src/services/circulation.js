const { withTransaction } = require('../db');
const { enqueue } = require('../notify/outbox');
const { addDays, daysOverdue, fineFor, formatCents, DAY_MS } = require('../policy');
const { badRequest, notFound, conflict } = require('../errors');

// Checkouts, returns, renewals, the reservation queue, and the scheduled jobs that
// send reminders and expire uncollected holds.
//
// Invariant: a copy is only 'available' when nobody is waiting for its book. Every path
// that frees a copy goes through releaseCopy(), which hands it to the head of the queue.
function createCirculation({ pool, config, log = console }) {
  const { policy, reminders, libraryName: library } = config;
  const notify = (conn, member, type, data, dedupeKey) => enqueue(conn, { member, type, data, dedupeKey, library });

  async function lockMember(conn, memberId) {
    const [[member]] = await conn.query('SELECT * FROM members WHERE id = ? FOR UPDATE', [memberId]);
    if (!member) throw notFound(`Member ${memberId} not found`);
    return member;
  }

  async function outstandingFines(conn, memberId, now = new Date()) {
    const [[{ owed }]] = await conn.query(
      'SELECT COALESCE(SUM(fine_cents), 0) AS owed FROM loans WHERE member_id = ? AND returned_at IS NOT NULL AND fine_paid = 0',
      [memberId],
    );
    const [open] = await conn.query('SELECT due_at FROM loans WHERE member_id = ? AND returned_at IS NULL AND due_at < ?', [memberId, now]);
    return Number(owed) + open.reduce((sum, l) => sum + fineFor(l.due_at, now, policy), 0);
  }

  async function assertInGoodStanding(conn, member) {
    if (member.status !== 'active') throw conflict(`Member ${member.id} is suspended`, 'member_suspended');
    const owed = await outstandingFines(conn, member.id);
    if (owed >= policy.blockAtFineCents) {
      throw conflict(`Member owes ${formatCents(owed)} in fines; borrowing is blocked at ${formatCents(policy.blockAtFineCents)}`, 'fines_owed');
    }
  }

  async function lockCopy(conn, { copyId, barcode }) {
    if (!copyId && !barcode) throw badRequest('copyId or barcode is required');
    const [[copy]] = await conn.query(
      `SELECT c.*, b.title, b.author FROM copies c JOIN books b ON b.id = c.book_id
        WHERE ${copyId ? 'c.id' : 'c.barcode'} = ? FOR UPDATE`,
      [copyId || barcode],
    );
    if (!copy) throw notFound(`Copy ${copyId || barcode} not found`);
    return copy;
  }

  // Gives a copy that just became free to the next member waiting for its book,
  // or makes it available. `copy` must be locked by the caller and include title/author.
  async function releaseCopy(conn, copy, now = new Date()) {
    const [[next]] = await conn.query(
      `SELECT r.id, r.member_id FROM reservations r
        WHERE r.book_id = ? AND r.status = 'waiting' ORDER BY r.id LIMIT 1 FOR UPDATE`,
      [copy.book_id],
    );
    if (!next) {
      await conn.query("UPDATE copies SET status = 'available' WHERE id = ?", [copy.id]);
      return null;
    }
    const expiresAt = addDays(now, policy.holdDays);
    await conn.query(
      "UPDATE reservations SET status = 'ready', copy_id = ?, ready_at = ?, expires_at = ? WHERE id = ?",
      [copy.id, now, expiresAt, next.id],
    );
    await conn.query("UPDATE copies SET status = 'on_hold' WHERE id = ?", [copy.id]);
    const [[member]] = await conn.query('SELECT * FROM members WHERE id = ?', [next.member_id]);
    await notify(conn, member, 'reservation_ready', { title: copy.title, author: copy.author, barcode: copy.barcode, expiresAt }, `res:${next.id}:ready`);
    return { reservationId: next.id, memberId: next.member_id, expiresAt };
  }

  async function checkout({ memberId, copyId, barcode }) {
    return withTransaction(pool, async (conn) => {
      const now = new Date();
      const member = await lockMember(conn, memberId);
      await assertInGoodStanding(conn, member);

      const [[{ open }]] = await conn.query('SELECT COUNT(*) AS open FROM loans WHERE member_id = ? AND returned_at IS NULL', [member.id]);
      if (open >= policy.maxLoans) throw conflict(`Member already has ${open} items out (limit ${policy.maxLoans})`, 'loan_limit');

      const copy = await lockCopy(conn, { copyId, barcode });
      // The member's own active reservation for this book, if any.
      const [[ownReservation]] = await conn.query(
        "SELECT * FROM reservations WHERE book_id = ? AND member_id = ? AND status IN ('waiting','ready') FOR UPDATE",
        [copy.book_id, member.id],
      );

      if (copy.status === 'on_hold') {
        if (!ownReservation || ownReservation.copy_id !== copy.id) {
          throw conflict(`Copy ${copy.barcode} is on hold for another member`, 'copy_on_hold');
        }
      } else if (copy.status !== 'available') {
        throw conflict(`Copy ${copy.barcode} is not available (status: ${copy.status})`, 'copy_unavailable');
      }

      if (ownReservation) {
        await conn.query("UPDATE reservations SET status = 'fulfilled', closed_at = ? WHERE id = ?", [now, ownReservation.id]);
        // They were holding a different copy: pass that one on.
        if (ownReservation.status === 'ready' && ownReservation.copy_id !== copy.id) {
          const held = await lockCopy(conn, { copyId: ownReservation.copy_id });
          await releaseCopy(conn, held, now);
        }
      }

      const dueAt = addDays(now, policy.loanDays);
      const [result] = await conn.query('INSERT INTO loans (copy_id, member_id, checked_out_at, due_at) VALUES (?, ?, ?, ?)', [
        copy.id,
        member.id,
        now,
        dueAt,
      ]);
      await conn.query("UPDATE copies SET status = 'on_loan' WHERE id = ?", [copy.id]);
      return {
        loanId: result.insertId,
        memberId: member.id,
        copyId: copy.id,
        barcode: copy.barcode,
        bookId: copy.book_id,
        title: copy.title,
        checkedOutAt: now,
        dueAt,
        fulfilledReservationId: ownReservation?.id || null,
      };
    });
  }

  async function checkin({ copyId, barcode }) {
    return withTransaction(pool, async (conn) => {
      const now = new Date();
      const copy = await lockCopy(conn, { copyId, barcode });
      const [[loan]] = await conn.query('SELECT * FROM loans WHERE copy_id = ? AND returned_at IS NULL FOR UPDATE', [copy.id]);
      if (!loan) throw conflict(`Copy ${copy.barcode} is not checked out`, 'not_on_loan');

      const fineCents = fineFor(loan.due_at, now, policy);
      await conn.query('UPDATE loans SET returned_at = ?, fine_cents = ?, fine_paid = ? WHERE id = ?', [now, fineCents, fineCents === 0 ? 1 : 0, loan.id]);
      const hold = await releaseCopy(conn, copy, now);
      return {
        loanId: loan.id,
        memberId: loan.member_id,
        copyId: copy.id,
        barcode: copy.barcode,
        title: copy.title,
        returnedAt: now,
        daysOverdue: daysOverdue(loan.due_at, now),
        fineCents,
        // Tells the desk to put the copy on the hold shelf instead of back in the stacks.
        heldFor: hold,
      };
    });
  }

  async function renew(loanId) {
    return withTransaction(pool, async (conn) => {
      const now = new Date();
      const [[loan]] = await conn.query(
        'SELECT l.*, c.book_id FROM loans l JOIN copies c ON c.id = l.copy_id WHERE l.id = ? FOR UPDATE',
        [loanId],
      );
      if (!loan) throw notFound(`Loan ${loanId} not found`);
      if (loan.returned_at) throw conflict('Loan has already been returned', 'loan_closed');
      if (loan.due_at < now) throw conflict('Overdue items cannot be renewed; please return it', 'overdue');
      if (loan.renewals >= policy.maxRenewals) throw conflict(`Renewal limit reached (${policy.maxRenewals})`, 'renewal_limit');

      const member = await lockMember(conn, loan.member_id);
      await assertInGoodStanding(conn, member);
      const [[{ waiting }]] = await conn.query("SELECT COUNT(*) AS waiting FROM reservations WHERE book_id = ? AND status = 'waiting'", [loan.book_id]);
      if (waiting > 0) throw conflict('Other members are waiting for this book, so it cannot be renewed', 'has_reservations');

      const dueAt = addDays(loan.due_at, policy.loanDays);
      await conn.query('UPDATE loans SET due_at = ?, renewals = renewals + 1, due_soon_notified = 0 WHERE id = ?', [dueAt, loan.id]);
      return { loanId: loan.id, dueAt, renewals: loan.renewals + 1, renewalsLeft: policy.maxRenewals - loan.renewals - 1 };
    });
  }

  async function reserve({ bookId, memberId }) {
    return withTransaction(pool, async (conn) => {
      const now = new Date();
      const member = await lockMember(conn, memberId);
      await assertInGoodStanding(conn, member);

      const [[book]] = await conn.query('SELECT * FROM books WHERE id = ?', [bookId]);
      if (!book) throw notFound(`Book ${bookId} not found`);

      const [[existing]] = await conn.query(
        "SELECT id FROM reservations WHERE book_id = ? AND member_id = ? AND status IN ('waiting','ready')",
        [book.id, member.id],
      );
      if (existing) throw conflict(`Member already has an active reservation (${existing.id}) for this book`, 'already_reserved');
      const [[borrowed]] = await conn.query(
        'SELECT l.id FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.book_id = ? AND l.member_id = ? AND l.returned_at IS NULL',
        [book.id, member.id],
      );
      if (borrowed) throw conflict('Member already has this book checked out', 'already_borrowed');

      // A copy on the shelf goes straight on hold for this member.
      const [[copy]] = await conn.query(
        "SELECT * FROM copies WHERE book_id = ? AND status = 'available' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [book.id],
      );
      if (copy) {
        const expiresAt = addDays(now, policy.holdDays);
        const [result] = await conn.query(
          "INSERT INTO reservations (book_id, member_id, copy_id, status, created_at, ready_at, expires_at) VALUES (?, ?, ?, 'ready', ?, ?, ?)",
          [book.id, member.id, copy.id, now, now, expiresAt],
        );
        await conn.query("UPDATE copies SET status = 'on_hold' WHERE id = ?", [copy.id]);
        await notify(conn, member, 'reservation_ready', { title: book.title, author: book.author, barcode: copy.barcode, expiresAt }, `res:${result.insertId}:ready`);
        return { reservationId: result.insertId, status: 'ready', copyId: copy.id, barcode: copy.barcode, expiresAt, position: 0 };
      }

      const [result] = await conn.query("INSERT INTO reservations (book_id, member_id, status, created_at) VALUES (?, ?, 'waiting', ?)", [
        book.id,
        member.id,
        now,
      ]);
      const [[{ position }]] = await conn.query(
        "SELECT COUNT(*) AS position FROM reservations WHERE book_id = ? AND status = 'waiting' AND id <= ?",
        [book.id, result.insertId],
      );
      await notify(conn, member, 'reservation_placed', { title: book.title, author: book.author, position }, `res:${result.insertId}:placed`);
      return { reservationId: result.insertId, status: 'waiting', position };
    });
  }

  async function cancelReservation(reservationId, { memberId } = {}) {
    return withTransaction(pool, async (conn) => {
      const [[res]] = await conn.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [reservationId]);
      if (!res || (memberId && res.member_id !== memberId)) throw notFound(`Reservation ${reservationId} not found`);
      if (!['waiting', 'ready'].includes(res.status)) throw conflict(`Reservation is already ${res.status}`, 'reservation_closed');

      await conn.query("UPDATE reservations SET status = 'cancelled', closed_at = ? WHERE id = ?", [new Date(), res.id]);
      let passedTo = null;
      if (res.status === 'ready') {
        const copy = await lockCopy(conn, { copyId: res.copy_id });
        passedTo = await releaseCopy(conn, copy);
      }
      return { reservationId: res.id, status: 'cancelled', passedTo };
    });
  }

  // Staff changing a copy's shelf status (lost, damaged/maintenance, found again).
  async function setCopyStatus(copyId, status) {
    if (!['available', 'lost', 'maintenance'].includes(status)) throw badRequest('status must be one of: available, lost, maintenance');
    return withTransaction(pool, async (conn) => {
      const copy = await lockCopy(conn, { copyId });
      if (copy.status === 'on_loan') throw conflict('Copy is checked out; check it in first', 'copy_on_loan');
      if (copy.status === status) return { copyId: copy.id, status };

      if (copy.status === 'on_hold') {
        // Pulling a held copy: put that member back at the front of the queue.
        await conn.query("UPDATE reservations SET status = 'waiting', copy_id = NULL, ready_at = NULL, expires_at = NULL WHERE copy_id = ? AND status = 'ready'", [copy.id]);
      }
      if (status === 'available') {
        const hold = await releaseCopy(conn, copy);
        return { copyId: copy.id, status: hold ? 'on_hold' : 'available', heldFor: hold };
      }
      await conn.query('UPDATE copies SET status = ? WHERE id = ?', [status, copy.id]);
      return { copyId: copy.id, status };
    });
  }

  // ---- Scheduled jobs --------------------------------------------------------------

  async function expireHolds(now = new Date()) {
    const [due] = await pool.query("SELECT id FROM reservations WHERE status = 'ready' AND expires_at <= ? ORDER BY expires_at", [now]);
    let expired = 0;
    for (const { id } of due) {
      const done = await withTransaction(pool, async (conn) => {
        const [[res]] = await conn.query("SELECT * FROM reservations WHERE id = ? AND status = 'ready' FOR UPDATE", [id]);
        if (!res) return false; // picked up or cancelled in the meantime
        await conn.query("UPDATE reservations SET status = 'expired', closed_at = ? WHERE id = ?", [now, res.id]);
        const copy = await lockCopy(conn, { copyId: res.copy_id });
        const [[member]] = await conn.query('SELECT * FROM members WHERE id = ?', [res.member_id]);
        await notify(conn, member, 'hold_expired', { title: copy.title, author: copy.author, expiresAt: res.expires_at }, `res:${res.id}:expired`);
        await releaseCopy(conn, copy, now);
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  async function sendDueSoonReminders(now = new Date()) {
    const [loans] = await pool.query(
      `SELECT l.id FROM loans l
        WHERE l.returned_at IS NULL AND l.due_soon_notified = 0 AND l.due_at > ? AND l.due_at <= ?`,
      [now, new Date(now.getTime() + reminders.dueSoonHours * 60 * 60 * 1000)],
    );
    let sent = 0;
    for (const { id } of loans) {
      const done = await withTransaction(pool, async (conn) => {
        const loan = await lockOpenLoanDetails(conn, id);
        if (!loan || loan.due_soon_notified) return false;
        const [[{ waiting }]] = await conn.query("SELECT COUNT(*) AS waiting FROM reservations WHERE book_id = ? AND status = 'waiting'", [loan.book_id]);
        await notify(conn, loan.member, 'due_soon', {
          title: loan.title,
          author: loan.author,
          dueAt: loan.due_at,
          canRenew: loan.renewals < policy.maxRenewals && waiting === 0,
        }, `loan:${loan.id}:due:${loan.due_at.getTime()}`);
        await conn.query('UPDATE loans SET due_soon_notified = 1 WHERE id = ?', [loan.id]);
        return true;
      });
      if (done) sent++;
    }
    return sent;
  }

  async function sendOverdueNotices(now = new Date()) {
    const repeatBefore = new Date(now.getTime() - reminders.overdueRepeatDays * DAY_MS);
    const [loans] = await pool.query(
      `SELECT id FROM loans
        WHERE returned_at IS NULL AND due_at < ? AND (last_overdue_notice IS NULL OR last_overdue_notice <= ?)`,
      [now, repeatBefore],
    );
    let sent = 0;
    for (const { id } of loans) {
      const done = await withTransaction(pool, async (conn) => {
        const loan = await lockOpenLoanDetails(conn, id);
        if (!loan || (loan.last_overdue_notice && loan.last_overdue_notice > repeatBefore)) return false;
        const notice = loan.overdue_notices + 1;
        await notify(conn, loan.member, 'overdue', {
          title: loan.title,
          author: loan.author,
          dueAt: loan.due_at,
          daysOverdue: daysOverdue(loan.due_at, now),
          fineCents: fineFor(loan.due_at, now, policy),
          finePerDayCents: policy.finePerDayCents,
          maxFineCents: policy.maxFineCents,
        }, `loan:${loan.id}:overdue:${notice}`);
        await conn.query('UPDATE loans SET overdue_notices = ?, last_overdue_notice = ? WHERE id = ?', [notice, now, loan.id]);
        return true;
      });
      if (done) sent++;
    }
    return sent;
  }

  async function lockOpenLoanDetails(conn, loanId) {
    const [[loan]] = await conn.query(
      `SELECT l.*, c.book_id, b.title, b.author FROM loans l
         JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
        WHERE l.id = ? AND l.returned_at IS NULL FOR UPDATE`,
      [loanId],
    );
    if (!loan) return null;
    const [[member]] = await conn.query('SELECT * FROM members WHERE id = ?', [loan.member_id]);
    return { ...loan, member };
  }

  async function runScheduledJobs(now = new Date()) {
    const expiredHolds = await expireHolds(now);
    const dueSoon = await sendDueSoonReminders(now);
    const overdue = await sendOverdueNotices(now);
    return { expiredHolds, dueSoon, overdue };
  }

  return {
    checkout,
    checkin,
    renew,
    reserve,
    cancelReservation,
    setCopyStatus,
    outstandingFines: (memberId) => outstandingFines(pool, memberId),
    expireHolds,
    sendDueSoonReminders,
    sendOverdueNotices,
    runScheduledJobs,
  };
}

module.exports = { createCirculation };
