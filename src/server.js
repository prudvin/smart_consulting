// The database uses Node's built-in SQLite (node:sqlite), available without flags from Node.js 22.13.
// Fail with a clear message (shown in the host's error log) instead of an obscure "module not found".
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Smart Consulting needs Node.js 22.13 or later; this server runs Node.js ${process.versions.node}. Choose a newer Node.js version in your hosting control panel.`);
  process.exit(1);
}

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { db, getSetting } = require('./db');
const SqliteStore = require('./session-store');
const { attachLocals, csrfProtect, requireAuth, requireAdmin } = require('./middleware');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: true, parameterLimit: 20000 }));
app.use(session({
  store: new SqliteStore(db),
  secret: process.env.SESSION_SECRET || getSetting('session_secret'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 8 * 60 * 60 * 1000 },
}));
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(attachLocals);
app.use(csrfProtect);

app.use(require('./routes/auth'));
app.use(requireAuth);
app.use('/', require('./routes/dashboard'));
app.use('/account', require('./routes/account'));
app.use('/employees', require('./routes/employees'));
app.use('/customers', require('./routes/customers'));
app.use('/assignments', require('./routes/assignments'));
app.use('/attendance', require('./routes/attendance'));
app.use('/pay-profiles', require('./routes/pay-profiles'));
app.use('/employee-pay', require('./routes/employee-pay'));
app.use('/payroll', require('./routes/payroll'));
app.use('/invoices', require('./routes/invoices'));
// The Billing rates page was removed (rates are set on each assignment); old links go to Employees.
app.get('/rates', (req, res) => res.redirect('/employees'));
app.use('/users', requireAdmin, require('./routes/users'));
app.use('/settings', requireAdmin, require('./routes/settings'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'The page you were looking for does not exist.' });
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: err.message });
});

// PORT is usually a number; on Windows hosting (IIS with iisnode, e.g. Plesk for Windows) it is a named pipe, used as is.
const port = !process.env.PORT ? 3000 : /^\d+$/.test(process.env.PORT) ? Number(process.env.PORT) : process.env.PORT;
// Express 5 calls the listen callback with an error if the server fails to start.
app.listen(port, err => {
  if (!err) return console.log(`Smart Consulting running at http://localhost:${port}`);
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${port} is already in use by another application. Start on a different port, e.g. PORT=3100 (PowerShell: $env:PORT=3100; npm start).`);
  process.exit(1);
});
