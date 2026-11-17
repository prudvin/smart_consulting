const express = require('express');
const { db } = require('../db');
const f = require('../format');
const { flash, isUniqueError, isForeignKeyError, pick, toDb } = require('../middleware');

const router = express.Router();
const FIELDS = ['name', 'contact_person', 'email', 'phone', 'address', 'gstin', 'status', 'agency_charge_type', 'agency_charge_value'];

function readCustomer(body) {
  const c = pick(body, FIELDS);
  if (!['Active', 'Inactive'].includes(c.status)) c.status = 'Active';
  c.gstin = c.gstin.toUpperCase();
  if (!['None', 'Percent', 'Fixed'].includes(c.agency_charge_type)) c.agency_charge_type = 'None';
  c.agency_charge_value = c.agency_charge_type === 'None' ? 0 : c.agency_charge_value === '' ? 0 : Number(c.agency_charge_value);
  return c;
}

// Returns an error message for invalid agency charges, or null.
function agencyError(c) {
  if (!(c.agency_charge_value >= 0)) return 'Agency charges must be zero or more.';
  if (c.agency_charge_type === 'Percent' && c.agency_charge_value > 100) return 'Agency charges can be at most 100%.';
  return null;
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status ?? 'Active');
  let sql = `
    SELECT c.*, (SELECT COUNT(*) FROM assignments a JOIN employees e ON e.id = a.employee_id WHERE a.customer_id = c.id
      AND a.start_date <= date('now', 'localtime') AND COALESCE(NULLIF(a.end_date, ''), '9999-12-31') >= date('now', 'localtime')
      AND COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31') >= date('now', 'localtime')) AS active_assignments
    FROM customers c WHERE 1 = 1`;
  const params = [];
  if (q) {
    sql += ' AND (c.name LIKE ? OR c.contact_person LIKE ? OR c.email LIKE ?)';
    params.push(...Array(3).fill(`%${q}%`));
  }
  if (status) {
    sql += ' AND c.status = ?';
    params.push(status);
  }
  const customers = db.prepare(`${sql} ORDER BY c.name`).all(...params);
  res.render('customers/list', { title: 'Customers', customers, q, status });
});

router.get('/new', (req, res) => {
  res.render('customers/form', { title: 'Add customer', c: { status: 'Active' }, isNew: true, error: null });
});

router.post('/', (req, res) => {
  const c = readCustomer(req.body);
  let error = c.name ? agencyError(c) : 'Customer name is required.';
  if (!error) {
    try {
      db.prepare(`INSERT INTO customers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`).run(...toDb(c, FIELDS));
      flash(req, 'success', `Customer ${c.name} added.`);
      return res.redirect('/customers');
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'A customer with that name already exists.';
    }
  }
  res.status(400).render('customers/form', { title: 'Add customer', c, isNew: true, error });
});

// Assignments end at their end date, or at the employee's resignation date (last working day) if that is earlier.
const BILLABLE_END = "MIN(COALESCE(NULLIF(a.end_date, ''), '9999-12-31'), COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31'))";
const fromPanel = req => req.query.panel === '1' || (req.body && req.body._panel === '1');

// Customer details: consultants assigned now (and earlier), and invoices.
// ?panel=1 returns just the details for the slide-over panel on the Customers list.
router.get('/:id', (req, res, next) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!c) return next();
  const today = f.today();
  const assignments = db.prepare(`
    SELECT a.*, e.name AS employee_name, e.code AS employee_code, ${BILLABLE_END} AS billable_end
    FROM assignments a JOIN employees e ON e.id = a.employee_id
    WHERE a.customer_id = ? ORDER BY e.name, a.start_date DESC`).all(c.id);
  const current = assignments.filter(a => a.billable_end >= today);
  const past = assignments.filter(a => a.billable_end < today).sort((x, y) => y.billable_end.localeCompare(x.billable_end));
  const invoices = db.prepare('SELECT * FROM invoices WHERE customer_id = ? ORDER BY month DESC, number DESC LIMIT 12').all(c.id);
  const invoiceTotals = db.prepare(`
    SELECT COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN status <> 'Cancelled' THEN total END), 0) AS billed,
      COALESCE(SUM(CASE WHEN status = 'Sent' THEN total END), 0) AS outstanding
    FROM invoices WHERE customer_id = ?`).get(c.id);
  const savedMsg = req.query.saved === '1' ? 'Customer details saved.' : null;
  const counts = { now: current.filter(a => a.start_date <= today).length, upcoming: current.filter(a => a.start_date > today).length };
  res.render(fromPanel(req) ? 'customers/panel' : 'customers/show',
    { title: c.name, c, current, past, invoices, invoiceTotals, savedMsg, counts, today });
});

router.get('/:id/edit', (req, res, next) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!c) return next();
  res.render(fromPanel(req) ? 'customers/edit-panel' : 'customers/form', { title: `Edit ${c.name}`, c, isNew: false, error: null });
});

router.post('/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) return next();
  const c = { ...readCustomer(req.body), id };
  let error = c.name ? agencyError(c) : 'Customer name is required.';
  if (!error) {
    try {
      db.prepare(`UPDATE customers SET ${FIELDS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...toDb(c, FIELDS), id);
      // From the panel, go back to the details panel; otherwise to the customer page.
      if (fromPanel(req)) return res.redirect(`/customers/${id}?panel=1&saved=1`);
      flash(req, 'success', 'Customer updated.');
      return res.redirect(`/customers/${id}`);
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'A customer with that name already exists.';
    }
  }
  res.status(400).render(fromPanel(req) ? 'customers/edit-panel' : 'customers/form', { title: 'Edit customer', c, isNew: false, error });
});

router.post('/:id/delete', (req, res) => {
  try {
    db.prepare('DELETE FROM customers WHERE id = ?').run(Number(req.params.id));
    flash(req, 'success', 'Customer deleted.');
  } catch (err) {
    if (!isForeignKeyError(err)) throw err;
    flash(req, 'error', 'This customer has invoices and cannot be deleted. Mark them Inactive instead.');
  }
  res.redirect('/customers');
});

module.exports = router;
