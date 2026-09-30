const path = require('path');
const express = require('express');
const { HttpError } = require('./errors');
const { createAuth } = require('./auth');
const { authRoutes } = require('./routes/auth');
const { catalogReadRoutes, inventoryRoutes } = require('./routes/catalog');
const { memberRoutes } = require('./routes/members');
const { circulationRoutes } = require('./routes/circulation');
const { createCatalog } = require('./services/catalog');
const { createMembers } = require('./services/members');
const { createCirculation } = require('./services/circulation');

function createServices({ pool, config, log }) {
  const circulation = createCirculation({ pool, config, log });
  const catalog = createCatalog({ pool });
  const members = createMembers({ pool, config, circulation });
  return { circulation, catalog, members };
}

function createApp({ pool, config, services, dispatcher, notifyModes = {}, log = console }) {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  // Runs the scheduled jobs, then flushes the outbox so notifications go out right away.
  const runJobs = async () => {
    const result = await services.circulation.runScheduledJobs();
    if (dispatcher) result.notificationsDispatched = await dispatcher.tick();
    return result;
  };

  const auth = createAuth({
    user: config.admin.user,
    password: config.admin.password,
    secret: config.jwtSecret,
    ttlHours: config.sessionTtlHours,
    secureCookie: config.baseUrl.startsWith('https://'),
  });

  // Public: static assets (the login page needs its CSS/JS; the dashboard's JS holds no data),
  // the login flow, and the library's name for the login screen.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { index: false, maxAge: config.production ? '1h' : 0 }));
  app.use(authRoutes(auth, log));
  app.get('/api/info', (req, res) => {
    const user = auth.currentUser(req);
    const info = { libraryName: config.libraryName, authEnabled: auth.enabled };
    if (!auth.enabled || user) {
      const { loanDays, maxLoans, maxRenewals, holdDays, finePerDayCents, maxFineCents } = config.policy;
      Object.assign(info, {
        user,
        email: notifyModes.email || null,
        sms: notifyModes.sms || null,
        policy: { loanDays, maxLoans, maxRenewals, holdDays, finePerDayCents, maxFineCents },
      });
    }
    res.json(info);
  });

  // Everything below requires a signed-in session.
  app.use(auth.requireAuth);
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use('/api', catalogReadRoutes(services));
  app.use('/api', inventoryRoutes(services));
  app.use('/api', memberRoutes(services));
  app.use('/api', circulationRoutes({ pool, ...services, runJobs }));

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    log.error(`[api] ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  });

  return app;
}

module.exports = { createApp, createServices };
