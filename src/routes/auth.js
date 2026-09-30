const path = require('path');
const express = require('express');
const { createLoginLimiter, safeNext, unauthorized } = require('../auth');

const LOGIN_PAGE = path.join(__dirname, '..', '..', 'public', 'login.html');

// Login page and session endpoints. Mounted before requireAuth, so these are public.
function authRoutes(auth, log = console) {
  const router = express.Router();
  const limiter = createLoginLimiter();

  router.get('/login', (req, res) => {
    if (!auth.enabled || auth.currentUser(req)) return res.redirect(safeNext(req.query.next));
    res.sendFile(LOGIN_PAGE);
  });

  router.post('/api/auth/login', (req, res) => {
    const key = req.ip;
    if (limiter.blocked(key)) {
      const wait = limiter.retryAfterSec(key);
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: { code: 'too_many_attempts', message: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` } });
    }

    const { username, password, next } = req.body || {};
    if (!auth.checkCredentials(username, password)) {
      limiter.fail(key);
      log.warn(`[auth] failed login for "${String(username).slice(0, 64)}" from ${key}`);
      return res.status(401).json(unauthorized('Incorrect username or password'));
    }

    limiter.reset(key);
    auth.signIn(res);
    res.json({ ok: true, next: safeNext(next) });
  });

  router.post('/api/auth/logout', (req, res) => {
    auth.signOut(res);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { authRoutes };
