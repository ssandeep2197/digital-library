const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validate');
const { daysOverdue, fineFor, addDays } = require('../src/policy');
const { render, types } = require('../src/notify/templates');
const { createSmsTransport } = require('../src/notify/transports');

const quiet = { info() {}, warn() {}, error() {} };

test('isbn accepts valid ISBN-10/13 with formatting and rejects bad checksums', () => {
  assert.equal(v.isbn('978-0-13-235088-4'), '9780132350884');
  assert.equal(v.isbn('0-306-40615-2'), '0306406152');
  assert.equal(v.isbn('080442957x'), '080442957X');
  assert.equal(v.isbn(''), null);
  assert.throws(() => v.isbn('978-0-13-235088-5'), /not a valid ISBN/);
  assert.throws(() => v.isbn('12345'), /not a valid ISBN/);
});

test('phone normalizes to E.164', () => {
  assert.equal(v.phone('+1 (555) 010-0000'), '+15550100000');
  assert.throws(() => v.phone('555-0100'), /international format/);
});

test('int, bool, email and paging validation', () => {
  assert.equal(v.int('42', 'n'), 42);
  assert.throws(() => v.int('4.2', 'n'), /integer/);
  assert.throws(() => v.id('0', 'id'), /between/);
  assert.equal(v.bool('false', 'b'), false);
  assert.throws(() => v.bool('yes', 'b'), /true or false/);
  assert.equal(v.email(' Ada@Example.COM '), 'ada@example.com');
  assert.throws(() => v.email('nope'), /valid email/);
  assert.deepEqual(v.paging({ page: '3', limit: '10' }), { page: 3, limit: 10, offset: 20 });
  assert.throws(() => v.paging({ limit: '1000' }), /between/);
});

test('fines count started days late and are capped', () => {
  const due = new Date('2026-01-10T12:00:00Z');
  const policy = { finePerDayCents: 25, maxFineCents: 1000 };
  assert.equal(daysOverdue(due, new Date('2026-01-10T11:00:00Z')), 0);
  assert.equal(daysOverdue(due, new Date('2026-01-10T12:00:01Z')), 1);
  assert.equal(fineFor(due, addDays(due, 3), policy), 75);
  assert.equal(fineFor(due, addDays(due, 365), policy), 1000);
});

test('every template renders email and a short SMS', () => {
  const data = {
    library: 'Test Library', memberName: 'Ada', title: 'A <Very> Long Book Title That Goes On And On For Quite A While', author: 'X',
    dueAt: new Date('2026-02-01T00:00:00Z'), expiresAt: new Date('2026-02-03T00:00:00Z'), position: 2, daysOverdue: 4,
    fineCents: 100, finePerDayCents: 25, maxFineCents: 1000, canRenew: true, barcode: 'B1',
  };
  for (const type of types) {
    const m = render(type, data);
    assert.ok(m.subject && m.text.includes('Hi Ada'), type);
    assert.ok(m.sms.length <= 160, `${type} sms is ${m.sms.length} chars`);
    assert.ok(!m.html.includes('<Very>'), 'html is escaped');
  }
  assert.throws(() => render('nope', data), /Unknown notification type/);
});

test('twilio transport classifies errors as permanent or transient', async () => {
  const config = { twilio: { accountSid: 'AC1', authToken: 't', from: '+15550000000' } };
  const reply = (status, body) => async () => ({ ok: status < 300, status, statusText: 'x', json: async () => body });

  const ok = createSmsTransport(config, quiet, reply(201, { sid: 'SM123' }));
  assert.deepEqual(await ok.send({ to: '+15551112222', body: 'hi' }), { providerId: 'SM123' });

  const invalid = createSmsTransport(config, quiet, reply(400, { code: 21211, message: 'Invalid To' }));
  await assert.rejects(invalid.send({ to: '+1', body: 'hi' }), (err) => err.permanent === true && /21211/.test(err.message));

  const throttled = createSmsTransport(config, quiet, reply(429, { message: 'Too many' }));
  await assert.rejects(throttled.send({ to: '+1', body: 'hi' }), (err) => err.permanent === false);

  const network = createSmsTransport(config, quiet, async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(network.send({ to: '+1', body: 'hi' }), (err) => err.permanent === false);

  assert.equal(createSmsTransport({ twilio: {} }, quiet).mode, 'simulated');
});
