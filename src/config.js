require('dotenv').config();

const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const port = num(process.env.PORT, 3000);

module.exports = {
  port,
  production: process.env.NODE_ENV === 'production',
  trustProxy: process.env.TRUST_PROXY || false,
  // Staff endpoints (inventory, circulation, members) require this key in the X-API-Key header.
  apiKey: process.env.API_KEY || '',
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  libraryName: process.env.LIBRARY_NAME || 'Digital Library',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'library',
    password: process.env.DB_PASSWORD || 'library',
    database: process.env.DB_NAME || 'digital_library',
    connectionLimit: num(process.env.DB_POOL_SIZE, 10),
  },
  policy: {
    loanDays: num(process.env.LOAN_DAYS, 14),
    maxLoans: num(process.env.MAX_LOANS, 5),
    maxRenewals: num(process.env.MAX_RENEWALS, 2),
    holdDays: num(process.env.HOLD_DAYS, 3),
    finePerDayCents: num(process.env.FINE_PER_DAY_CENTS, 25),
    maxFineCents: num(process.env.MAX_FINE_CENTS, 1000),
    // Members owing this much or more cannot borrow or reserve.
    blockAtFineCents: num(process.env.BLOCK_AT_FINE_CENTS, 500),
  },
  reminders: {
    dueSoonHours: num(process.env.DUE_SOON_HOURS, 24),
    overdueRepeatDays: num(process.env.OVERDUE_REPEAT_DAYS, 3),
  },
  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED !== 'false',
    intervalMs: num(process.env.SCHEDULER_INTERVAL_SECONDS, 300) * 1000,
  },
  dispatcher: {
    intervalMs: num(process.env.DISPATCH_INTERVAL_SECONDS, 5) * 1000,
    batchSize: num(process.env.DISPATCH_BATCH_SIZE, 25),
    maxAttempts: num(process.env.DISPATCH_MAX_ATTEMPTS, 5),
    backoffMs: num(process.env.DISPATCH_BACKOFF_SECONDS, 60) * 1000,
  },
  mailFrom: process.env.MAIL_FROM || 'Digital Library <no-reply@example.com>',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },
};
