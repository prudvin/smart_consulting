const express = require('express');
const { db, tx, getSettings } = require('../db');
const f = require('../format');
const { INVOICE_STATUSES } = require('../constants');
const { flash } = require('../middleware');
const { createInvoice, replaceLines, rebuildInvoice, generateForMonth } = require('../services/invoices');

const router = express.Router();

const getInvoice = id => db.prepare(`
  SELECT i.*, c.name AS customer_name, c.contact_person, c.email AS customer_email, c.phone AS customer_phone,
    c.address AS customer_address, c.gstin AS customer_gstin
  FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`).get(Number(id));
const getLines = id => db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort, id').all(id);
const getAnnexure = id => db.prepare('SELECT * FROM invoice_annexure WHERE invoice_id = ? ORDER BY sort, id').all(id);
const missingDesignations = resources =>
  [...new Set(resources.filter(r => r.rate_source === 'Missing').map(r => r.employee_name))];
const missingRateMessage = designations =>
  designations.length ? ` No billing rate on the assignment for: ${designations.join(', ')} — billed at ₹0. Set the rate on their assignment (employee details), then use Rebuild on the draft.` : '';

router.get('/', (req, res) => {
  const month = f.isMonth(req.query.month) ? req.query.month : '';
  const status = INVOICE_STATUSES.includes(req.query.status) ? req.query.status : '';
  const customer_id = Number(req.query.customer_id) || 0;
  let sql = 'SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE 1 = 1';
  const params = [];
  if (month) { sql += ' AND i.month = ?'; params.push(month); }
  if (status) { sql += ' AND i.status = ?'; params.push(status); }
  if (customer_id) { sql += ' AND i.customer_id = ?'; params.push(customer_id); }
  const invoices = db.prepare(`${sql} ORDER BY i.month DESC, i.number DESC`).all(...params);
  res.render('invoices/list', {
    title: 'Invoices', invoices, month, status, customer_id, INVOICE_STATUSES,
    customers: db.prepare('SELECT id, name FROM customers ORDER BY name').all(),
    generateMonth: f.currentMonth(),
    total: invoices.filter(i => i.status !== 'Cancelled').reduce((s, i) => s + i.total, 0),
  });
});

router.post('/generate', (req, res) => {
  const month = String(req.body.month || '');
  if (!f.isMonth(month)) {
    flash(req, 'error', 'Choose a valid month.');
    return res.redirect('/invoices');
  }
  const { created, skipped, missingRates } = generateForMonth(month);
  const skippedMsg = skipped ? ` ${skipped} customer(s) already had an invoice for this month.` : '';
  if (created.length) {
    // Warn (without blocking) about customers invoiced before their attendance was finalized for the month.
    const open = db.prepare(`SELECT DISTINCT c.name FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.id IN (${created.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM attendance_finalized af WHERE af.customer_id = i.customer_id AND af.month = ?)
      ORDER BY c.name`).all(...created, month).map(r => r.name);
    const openMsg = open.length ? ` Attendance is not finalized yet for: ${open.join(', ')} — rebuild those invoices after finalizing if leave changes.` : '';
    flash(req, missingRates.length ? 'error' : open.length ? 'info' : 'success',
      `Created ${created.length} draft invoice(s) for ${f.monthLabel(month)}.${skippedMsg}${missingRateMessage(missingRates)}${openMsg}`);
  }
  else flash(req, 'info', `No new invoices created for ${f.monthLabel(month)}.${skippedMsg || ' No customers had assignments in that month.'}`);
  res.redirect(`/invoices?month=${month}`);
});

router.get('/new', (req, res) => {
  res.render('invoices/new', {
    title: 'New invoice', month: f.currentMonth(), customer_id: Number(req.query.customer_id) || 0, error: null,
    customers: db.prepare("SELECT id, name FROM customers WHERE status = 'Active' ORDER BY name").all(),
  });
});

router.post('/', (req, res) => {
  const month = String(req.body.month || '');
  const customerId = Number(req.body.customer_id) || 0;
  if (!f.isMonth(month) || !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) {
    return res.status(400).render('invoices/new', {
      title: 'New invoice', month, customer_id: customerId, error: 'Choose a customer and a month.',
      customers: db.prepare("SELECT id, name FROM customers WHERE status = 'Active' ORDER BY name").all(),
    });
  }
  const { id, resources } = createInvoice(customerId, month, { fromAssignments: req.body.prefill === '1' });
  const missing = missingDesignations(resources);
  flash(req, missing.length ? 'error' : 'success', `Draft invoice created. Review the lines and save.${missingRateMessage(missing)}`);
  res.redirect(`/invoices/${id}/edit`);
});

router.get('/:id', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  const lines = getLines(inv.id);
  const annexure = getAnnexure(inv.id);
  res.render('invoices/show', {
    title: `Invoice ${inv.number}`, inv, lines, annexure, settings: getSettings(), INVOICE_STATUSES,
    annexureTotal: f.round2(annexure.reduce((s, r) => s + r.amount, 0)),
  });
});

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/:id/annexure.csv', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  const header = ['Code', 'Employee', 'Designation', 'Role', 'From', 'To', 'Attendance source', 'Days worked', 'Leave days', 'Holidays and week offs', 'Billable hours', 'Billing basis', 'Quantity', 'Unit', 'Rate', 'Rate source', 'Amount'];
  const rows = getAnnexure(inv.id).map(r => [r.employee_code, r.employee_name, r.designation, r.role, r.period_from, r.period_to,
    r.attendance_source, r.days_worked, r.paid_leave, r.attendance_source === 'Daily' ? r.holidays + r.week_off : '', r.hours,
    r.billing_type, r.quantity, r.unit, r.rate, r.rate_source, r.amount]);
  res.type('text/csv').attachment(`${inv.number.replace(/[^\w.-]+/g, '_')}-annexure.csv`);
  res.send([header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'));
});

router.post('/:id/rebuild', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  if (inv.status !== 'Draft') {
    flash(req, 'error', 'Only draft invoices can be rebuilt.');
    return res.redirect(`/invoices/${inv.id}`);
  }
  const resources = rebuildInvoice(inv.id);
  const missing = missingDesignations(resources);
  flash(req, missing.length ? 'error' : 'success',
    `Invoice rebuilt from ${resources.length} assignment(s) using current assignment rates and attendance.${missingRateMessage(missing)}`);
  res.redirect(`/invoices/${inv.id}`);
});

router.get('/:id/edit', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  if (inv.status !== 'Draft') {
    flash(req, 'error', 'Only draft invoices can be edited. Set the status back to Draft first.');
    return res.redirect(`/invoices/${inv.id}`);
  }
  res.render('invoices/edit', { title: `Edit invoice ${inv.number}`, inv, lines: getLines(inv.id), error: null });
});

router.post('/:id', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  if (inv.status !== 'Draft') {
    flash(req, 'error', 'Only draft invoices can be edited.');
    return res.redirect(`/invoices/${inv.id}`);
  }
  const lines = Object.values(req.body.lines || {})
    .map(l => ({
      description: String(l.description || '').trim(),
      quantity: Number(l.quantity) || 0,
      unit: String(l.unit || '').trim(),
      rate: Number(l.rate) || 0,
    }))
    .filter(l => l.description);
  const fields = {
    invoice_date: String(req.body.invoice_date || ''),
    due_date: String(req.body.due_date || ''),
    tax_rate: Number(req.body.tax_rate) || 0,
    notes: String(req.body.notes || '').trim(),
  };

  let error = null;
  if (!f.isDate(fields.invoice_date)) error = 'Invoice date is required.';
  else if (fields.due_date && !f.isDate(fields.due_date)) error = 'Due date is invalid.';
  else if (fields.due_date && fields.due_date < fields.invoice_date) error = 'Due date cannot be before the invoice date.';
  else if (fields.tax_rate < 0 || fields.tax_rate > 100) error = 'Tax rate must be between 0 and 100.';
  if (error) return res.status(400).render('invoices/edit', { title: `Edit invoice ${inv.number}`, inv: { ...inv, ...fields }, lines, error });

  tx(() => {
    db.prepare('UPDATE invoices SET invoice_date = ?, due_date = ?, tax_rate = ?, notes = ? WHERE id = ?')
      .run(fields.invoice_date, fields.due_date || null, fields.tax_rate, fields.notes || null, inv.id);
    replaceLines(inv.id, lines);
  });
  flash(req, 'success', 'Invoice saved.');
  res.redirect(`/invoices/${inv.id}`);
});

router.post('/:id/status', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  const status = String(req.body.status || '');
  if (!INVOICE_STATUSES.includes(status)) {
    flash(req, 'error', 'Invalid status.');
  } else {
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, inv.id);
    flash(req, 'success', `Invoice ${inv.number} marked ${status}.`);
  }
  res.redirect(`/invoices/${inv.id}`);
});

router.post('/:id/delete', (req, res, next) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return next();
  if (!['Draft', 'Cancelled'].includes(inv.status)) {
    flash(req, 'error', 'Only draft or cancelled invoices can be deleted.');
    return res.redirect(`/invoices/${inv.id}`);
  }
  db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
  flash(req, 'success', `Invoice ${inv.number} deleted.`);
  res.redirect('/invoices');
});

module.exports = router;
