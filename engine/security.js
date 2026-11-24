const crypto = require('node:crypto');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function getSessionSecret(db) {
  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    secret = db.getKV('session_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      db.setKV('session_secret', secret);
    }
  }
  return secret;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, keyHex] = stored.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derived = crypto.scryptSync(String(password), salt, 64);
  if (keyBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(keyBuf, derived);
}

function isOwnerAuthEnabled(db) {
  return Boolean(process.env.OWNER_PASSWORD || db.getKV('owner_password_hash'));
}

function checkOwnerPassword(db, password) {
  if (process.env.OWNER_PASSWORD) {
    return crypto.timingSafeEqual(
      Buffer.from(String(password || '')),
      Buffer.from(String(process.env.OWNER_PASSWORD))
    );
  }
  const stored = db.getKV('owner_password_hash');
  if (!stored) return true;
  return verifyPassword(password, stored);
}

function setOwnerPassword(db, newPassword) {
  if (!newPassword || String(newPassword).length < 4) {
    throw new Error('كلمة المرور يجب أن لا تقل عن 4 أحرف');
  }
  db.setKV('owner_password_hash', hashPassword(newPassword));
  db.logAudit('owner', 'set_owner_password', 'auth', {});
}

function createSessionToken(db, role = 'owner') {
  const secret = getSessionSecret(db);
  const payload = Buffer.from(
    JSON.stringify({ role, exp: Date.now() + SESSION_TTL_MS, nonce: crypto.randomBytes(8).toString('hex') })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(db, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const secret = getSessionSecret(db);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function isAuthenticatedOwner(req, db) {
  if (!isOwnerAuthEnabled(db)) return true;
  const cookies = parseCookies(req);
  const token = cookies.avo_session || req.headers['x-owner-token'];
  const session = verifySessionToken(db, token);
  return Boolean(session && session.role === 'owner');
}

function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/gsk_[A-Za-z0-9_-]{10,}/g, 'gsk_***REDACTED***')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza***REDACTED***')
    .replace(/AQ\.[A-Za-z0-9_.-]{10,}/g, 'AQ.***REDACTED***')
    .replace(/sk-or-[A-Za-z0-9_-]{10,}/g, 'sk-or-***REDACTED***')
    .replace(/ghp_[A-Za-z0-9]{10,}/g, 'ghp_***REDACTED***')
    .replace(/rnd_[A-Za-z0-9]{10,}/g, 'rnd_***REDACTED***');
}

/**
 * Sandboxed static safety scanner for generated HTML/JS before deployment/preview
 */
function scanGeneratedCodeSafety(html) {
  const findings = [];
  const lower = String(html || '').toLowerCase();
  const patterns = [
    { re: /\beval\s*\(/gi, severity: 'high', msg: 'استخدام eval() غير آمن' },
    { re: /new\s+Function\s*\(/gi, severity: 'high', msg: 'استخدام new Function() ديناميكي' },
    { re: /document\.cookie/gi, severity: 'high', msg: 'محاولة قراءة document.cookie' },
    { re: /https?:\/\/(?!fonts\.googleapis\.com|cdn\.jsdelivr\.net)/gi, severity: 'low', msg: 'روابط خارجية داخل الكود المولد' },
  ];
  for (const p of patterns) {
    if (p.re.test(html)) {
      findings.push({ severity: p.severity, message: p.msg });
    }
  }
  const hasHigh = findings.some((f) => f.severity === 'high');
  return {
    safe: !hasHigh,
    findings,
    checkedBytes: Buffer.byteLength(String(html || ''), 'utf8'),
    scannedAt: new Date().toISOString(),
  };
}

function hasAgentPermission(agent, action) {
  if (!agent) return false;
  const perms = Array.isArray(agent.permissions) ? agent.permissions : [];
  if (perms.includes('*')) return true;
  return perms.includes(action);
}

module.exports = {
  isOwnerAuthEnabled,
  checkOwnerPassword,
  setOwnerPassword,
  createSessionToken,
  isAuthenticatedOwner,
  redactSecrets,
  scanGeneratedCodeSafety,
  hasAgentPermission,
};
