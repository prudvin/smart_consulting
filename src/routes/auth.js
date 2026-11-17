const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, username: '' });
});

router.post('/login', (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid username or password.', username });
  }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.user = { id: user.id };
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;
