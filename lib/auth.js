import crypto from 'crypto';

const COOKIE_NAME = 'cfw_session';
const SESSION_HOURS = 12;

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_SECRET is missing or too short. Set a long random string in .env (see .env.example).');
  }
  return s;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  // timing-safe compare
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkPassword(candidate) {
  const real = String(process.env.SITE_PASSWORD || '').trim();
  if (!real) throw new Error('SITE_PASSWORD is not set on the server.');
  const a = Buffer.from(String(candidate || '').trim());
  const b = Buffer.from(real);
  if (a.length !== b.length) return false; // avoid throwing on length mismatch inside timingSafeEqual
  return crypto.timingSafeEqual(a, b);
}

export function issueSessionCookie(res) {
  const token = sign({ exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000 });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

export function requireAuthApi(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated. Please log in again.' });
  next();
}

export function requireAuthPage(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = verify(token);
  if (!payload) return res.redirect('/login.html');
  next();
}
