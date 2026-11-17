const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash, isUniqueError } = require('../middleware');

const router = express.Router();
const ROLES = ['admin', 'staff'];

const activeAdminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

function readUser(body) {
  return {
    username: String(body.username || '').trim(),
    name: String(body.name || '').trim(),
    role: ROLES.includes(body.role) ? body.role : 'staff',
    active: body.active === '1' ? 1 : 0,
    password: String(body.password || ''),
  };
}

router.get('/', (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY username').all();
  res.render('users/list', { title: 'Users', users });
});

router.get('/new', (req, res) => {
  res.render('users/form', { title: 'Add user', u: { role: 'staff', active: 1 }, isNew: true, error: null });
});

router.post('/', (req, res) => {
  const u = readUser(req.body);
  u.active = 1;
  let error = null;
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u.username)) error = 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.';
  else if (!u.name) error = 'Name is required.';
  else if (u.password.length < 8) error = 'Password must be at least 8 characters.';
  if (!error) {
    try {
      db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(u.username, u.name, bcrypt.hashSync(u.password, 10), u.role);
      flash(req, 'success', `User "${u.username}" added.`);
      return res.redirect('/users');
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'That username is already taken.';
    }
  }
  res.status(400).render('users/form', { title: 'Add user', u, isNew: true, error });
});

router.get('/:id/edit', (req, res, next) => {
  const u = db.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return next();
  res.render('users/form', { title: `Edit user ${u.username}`, u, isNew: false, error: null });
});

router.post('/:id', (req, res, next) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!existing) return next();
  const u = { ...readUser(req.body), id: existing.id, username: existing.username };
  const isSelf = existing.id === req.user.id;
  const losesAdmin = existing.role === 'admin' && existing.active && (u.role !== 'admin' || !u.active);

  let error = null;
  if (!u.name) error = 'Name is required.';
  else if (u.password && u.password.length < 8) error = 'New password must be at least 8 characters.';
  else if (isSelf && losesAdmin) error = 'You cannot remove your own admin access or deactivate yourself.';
  else if (losesAdmin && activeAdminCount() <= 1) error = 'At least one active administrator is required.';
  if (error) return res.status(400).render('users/form', { title: `Edit user ${u.username}`, u, isNew: false, error });

  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(u.name, u.role, u.active, u.id);
  if (u.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(u.password, 10), u.id);
  flash(req, 'success', `User "${u.username}" updated.`);
  res.redirect('/users');
});

router.post('/:id/delete', (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return next();
  if (u.id === req.user.id) flash(req, 'error', 'You cannot remove your own account.');
  else if (u.role === 'admin' && u.active && activeAdminCount() <= 1) flash(req, 'error', 'At least one active administrator is required.');
  else {
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.user.id') = ?").run(u.id);
    flash(req, 'success', `User "${u.username}" removed.`);
  }
  res.redirect('/users');
});

module.exports = router;
