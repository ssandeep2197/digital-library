// Express 4 doesn't catch rejected promises from handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { wrap };
