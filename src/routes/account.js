const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { flash } = require('../middleware');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('account', { title: 'Change password', error: null });
});

router.post('/', (req, res) => {
  const { current_password = '', new_password = '', confirm_password = '' } = req.body;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  let error = null;
  if (!bcrypt.compareSync(String(current_password), row.password_hash)) error = 'Current password is incorrect.';
  else if (String(new_password).length < 8) error = 'New password must be at least 8 characters.';
  else if (new_password !== confirm_password) error = 'New passwords do not match.';
  if (error) return res.status(400).render('account', { title: 'Change password', error });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(new_password), 10), req.user.id);
  flash(req, 'success', 'Password changed.');
  res.redirect('/');
});

module.exports = router;
