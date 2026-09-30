// Integration test harness: a throwaway MySQL database plus the app on a random port.
// Point it at a server with TEST_DB_HOST/PORT/USER/PASSWORD (defaults match docker-compose).
const mysql = require('mysql2/promise');
const baseConfig = require('../src/config');
const { createPool, migrate } = require('../src/db');
const { createApp, createServices } = require('../src/app');
const { Dispatcher } = require('../src/notify/dispatcher');

const quiet = { info() {}, warn() {}, error() {} };

const server = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3307),
  user: process.env.TEST_DB_USER || 'root',
  password: process.env.TEST_DB_PASSWORD || 'rootpass',
};

async function databaseAvailable() {
  try {
    const conn = await mysql.createConnection({ ...server, connectTimeout: 2000 });
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

async function startTestApp(t, { policy = {}, admin = { user: 'staff', password: 'test-pass' }, email, sms } = {}) {
  const database = `digital_library_test_${process.pid}`;
  const root = await mysql.createConnection(server);
  await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await root.query(`CREATE DATABASE \`${database}\``);

  const config = {
    ...baseConfig,
    admin,
    jwtSecret: 'test-secret-that-is-at-least-32-characters',
    baseUrl: 'http://localhost',
    libraryName: 'Test Library',
    db: { ...server, database, connectionLimit: 10 },
    policy: { ...baseConfig.policy, loanDays: 14, maxLoans: 5, maxRenewals: 2, holdDays: 3, finePerDayCents: 25, maxFineCents: 1000, blockAtFineCents: 500, ...policy },
    reminders: { dueSoonHours: 24, overdueRepeatDays: 3 },
    dispatcher: { intervalMs: 1000, batchSize: 50, maxAttempts: 3, backoffMs: 0 },
  };
  const pool = createPool(config.db);
  await migrate(pool);

  const sent = [];
  const record = (channel) => ({ mode: 'test', send: async (msg) => { sent.push({ channel, ...msg }); return { providerId: `${channel}-${sent.length}` }; } });
  const dispatcher = new Dispatcher({ pool, email: email || record('email'), sms: sms || record('sms'), options: config.dispatcher, log: quiet });
  const services = createServices({ pool, config, log: quiet });
  const app = createApp({ pool, config, services, dispatcher, log: quiet });
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => http.close(resolve));
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await root.end();
  });

  // Signs in once; api() sends that session cookie unless called with { cookie: null } (or another cookie).
  let session = null;
  async function login(username = admin.user, password = admin.password) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { status: res.status, body: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  }
  if (admin.user) session = (await login()).cookie;

  async function api(method, path, body, { cookie = session, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  // Convenience: create a book with n copies (barcodes <prefix>-1..n).
  async function book(title, copies = 1, extra = {}) {
    const b = await api('POST', '/api/books', { title, author: 'Test Author', ...extra });
    if (b.status !== 201) throw new Error(JSON.stringify(b.body));
    const barcodes = [];
    for (let i = 1; i <= copies; i++) {
      const barcode = `${title.replace(/\W/g, '').slice(0, 10).toUpperCase()}-${b.body.id}-${i}`;
      await api('POST', `/api/books/${b.body.id}/copies`, { barcode });
      barcodes.push(barcode);
    }
    return { ...b.body, barcodes };
  }

  let memberSeq = 0;
  async function member(fields = {}) {
    memberSeq++;
    const m = await api('POST', '/api/members', { name: `Member ${memberSeq}`, email: `m${memberSeq}@example.com`, ...fields });
    if (m.status !== 201) throw new Error(JSON.stringify(m.body));
    return m.body;
  }

  return { api, base, login, session, book, member, pool, services, dispatcher, sent, config };
}

module.exports = { databaseAvailable, startTestApp };
