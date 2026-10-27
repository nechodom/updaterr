// Odpovědi HTTP API: JSON s kompresí a ETagem, kandidáti bez tajných odkazů
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// JSON se komprimuje (gzip, ~5× menší) a dostává ETag: web se ptá každých pár sekund a nezměněná data
// (304) se pak neposílají vůbec – Návrhy mají i přes 2 MB.
function send(res, code, data) {
  const json = typeof data !== 'string';
  const body = Buffer.from(json ? JSON.stringify(data) : data);
  const headers = { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  const req = res.req;
  if (code === 200 && json && (req?.method || 'GET') === 'GET') {
    headers.ETag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
    if (req?.headers['if-none-match'] === headers.ETag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  if (body.length < 1024 || !/\bgzip\b/.test(req?.headers['accept-encoding'] || '')) {
    res.writeHead(code, headers);
    return res.end(body);
  }
  zlib.gzip(body, { level: 6 }, (err, gz) => {
    if (err) { res.writeHead(code, headers); return res.end(body); }
    res.writeHead(code, { ...headers, 'Content-Encoding': 'gzip' });
    return res.end(gz);
  });
}

// Kandidát pro web: bez odkazů ke stažení (obsahují API klíč Prowlarru) a interních dat Radarru/Sonarru
const publicCand = (c) => c && { ...c, downloadUrl: undefined, magnetUrl: undefined, arr: undefined, arrRejections: undefined };

// Ochrana proti CSRF: změny (POST/PUT/DELETE na /api/*) jen ze stejného webu. Cizí stránka by jinak mohla
// v prohlížeči přihlášeného uživatele (Basic auth se posílá sama) spustit stahování nebo mazání záloh.
// Požadavky bez Originu (ntfy tlačítka, curl) projdou; webhooky Radarru/Sonarru se kontrolují tokenem.
function csrfBlocked(req, pathname) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/webhook/')) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return true; } // "null" (sandbox, file://) apod.
  // Za reverzní proxy může být původní adresa v X-Forwarded-Host
  const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean)
    .flatMap((h) => String(h).split(',')).map((h) => h.trim().toLowerCase());
  return !allowed.includes(host);
}

module.exports = { send, publicCand, csrfBlocked };
