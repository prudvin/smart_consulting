const crypto = require('node:crypto');
const { db, getSetting } = require('./db');
const f = require('./format');

function attachLocals(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.user = null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.originalUrl.split('?')[0];
  res.locals.companyName = getSetting('company_name', 'Smart Consulting');
  res.locals.f = f;
  next();
}

function csrfProtect(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = Buffer.from(String((req.body && req.body._csrf) || ''));
  const expected = Buffer.from(req.session.csrf || '');
  if (sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Your form session expired. Go back, refresh the page and try again.' });
  }
  next();
}

// Re-reads the user on every request so deactivated or removed users are logged out immediately.
function requireAuth(req, res, next) {
  const id = req.session.user && req.session.user.id;
  const user = id && db.prepare('SELECT id, username, name, role FROM users WHERE id = ? AND active = 1').get(id);
  if (!user) {
    delete req.session.user;
    return res.redirect('/login');
  }
  req.user = res.locals.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Not allowed', message: 'Only administrators can access this page.' });
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

const isUniqueError = err => /UNIQUE constraint failed/.test(err && err.message);
const isForeignKeyError = err => /FOREIGN KEY constraint failed/.test(err && err.message);

// Trimmed string fields from a form body; empty strings become null for storage.
function pick(body, fields) {
  const out = {};
  for (const k of fields) out[k] = String(body[k] ?? '').trim();
  return out;
}
const toDb = (obj, fields) => fields.map(k => (obj[k] === '' ? null : obj[k]));

module.exports = { attachLocals, csrfProtect, requireAuth, requireAdmin, flash, isUniqueError, isForeignKeyError, pick, toDb };
