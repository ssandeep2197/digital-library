const crypto = require('crypto');

// Express 4 doesn't catch rejected promises from handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireApiKey(apiKey) {
  const expected = apiKey && crypto.createHash('sha256').update(apiKey).digest();
  return (req, res, next) => {
    if (!apiKey) return next(); // development mode, see server.js
    const given = crypto.createHash('sha256').update(req.get('x-api-key') || '').digest();
    if (crypto.timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or invalid X-API-Key header' } });
  };
}

module.exports = { wrap, requireApiKey };
