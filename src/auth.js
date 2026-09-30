const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE = 'dl_session';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const unauthorized = (message) => ({ error: { code: 'unauthorized', message } });

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const originHost = (origin) => {
  try {
    return new URL(origin).host;
  } catch {
    return null; // e.g. "null" from sandboxed frames: treat as cross-site
  }
};

// Only allow redirects back into this app after login (no //evil.com or absolute URLs).
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

// Fixed-window limiter for failed logins, keyed by client IP.
function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const entry = (key) => {
    const e = failures.get(key);
    if (e && Date.now() - e.first < windowMs) return e;
    const fresh = { count: 0, first: Date.now() };
    failures.set(key, fresh);
    return fresh;
  };
  return {
    blocked: (key) => entry(key).count >= max,
    retryAfterSec: (key) => Math.ceil((entry(key).first + windowMs - Date.now()) / 1000),
    fail: (key) => { entry(key).count++; },
    reset: (key) => failures.delete(key),
  };
}

// JWT session auth. The token lives in an httpOnly cookie (not readable by page scripts)
// and carries a fingerprint of the current credentials, so changing ADMIN_PASSWORD signs
// every existing session out. With no credentials configured (local development) auth is off.
function createAuth({ user, password, secret, ttlHours, secureCookie }) {
  const enabled = Boolean(user && password);
  const signingSecret = secret || crypto.randomBytes(32).toString('hex');
  const credVersion = crypto.createHmac('sha256', signingSecret).update(`${user}\n${password}`).digest('base64url').slice(0, 16);
  const ttlSeconds = Math.round(ttlHours * 3600);
  const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/' };

  function checkCredentials(u, p) {
    // Evaluate both comparisons so timing doesn't reveal which one was wrong.
    const userOk = sameSecret(u || '', user);
    const passOk = sameSecret(p || '', password);
    return userOk && passOk;
  }

  function signIn(res) {
    const token = jwt.sign({ sub: user, cv: credVersion }, signingSecret, { algorithm: 'HS256', expiresIn: ttlSeconds });
    res.cookie(COOKIE, token, { ...cookieOptions, maxAge: ttlSeconds * 1000 });
  }

  function signOut(res) {
    res.clearCookie(COOKIE, cookieOptions);
  }

  // The session's username, or null if missing, expired, tampered with or issued for old credentials.
  function currentUser(req) {
    if (!enabled) return null;
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    try {
      const payload = jwt.verify(token, signingSecret, { algorithms: ['HS256'] });
      return payload.cv === credVersion ? payload.sub : null;
    } catch {
      return null;
    }
  }

  function requireAuth(req, res, next) {
    if (!enabled) return next();

    const username = currentUser(req);
    if (!username) {
      if (req.path.startsWith('/api/')) return res.status(401).json(unauthorized('Your session has expired. Please sign in again.'));
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }

    // Cookie auth needs CSRF protection: reject state-changing requests sent from other sites.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && originHost(origin) !== req.get('host')) {
        return res.status(403).json({ error: { code: 'cross_site', message: 'Cross-site request blocked' } });
      }
    }

    req.user = username;
    next();
  }

  return { enabled, checkCredentials, signIn, signOut, currentUser, requireAuth };
}

module.exports = { createAuth, createLoginLimiter, safeNext, readCookie, COOKIE, unauthorized };
