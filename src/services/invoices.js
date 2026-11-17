const { db, tx, getSetting } = require('../db');
const { BILLING_TYPES } = require('../constants');
const { attendanceFor } = require('./attendance');
const f = require('../format');

const OPEN_END = "COALESCE(NULLIF(a.end_date, ''), '9999-12-31')";
// An assignment stops at its end date or at the employee's resignation date (last working day), whichever is first.
const BILLABLE_END = `MIN(${OPEN_END}, COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31'))`;
const designationKey = d => String(d || '').trim().toLowerCase();

function nextInvoiceNumber(month) {
  const prefix = `${getSetting('invoice_prefix', '')}${month.replace('-', '')}-`;
  const rows = db.prepare('SELECT number FROM invoices WHERE substr(number, 1, ?) = ?').all(prefix.length, prefix);
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.number.slice(prefix.length), 10) || 0), 0);
  return prefix + String(max + 1).padStart(3, '0');
}

// The customer is billed at the billing basis and rate on the assignment; without them it is billed at 0 and flagged.
function resolveRate(a) {
  if (a.billing_type && a.rate != null) return { billing_type: a.billing_type, rate: a.rate, rate_source: 'Assignment' };
  return { billing_type: 'Monthly', rate: 0, rate_source: 'Missing' };
}

// One row per assignment overlapping the month: attendance in the assigned period and the billable quantity.
// Monthly: prorated by calendar days assigned. Daily: days worked. Hourly: hours worked.
// Attendance comes from the employee's monthly entry if there is one, otherwise from daily records.
function buildResources(customerId, month) {
  const start = f.monthStart(month);
  const end = f.monthEnd(month);
  const dim = f.daysInMonth(month);
  const assignments = db.prepare(`
    SELECT a.*, e.code AS employee_code, e.name AS employee_name, e.designation AS employee_designation,
      e.join_date, e.resignation_date, ${BILLABLE_END} AS billable_end
    FROM assignments a JOIN employees e ON e.id = a.employee_id
    WHERE a.customer_id = ? AND a.start_date <= ? AND ${BILLABLE_END} >= ?
    ORDER BY COALESCE(NULLIF(TRIM(a.designation), ''), e.designation), e.name, a.start_date`).all(customerId, end, start);

  return assignments.map(row => {
    // Designation is recorded on the assignment (older data may only have it on the employee).
    const a = { ...row, designation: (row.designation || '').trim() || row.employee_designation || '' };
    const from = a.start_date > start ? a.start_date : start;
    const to = a.billable_end < end ? a.billable_end : end;
    const att = attendanceFor({ id: a.employee_id, join_date: a.join_date, resignation_date: a.resignation_date }, month, from, to);
    const days = status => (att.counts ? att.counts[status] : 0);
    const { billing_type, rate, rate_source } = resolveRate(a);

    const quantity = f.round2(
      billing_type === 'Monthly' ? f.daysBetween(from, to) / dim
        : billing_type === 'Daily' ? att.worked
          : att.hours
    );
    return {
      employee_id: a.employee_id,
      employee_code: a.employee_code,
      employee_name: a.employee_name,
      designation: a.designation || '',
      role: a.role || '',
      period_from: from,
      period_to: to,
      present: days('P'),
      half_day: days('HD'),
      paid_leave: att.leave,
      unpaid_leave: days('UL'),
      absent: days('A'),
      holidays: days('H'),
      week_off: days('WO'),
      hours: att.hours,
      days_worked: f.round2(att.worked),
      lop_days: f.round2(att.lop),
      attendance_source: att.source,
      billing_type,
      quantity,
      unit: BILLING_TYPES[billing_type],
      rate,
      rate_source,
      amount: f.round2(quantity * rate),
    };
  });
}

// Invoice lines: one per designation and rate.
function linesFromResources(resources) {
  const groups = new Map();
  for (const r of resources) {
    const key = [designationKey(r.designation), r.billing_type, r.rate].join('|');
    if (!groups.has(key)) groups.set(key, { designation: r.designation || 'Consultant', unit: r.unit, rate: r.rate, quantity: 0, people: new Set() });
    const g = groups.get(key);
    g.quantity += r.quantity;
    g.people.add(r.employee_id);
  }
  return [...groups.values()].map(g => ({
    description: `${g.designation} — ${g.people.size} resource${g.people.size === 1 ? '' : 's'}`,
    quantity: f.round2(g.quantity),
    unit: g.unit,
    rate: g.rate,
  }));
}

// Invoice totals: agency charges on the subtotal (Percent: a percentage of it; Fixed: a flat amount, when anything is
// billed), then CGST and SGST each on the taxable value (subtotal + agency charges).
function invoiceTotals(subtotal, { agency_charge_type, agency_charge_value, cgst_rate, sgst_rate }) {
  const value = Number(agency_charge_value) || 0;
  const agency = subtotal <= 0 ? 0
    : agency_charge_type === 'Percent' ? f.round2((subtotal * value) / 100)
      : agency_charge_type === 'Fixed' ? f.round2(value) : 0;
  const taxable = f.round2(subtotal + agency);
  const cgst = f.round2((taxable * (Number(cgst_rate) || 0)) / 100);
  const sgst = f.round2((taxable * (Number(sgst_rate) || 0)) / 100);
  return { subtotal: f.round2(subtotal), agency, taxable, cgst, sgst, tax: f.round2(cgst + sgst), total: f.round2(taxable + cgst + sgst) };
}

function recalcInvoice(id) {
  const inv = db.prepare('SELECT agency_charge_type, agency_charge_value, cgst_rate, sgst_rate FROM invoices WHERE id = ?').get(id);
  const subtotal = f.round2(db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_lines WHERE invoice_id = ?').get(id).s);
  const t = invoiceTotals(subtotal, inv);
  db.prepare(`UPDATE invoices SET subtotal = ?, agency_amount = ?, cgst_amount = ?, sgst_amount = ?,
    tax_rate = cgst_rate + sgst_rate, tax_amount = ?, total = ? WHERE id = ?`)
    .run(t.subtotal, t.agency, t.cgst, t.sgst, t.tax, t.total, id);
}

function replaceLines(invoiceId, lines) {
  tx(() => {
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(invoiceId);
    const stmt = db.prepare('INSERT INTO invoice_lines (invoice_id, description, quantity, unit, rate, amount, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    lines.forEach((l, i) => stmt.run(invoiceId, l.description, l.quantity, l.unit || null, l.rate, f.round2(l.quantity * l.rate), i));
    recalcInvoice(invoiceId);
  });
}

const ANNEXURE_FIELDS = ['employee_id', 'employee_code', 'employee_name', 'designation', 'role', 'period_from', 'period_to',
  'present', 'half_day', 'paid_leave', 'unpaid_leave', 'absent', 'holidays', 'week_off', 'hours',
  'days_worked', 'lop_days', 'attendance_source',
  'billing_type', 'quantity', 'unit', 'rate', 'rate_source', 'amount'];

function replaceAnnexure(invoiceId, resources) {
  tx(() => {
    db.prepare('DELETE FROM invoice_annexure WHERE invoice_id = ?').run(invoiceId);
    const stmt = db.prepare(`INSERT INTO invoice_annexure (invoice_id, ${ANNEXURE_FIELDS.join(', ')}, sort)
      VALUES (?, ${ANNEXURE_FIELDS.map(() => '?').join(', ')}, ?)`);
    resources.forEach((r, i) => stmt.run(invoiceId, ...ANNEXURE_FIELDS.map(k => r[k] ?? null), i));
  });
}

// Rebuilds a draft invoice's lines and annexure from current assignments (with their rates) and attendance.
function rebuildInvoice(invoiceId) {
  const inv = db.prepare('SELECT customer_id, month FROM invoices WHERE id = ?').get(invoiceId);
  const resources = buildResources(inv.customer_id, inv.month);
  tx(() => {
    // Agency charges are taken from the customer's current setting.
    db.prepare(`UPDATE invoices SET (agency_charge_type, agency_charge_value) =
      (SELECT agency_charge_type, agency_charge_value FROM customers WHERE id = ?) WHERE id = ?`).run(inv.customer_id, invoiceId);
    replaceLines(invoiceId, linesFromResources(resources));
    replaceAnnexure(invoiceId, resources);
  });
  return resources;
}

function createInvoice(customerId, month, { fromAssignments }) {
  const invoiceDate = f.monthEnd(month);
  const dueDate = f.addDays(invoiceDate, Number(getSetting('payment_terms_days', '0')) || 0);
  return tx(() => {
    const cgst = Number(getSetting('cgst_rate', '0')) || 0;
    const sgst = Number(getSetting('sgst_rate', '0')) || 0;
    const customer = db.prepare('SELECT agency_charge_type, agency_charge_value FROM customers WHERE id = ?').get(customerId) || {};
    const id = Number(db.prepare(`INSERT INTO invoices (number, customer_id, month, invoice_date, due_date, tax_rate, cgst_rate, sgst_rate,
        agency_charge_type, agency_charge_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nextInvoiceNumber(month), customerId, month, invoiceDate, dueDate, cgst + sgst, cgst, sgst,
        customer.agency_charge_type || 'None', customer.agency_charge_value || 0)
      .lastInsertRowid);
    const resources = fromAssignments ? rebuildInvoice(id) : [];
    return { id, resources };
  });
}

// Creates a draft invoice for every active customer with assignments in the month,
// skipping customers that already have a (non-cancelled) invoice for it.
// Returns the consultants whose assignment has no rate (billed at 0) so the user can set one.
function generateForMonth(month) {
  const start = f.monthStart(month);
  const end = f.monthEnd(month);
  const customers = db.prepare(`
    SELECT DISTINCT c.id FROM customers c JOIN assignments a ON a.customer_id = c.id JOIN employees e ON e.id = a.employee_id
    WHERE c.status = 'Active' AND a.start_date <= ? AND ${BILLABLE_END} >= ?`).all(end, start);
  const exists = db.prepare("SELECT 1 FROM invoices WHERE customer_id = ? AND month = ? AND status <> 'Cancelled'");

  return tx(() => {
    const created = [];
    const missingRates = new Set();
    let skipped = 0;
    for (const c of customers) {
      if (exists.get(c.id, month)) {
        skipped++;
        continue;
      }
      const { id, resources } = createInvoice(c.id, month, { fromAssignments: true });
      created.push(id);
      resources.filter(r => r.rate_source === 'Missing').forEach(r => missingRates.add(r.employee_name));
    }
    return { created, skipped, missingRates: [...missingRates] };
  });
}

module.exports = { buildResources, linesFromResources, invoiceTotals, createInvoice, replaceLines, rebuildInvoice, recalcInvoice, generateForMonth };
