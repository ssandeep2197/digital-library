const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Serves an HTML page with a content fingerprint on each local script/stylesheet
// (/js/app.js → /js/app.js?v=3f2a9c1d). The page itself is never cached, so browsers
// always pick up new assets after a deploy while the assets can be cached for a long time.
function sendPage(res, file) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replace(
    /(src|href)="\/((?:js|css)\/[^"?]+)"/g,
    (match, attr, asset) => `${attr}="/${asset}?v=${fingerprint(asset)}"`,
  );
  res.set('Cache-Control', 'no-cache').type('html').send(html);
}

function fingerprint(asset) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, asset))).digest('hex').slice(0, 10);
  } catch {
    return '0';
  }
}

// Fingerprinted asset URLs never change content, so they can be cached for a year;
// anything else must be revalidated.
function staticCacheHeaders(req, res, next) {
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
}

module.exports = { PUBLIC_DIR, sendPage, staticCacheHeaders };
