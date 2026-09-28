const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseAvailable, startTestApp } = require('./helpers');
const { DeliveryError } = require('../src/notify/transports');

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY);

test('integration', { concurrency: false }, async (t) => {
  if (!(await databaseAvailable())) {
    t.skip('MySQL not reachable (run `docker compose up -d mysql` or set TEST_DB_*)');
    return;
  }

  await t.test('catalog: public reads, staff-only writes, validation, search', async (t) => {
    const { api, book } = await startTestApp(t);

    assert.equal((await api('POST', '/api/books', { title: 'X', author: 'Y' }, { key: null })).status, 401);
    assert.equal((await api('POST', '/api/books', { title: 'X', author: 'Y' }, { key: 'wrong' })).status, 401);
    assert.equal((await api('POST', '/api/books', { author: 'Y' })).status, 400);
    assert.equal((await api('POST', '/api/books', { title: 'X', author: 'Y', isbn: '123' })).status, 400);

    const clean = await book('Clean Code', 2, { isbn: '978-0-13-235088-4', genre: 'Software' });
    await book('Dune', 1, { genre: 'Fiction' });
    assert.equal((await api('POST', '/api/books', { title: 'Dup', author: 'Y', isbn: '9780132350884' })).status, 409);
    assert.equal((await api('POST', `/api/books/${clean.id}/copies`, { barcode: clean.barcodes[0] })).status, 409);

    const pub = await api('GET', '/api/books?q=clean', undefined, { key: null });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.total, 1);
    assert.equal(pub.body.items[0].availableCopies, 2);
    assert.equal((await api('GET', '/api/books?q=9780132350884')).body.items[0].id, clean.id);
    assert.equal((await api('GET', '/api/books?genre=Fiction')).body.items[0].title, 'Dune');
    assert.equal((await api('GET', '/api/books?q=100%25')).body.total, 0, 'LIKE wildcards are escaped');

    const patched = await api('PATCH', `/api/books/${clean.id}`, { publishedYear: 2008 });
    assert.equal(patched.body.publishedYear, 2008);
    assert.equal(patched.body.title, 'Clean Code');
    assert.equal((await api('DELETE', `/api/books/${clean.id}`)).status, 409, 'cannot delete a book with copies');
    assert.equal((await api('GET', '/api/books/9999')).status, 404);
    assert.equal((await api('GET', '/api/nope')).status, 404);

    const info = await api('GET', '/api/info', undefined, { key: null });
    assert.deepEqual([info.status, info.body.authRequired, info.body.policy.loanDays], [200, true, 14]);
  });

  await t.test('serves the staff dashboard', async (t) => {
    const { base } = await startTestApp(t);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<script src="\/js\/app.js">/);
    assert.equal((await fetch(`${base}/js/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/css/app.css`)).status, 200);
  });

  await t.test('checkout and return update availability and charge late fines', async (t) => {
    const { api, book, member, pool } = await startTestApp(t);
    const b = await book('Refactoring', 2);
    const ada = await member();
    const bob = await member();

    const loan = await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[0] });
    assert.equal(loan.status, 201);
    assert.ok(Math.abs(new Date(loan.body.dueAt) - inDays(14)) < 60000);
    assert.equal((await api('POST', '/api/loans', { memberId: bob.id, barcode: b.barcodes[0] })).body.error.code, 'copy_unavailable');

    let avail = (await api('GET', `/api/books/${b.id}/availability`)).body;
    assert.deepEqual([avail.available, avail.copies.available, avail.copies.on_loan], [true, 1, 1]);
    assert.ok(avail.nextDueAt);

    // Returned 3 days late.
    await pool.query('UPDATE loans SET due_at = ? WHERE id = ?', [inDays(-2.5), loan.body.loanId]);
    const ret = await api('POST', '/api/returns', { barcode: b.barcodes[0] });
    assert.equal(ret.status, 200);
    assert.deepEqual([ret.body.daysOverdue, ret.body.fineCents, ret.body.heldFor], [3, 75, null]);
    assert.equal((await api('POST', '/api/returns', { barcode: b.barcodes[0] })).body.error.code, 'not_on_loan');

    avail = (await api('GET', `/api/books/${b.id}/availability`)).body;
    assert.equal(avail.copies.available, 2);

    const account = (await api('GET', `/api/members/${ada.id}/account`)).body;
    assert.equal(account.fines.unpaidCents, 75);
    assert.equal(account.loans.length, 0);
    assert.equal((await api('POST', `/api/members/${ada.id}/fines/pay`)).body.outstandingCents, 0);
    assert.equal((await api('GET', `/api/members/${ada.id}/history`)).body.items[0].finePaid, true);
  });

  await t.test('reservation queue: FIFO holds, pickup, renew blocked, notifications', async (t) => {
    const { api, book, member, dispatcher, sent } = await startTestApp(t);
    const b = await book('Popular Book', 1);
    const [ada, bob, cy] = [await member(), await member({ phone: '+15550001111' }), await member()];

    const loan = (await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[0] })).body;
    const rb = await api('POST', '/api/reservations', { bookId: b.id, memberId: bob.id });
    const rc = await api('POST', '/api/reservations', { bookId: b.id, memberId: cy.id });
    assert.deepEqual([rb.body.status, rb.body.position, rc.body.position], ['waiting', 1, 2]);
    assert.equal((await api('POST', '/api/reservations', { bookId: b.id, memberId: bob.id })).body.error.code, 'already_reserved');
    assert.equal((await api('POST', '/api/reservations', { bookId: b.id, memberId: ada.id })).body.error.code, 'already_borrowed');
    assert.equal((await api('POST', `/api/loans/${loan.loanId}/renew`)).body.error.code, 'has_reservations');

    const ret = (await api('POST', '/api/returns', { barcode: b.barcodes[0] })).body;
    assert.equal(ret.heldFor.memberId, bob.id);
    assert.equal((await api('POST', '/api/loans', { memberId: cy.id, barcode: b.barcodes[0] })).body.error.code, 'copy_on_hold');

    const queue = (await api('GET', `/api/books/${b.id}/reservations`)).body.items;
    assert.deepEqual(queue.map((r) => [r.memberId, r.status, r.position]), [[bob.id, 'ready', 0], [cy.id, 'waiting', 1]]);

    const pickup = await api('POST', '/api/loans', { memberId: bob.id, barcode: b.barcodes[0] });
    assert.equal(pickup.status, 201);
    assert.equal(pickup.body.fulfilledReservationId, rb.body.reservationId);
    assert.equal((await api('GET', `/api/members/${cy.id}/account`)).body.reservations[0].position, 1);

    await dispatcher.tick();
    const summary = sent.map((m) => `${m.channel}:${m.to}:${(m.subject || m.body).split(':')[0]}`);
    assert.deepEqual(summary.sort(), [
      `email:${bob.email}:Ready for pickup`,
      `email:${bob.email}:Reservation confirmed`,
      `email:${cy.email}:Reservation confirmed`,
      'sms:+15550001111:Test Library',
      'sms:+15550001111:Test Library',
    ].sort());
    assert.ok(sent.find((m) => m.channel === 'sms' && /ready for pickup/.test(m.body)));
  });

  await t.test('reserving a book on the shelf places an immediate hold', async (t) => {
    const { api, book, member } = await startTestApp(t);
    const b = await book('Shelf Book', 1);
    const ada = await member();
    const r = await api('POST', '/api/reservations', { bookId: b.id, memberId: ada.id });
    assert.deepEqual([r.body.status, r.body.barcode], ['ready', b.barcodes[0]]);
    const avail = (await api('GET', `/api/books/${b.id}/availability`)).body;
    assert.deepEqual([avail.available, avail.copies.on_hold], [false, 1]);
  });

  await t.test('uncollected holds expire and pass to the next member; cancelling does too', async (t) => {
    const { api, book, member, services, pool } = await startTestApp(t);
    const b = await book('Held Book', 1);
    const [ada, bob, cy] = [await member(), await member(), await member()];
    const ra = (await api('POST', '/api/reservations', { bookId: b.id, memberId: ada.id })).body;
    await api('POST', '/api/reservations', { bookId: b.id, memberId: bob.id });
    const rc = (await api('POST', '/api/reservations', { bookId: b.id, memberId: cy.id })).body;

    assert.equal(await services.circulation.expireHolds(inDays(1)), 0);
    assert.equal(await services.circulation.expireHolds(inDays(3.1)), 1);
    let queue = (await api('GET', `/api/books/${b.id}/reservations`)).body.items;
    assert.deepEqual(queue.map((r) => [r.memberId, r.status]), [[bob.id, 'ready'], [cy.id, 'waiting']]);
    const [[expired]] = await pool.query('SELECT status FROM reservations WHERE id = ?', [ra.reservationId]);
    assert.equal(expired.status, 'expired');

    const bobRes = queue[0].reservationId;
    const cancel = await api('DELETE', `/api/reservations/${bobRes}`);
    assert.equal(cancel.body.passedTo.memberId, cy.id);
    assert.equal((await api('DELETE', `/api/reservations/${bobRes}`)).body.error.code, 'reservation_closed');

    await api('DELETE', `/api/reservations/${rc.reservationId}`);
    assert.equal((await api('GET', `/api/books/${b.id}/availability`)).body.copies.available, 1);

    const [types] = await pool.query('SELECT type, COUNT(*) AS n FROM notifications GROUP BY type ORDER BY type');
    assert.deepEqual(types.map((r) => `${r.type}=${r.n}`), ['hold_expired=1', 'reservation_placed=2', 'reservation_ready=3']);
  });

  await t.test('due-soon reminders and overdue notices are sent once per period', async (t) => {
    const { api, book, member, services, pool, dispatcher, sent } = await startTestApp(t);
    const b = await book('Reminder Book', 2);
    const ada = await member({ phone: '+15550002222', notifySms: true });
    const bob = await member({ notifyEmail: false, phone: '+15550003333', notifySms: true });
    const l1 = (await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[0] })).body;
    const l2 = (await api('POST', '/api/loans', { memberId: bob.id, barcode: b.barcodes[1] })).body;
    const c = services.circulation;

    await pool.query('UPDATE loans SET due_at = ? WHERE id = ?', [inDays(-1.5), l2.loanId]);
    await pool.query('UPDATE loans SET due_at = ? WHERE id = ?', [inDays(0.5), l1.loanId]);
    assert.equal(await c.sendDueSoonReminders(), 1);
    assert.equal(await c.sendDueSoonReminders(), 0);

    // After renewing, a new due date gets its own reminder.
    await api('POST', `/api/loans/${l1.loanId}/renew`);
    assert.equal(await c.sendDueSoonReminders(inDays(14)), 1);

    assert.equal(await c.sendOverdueNotices(), 1);
    assert.equal(await c.sendOverdueNotices(), 0);
    assert.equal(await c.sendOverdueNotices(inDays(2)), 0);
    assert.equal(await c.sendOverdueNotices(inDays(3.01)), 1);

    await dispatcher.tick();
    assert.equal(sent.filter((m) => m.to === ada.email).length, 2);
    assert.equal(sent.filter((m) => m.to === '+15550002222').length, 2);
    const bobMsgs = sent.filter((m) => m.to === '+15550003333');
    assert.equal(bobMsgs.length, 2, 'bob opted out of email, gets SMS only');
    assert.match(bobMsgs[0].body, /2d overdue\. Fine so far \$0\.50/);
    assert.equal(sent.filter((m) => m.to === bob.email).length, 0);

    const account = (await api('GET', `/api/members/${bob.id}/account`)).body;
    assert.equal(account.loans[0].overdue, true);
    assert.equal(account.fines.accruingCents, 50);
    assert.equal((await api('POST', `/api/loans/${l2.loanId}/renew`)).body.error.code, 'overdue');

    const overdueList = (await api('GET', '/api/loans?status=overdue')).body.items;
    assert.deepEqual(overdueList.map((l) => l.loanId), [l2.loanId]);

    const jobs = (await api('POST', '/api/jobs/run')).body;
    assert.deepEqual(jobs, { expiredHolds: 0, dueSoon: 0, overdue: 0, notificationsDispatched: 0 });
  });

  await t.test('borrowing limits: loan cap, fines, suspension, renewal cap', async (t) => {
    const { api, book, member, pool } = await startTestApp(t, { policy: { maxLoans: 2, maxRenewals: 1 } });
    const b = await book('Limits', 4);
    const ada = await member();
    const l = (await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[0] })).body;
    await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[1] });
    assert.equal((await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[2] })).body.error.code, 'loan_limit');

    assert.equal((await api('POST', `/api/loans/${l.loanId}/renew`)).body.renewalsLeft, 0);
    assert.equal((await api('POST', `/api/loans/${l.loanId}/renew`)).body.error.code, 'renewal_limit');

    const bob = await member();
    const lb = (await api('POST', '/api/loans', { memberId: bob.id, barcode: b.barcodes[2] })).body;
    await pool.query('UPDATE loans SET due_at = ? WHERE id = ?', [inDays(-21), lb.loanId]);
    await api('POST', '/api/returns', { barcode: b.barcodes[2] });
    assert.equal((await api('POST', '/api/loans', { memberId: bob.id, barcode: b.barcodes[3] })).body.error.code, 'fines_owed');
    assert.equal((await api('POST', '/api/reservations', { bookId: b.id, memberId: bob.id })).body.error.code, 'fines_owed');
    await api('POST', `/api/members/${bob.id}/fines/pay`);
    assert.equal((await api('POST', '/api/loans', { memberId: bob.id, barcode: b.barcodes[3] })).status, 201);

    const cy = await member();
    await api('PATCH', `/api/members/${cy.id}`, { status: 'suspended' });
    assert.equal((await api('POST', '/api/loans', { memberId: cy.id, barcode: b.barcodes[2] })).body.error.code, 'member_suspended');
  });

  await t.test('members: validation, SMS opt-in requires a phone, duplicates', async (t) => {
    const { api, member } = await startTestApp(t);
    assert.equal((await api('POST', '/api/members', { name: 'X', email: 'bad' })).status, 400);
    assert.equal((await api('POST', '/api/members', { name: 'X', email: 'x@example.com', notifySms: true })).status, 400);
    const m = await member({ phone: '+44 20 7946 0958' });
    assert.deepEqual([m.phone, m.notifySms, m.notifyEmail], ['+442079460958', true, true]);
    assert.equal((await api('POST', '/api/members', { name: 'Y', email: m.email.toUpperCase() })).status, 409);
    assert.equal((await api('PATCH', `/api/members/${m.id}`, { phone: null })).body.error.code, 'phone_required');
    const off = await api('PATCH', `/api/members/${m.id}`, { phone: null, notifySms: false });
    assert.deepEqual([off.body.phone, off.body.notifySms], [null, false]);
    assert.equal((await api('GET', '/api/members?q=Member')).body.total, 1);
  });

  await t.test('dispatcher retries transient failures and stops on permanent ones', async (t) => {
    let calls = 0;
    const flaky = { mode: 'test', send: async () => { calls++; if (calls < 3) throw new DeliveryError('421 try later'); return { providerId: 'ok' }; } };
    const rejecting = { mode: 'test', send: async () => { throw new DeliveryError('Twilio 400 (21211): invalid', { permanent: true }); } };
    const { api, book, member, dispatcher, pool } = await startTestApp(t, { email: flaky, sms: rejecting });
    const b = await book('Notify', 1);
    const ada = await member({ phone: '+15550004444' });
    await api('POST', '/api/reservations', { bookId: b.id, memberId: ada.id });

    for (let i = 0; i < 4; i++) await dispatcher.tick();
    const [rows] = await pool.query('SELECT id, channel, status, attempts, last_error FROM notifications ORDER BY channel');
    assert.deepEqual(rows.map((r) => [r.channel, r.status, r.attempts]), [['email', 'sent', 3], ['sms', 'failed', 1]]);

    const failed = (await api('GET', '/api/notifications?status=failed')).body.items;
    assert.equal(failed.length, 1);
    assert.match(failed[0].lastError, /21211/);
    assert.equal((await api('POST', `/api/notifications/${failed[0].id}/retry`)).body.status, 'pending');
    assert.equal((await api('POST', `/api/notifications/${rows[0].id}/retry`)).body.error.code, 'not_failed');
    assert.equal((await api('GET', `/api/members/${ada.id}/notifications`)).body.items.length, 2);
  });

  await t.test('copy status changes: lost, maintenance on a held copy re-queues the member', async (t) => {
    const { api, book, member } = await startTestApp(t);
    const b = await book('Fragile', 1);
    const ada = await member();
    const copyId = (await api('GET', `/api/books/${b.id}/copies`)).body.items[0].id;
    await api('POST', '/api/reservations', { bookId: b.id, memberId: ada.id });

    assert.equal((await api('PATCH', `/api/copies/${copyId}`, { status: 'maintenance', location: 'Repair desk' })).body.status, 'maintenance');
    assert.equal((await api('GET', `/api/members/${ada.id}/account`)).body.reservations[0].status, 'waiting');

    const back = await api('PATCH', `/api/copies/${copyId}`, { status: 'available' });
    assert.deepEqual([back.body.status, back.body.heldFor.memberId, back.body.location], ['on_hold', ada.id, 'Repair desk']);
    assert.equal((await api('PATCH', `/api/copies/${copyId}`, { status: 'on_loan' })).status, 400);

    await api('POST', '/api/loans', { memberId: ada.id, barcode: b.barcodes[0] });
    assert.equal((await api('PATCH', `/api/copies/${copyId}`, { status: 'lost' })).body.error.code, 'copy_on_loan');
  });

  await t.test('concurrent checkouts of the same copy: exactly one wins', async (t) => {
    const { api, book, member } = await startTestApp(t);
    const b = await book('Race', 1);
    const members = await Promise.all(Array.from({ length: 8 }, () => member()));
    const results = await Promise.all(members.map((m) => api('POST', '/api/loans', { memberId: m.id, barcode: b.barcodes[0] })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'copy_unavailable'));
  });
});
