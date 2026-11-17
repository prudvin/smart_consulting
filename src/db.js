const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// billing_type and rate: how and at what rate the customer is billed for this assignment.
const ASSIGNMENTS_TABLE = name => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role TEXT,
  designation TEXT,
  department TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  billing_type TEXT CHECK (billing_type IN ('Monthly', 'Daily', 'Hourly')),
  rate REAL,
  notes TEXT
);`;

// Components of a pay profile. kind: earning, deduction or employer contribution.
// calc: Fixed, % of gross, % of basic, balance of gross, Telangana PT slab, EPF or ESI.
const PAY_COMPONENTS_TABLE = name => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES pay_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Earning', 'Deduction', 'Employer')),
  calc TEXT NOT NULL CHECK (calc IN ('Fixed', 'PctGross', 'PctBasic', 'Balance', 'PTTelangana', 'EPF', 'ESI')),
  value REAL NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  designation TEXT,
  department TEXT,
  join_date TEXT,
  resignation_date TEXT,  -- last working day; an employee with one is Inactive
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  pan TEXT,
  bank_name TEXT,
  bank_account TEXT,
  ifsc TEXT,
  pt_exempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  gstin TEXT,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

${ASSIGNMENTS_TABLE('assignments')}

-- Billing rate card: what customers are charged for each employee designation.
CREATE TABLE IF NOT EXISTS designation_rates (
  id INTEGER PRIMARY KEY,
  designation TEXT NOT NULL UNIQUE COLLATE NOCASE,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('Monthly', 'Daily', 'Hourly')),
  rate REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P', 'A', 'HD', 'PL', 'UL', 'H', 'WO')),
  hours REAL NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);

-- Monthly attendance: leave days (unpaid) per employee-month. Every other weekday counts as worked.
-- When present for an employee-month it takes precedence over that month's daily records.
CREATE TABLE IF NOT EXISTS monthly_attendance (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  leave_days REAL NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (employee_id, month)
);

-- A customer's attendance for a month, once finalized, locks the leave days of its consultants for that month.
CREATE TABLE IF NOT EXISTS attendance_finalized (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  finalized_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (customer_id, month)
);

CREATE TABLE IF NOT EXISTS pay_profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT
);

${PAY_COMPONENTS_TABLE('pay_components')}

CREATE TABLE IF NOT EXISTS employee_pay (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES pay_profiles(id),
  monthly_gross REAL NOT NULL,
  effective_from TEXT NOT NULL,
  UNIQUE (employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Finalized')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  designation TEXT,
  profile_name TEXT NOT NULL,
  monthly_gross REAL NOT NULL,
  days_in_month INTEGER NOT NULL,
  lop_days REAL NOT NULL,
  leave_days REAL NOT NULL DEFAULT 0,
  paid_days REAL NOT NULL,
  gross_earnings REAL NOT NULL,
  total_deductions REAL NOT NULL,
  net_pay REAL NOT NULL,
  employer_contributions REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payslip_lines (
  id INTEGER PRIMARY KEY,
  payslip_id INTEGER NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  month TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  tax_rate REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Sent', 'Paid', 'Cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Per-employee billing detail behind an invoice, captured when its lines are built from assignments.
CREATE TABLE IF NOT EXISTS invoice_annexure (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  employee_id INTEGER,
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  designation TEXT,
  role TEXT,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  present REAL NOT NULL DEFAULT 0,
  half_day REAL NOT NULL DEFAULT 0,
  paid_leave REAL NOT NULL DEFAULT 0,
  unpaid_leave REAL NOT NULL DEFAULT 0,
  absent REAL NOT NULL DEFAULT 0,
  holidays REAL NOT NULL DEFAULT 0,
  week_off REAL NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  days_worked REAL NOT NULL DEFAULT 0,
  lop_days REAL NOT NULL DEFAULT 0,
  attendance_source TEXT NOT NULL DEFAULT 'Daily',
  billing_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  rate REAL NOT NULL,
  rate_source TEXT NOT NULL,
  amount REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
`);

// Older databases required a rate on every assignment; it is now an optional override of the rate card.
if (db.prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('assignments') WHERE name = 'rate'").get().nn) {
  db.exec(`BEGIN;
    ${ASSIGNMENTS_TABLE('assignments_new')}
    INSERT INTO assignments_new (id, employee_id, customer_id, role, start_date, end_date, billing_type, rate, notes)
      SELECT id, employee_id, customer_id, role, start_date, end_date, billing_type, rate, notes FROM assignments;
    DROP TABLE assignments;
    ALTER TABLE assignments_new RENAME TO assignments;
    COMMIT;`);
}

// Annexures created before monthly attendance existed: add the summary columns and derive them from the daily counts.
if (!db.prepare("SELECT 1 FROM pragma_table_info('invoice_annexure') WHERE name = 'days_worked'").get()) {
  db.exec(`BEGIN;
    ALTER TABLE invoice_annexure ADD COLUMN days_worked REAL NOT NULL DEFAULT 0;
    ALTER TABLE invoice_annexure ADD COLUMN lop_days REAL NOT NULL DEFAULT 0;
    ALTER TABLE invoice_annexure ADD COLUMN attendance_source TEXT NOT NULL DEFAULT 'Daily';
    UPDATE invoice_annexure SET days_worked = present + half_day * 0.5, lop_days = absent + unpaid_leave + half_day * 0.5;
    COMMIT;`);
}

// Columns added after a table was first released.
function addColumn(table, column, definition) {
  if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('monthly_attendance', 'leave_days', 'REAL NOT NULL DEFAULT 0');
addColumn('payslips', 'leave_days', 'REAL NOT NULL DEFAULT 0');
addColumn('employees', 'pt_exempt', 'INTEGER NOT NULL DEFAULT 0');
addColumn('employees', 'resignation_date', 'TEXT');
// Agency (service) charges billed to a customer on top of manpower: None, Percent (of the manpower amount) or Fixed (₹ per invoice).
addColumn('customers', 'agency_charge_type', "TEXT NOT NULL DEFAULT 'None'");
addColumn('customers', 'agency_charge_value', 'REAL NOT NULL DEFAULT 0');
// Invoices: agency charges on the subtotal (copied from the customer, editable per invoice) and GST in two components.
// tax_rate and tax_amount hold the combined GST.
addColumn('invoices', 'agency_charge_type', "TEXT NOT NULL DEFAULT 'None'");
addColumn('invoices', 'agency_charge_value', 'REAL NOT NULL DEFAULT 0');
addColumn('invoices', 'agency_amount', 'REAL NOT NULL DEFAULT 0');
addColumn('invoices', 'cgst_rate', 'REAL NOT NULL DEFAULT 0');
addColumn('invoices', 'sgst_rate', 'REAL NOT NULL DEFAULT 0');
addColumn('invoices', 'cgst_amount', 'REAL NOT NULL DEFAULT 0');
addColumn('invoices', 'sgst_amount', 'REAL NOT NULL DEFAULT 0');

// Designation and department moved from employees to assignments: add the columns and, once, copy each employee's
// values onto their existing assignments.
addColumn('assignments', 'designation', 'TEXT');
addColumn('assignments', 'department', 'TEXT');
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'assignment_designations_copied'").get()) {
  db.exec(`BEGIN;
    UPDATE assignments SET
      designation = COALESCE(NULLIF(designation, ''), (SELECT designation FROM employees WHERE id = assignments.employee_id)),
      department = COALESCE(NULLIF(department, ''), (SELECT department FROM employees WHERE id = assignments.employee_id));
    INSERT INTO settings (key, value) VALUES ('assignment_designations_copied', '1');
    COMMIT;`);
}

// Billing rates moved from the per-designation rate card onto each assignment: once, give every assignment that
// relied on the rate card the rate its designation has (the rate card table is kept but no longer used).
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'assignment_rates_copied'").get()) {
  db.exec(`BEGIN;
    UPDATE assignments SET
      billing_type = (SELECT r.billing_type FROM designation_rates r WHERE r.designation = TRIM(COALESCE(NULLIF(assignments.designation, ''),
        (SELECT designation FROM employees WHERE id = assignments.employee_id)))),
      rate = (SELECT r.rate FROM designation_rates r WHERE r.designation = TRIM(COALESCE(NULLIF(assignments.designation, ''),
        (SELECT designation FROM employees WHERE id = assignments.employee_id))))
    WHERE billing_type IS NULL OR billing_type = '' OR rate IS NULL;
    INSERT INTO settings (key, value) VALUES ('assignment_rates_copied', '1');
    COMMIT;`);
}
addColumn('payslips', 'employer_contributions', 'REAL NOT NULL DEFAULT 0');

// Pay components created before the current kinds and calc types existed (employer contributions, EPF/ESI, Telangana PT):
// rebuild the table so its CHECK constraints allow them.
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pay_components'").get().sql.includes("'Employer'")) {
  db.exec(`BEGIN;
    ${PAY_COMPONENTS_TABLE('pay_components_new')}
    INSERT INTO pay_components_new (id, profile_id, name, kind, calc, value, sort)
      SELECT id, profile_id, name, kind, calc, value, sort FROM pay_components;
    DROP TABLE pay_components;
    ALTER TABLE pay_components_new RENAME TO pay_components;
    COMMIT;`);
}

// Monthly entries used to hold days worked, paid leave and LOP days. Now only (unpaid) leave days are kept:
// fold the old LOP days into leave and drop the other columns.
if (db.prepare("SELECT 1 FROM pragma_table_info('monthly_attendance') WHERE name = 'days_worked'").get()) {
  db.exec(`BEGIN;
    UPDATE monthly_attendance SET leave_days = leave_days + lop_days;
    ALTER TABLE monthly_attendance DROP COLUMN days_worked;
    ALTER TABLE monthly_attendance DROP COLUMN lop_days;
    COMMIT;`);
}

// Re-entrant transaction helper: nested calls join the outer transaction.
let txDepth = 0;
function tx(fn) {
  if (txDepth) return fn();
  txDepth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}

const DEFAULT_SETTINGS = {
  company_name: 'Smart Consulting',
  company_address: '',
  company_gstin: '',
  company_email: '',
  company_phone: '',
  invoice_prefix: 'INV-',
  default_tax_rate: '18',
  tax_label: 'GST',
  cgst_rate: '9',
  sgst_rate: '9',
  payment_terms_days: '30',
  pf_wage_ceiling: '15000',
  bank_details: '',
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertDefault.run(key, value);
insertDefault.run('session_secret', crypto.randomBytes(32).toString('hex'));

// Once: split existing invoices' GST evenly into CGST and SGST, and move the "Agency charges" line that draft invoices
// got from the earlier version into the invoice's agency charges (taken from the customer), then recompute the totals.
if (getSetting('invoice_gst_split') !== '1') {
  const r2 = n => Math.round(n * 100) / 100;
  tx(() => {
    db.exec(`UPDATE invoices SET cgst_rate = tax_rate / 2.0, sgst_rate = tax_rate / 2.0,
      cgst_amount = ROUND(tax_amount / 2.0, 2), sgst_amount = tax_amount - ROUND(tax_amount / 2.0, 2)`);
    const drafts = db.prepare(`SELECT DISTINCT i.id, i.cgst_rate, i.sgst_rate, c.agency_charge_type, c.agency_charge_value
      FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'Draft' AND l.description LIKE 'Agency charges%'`).all();
    for (const inv of drafts) {
      db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ? AND description LIKE 'Agency charges%'").run(inv.id);
      const subtotal = r2(db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_lines WHERE invoice_id = ?').get(inv.id).s);
      const v = Number(inv.agency_charge_value) || 0;
      const agency = subtotal <= 0 ? 0 : inv.agency_charge_type === 'Percent' ? r2((subtotal * v) / 100) : inv.agency_charge_type === 'Fixed' ? r2(v) : 0;
      const cgst = r2(((subtotal + agency) * inv.cgst_rate) / 100);
      const sgst = r2(((subtotal + agency) * inv.sgst_rate) / 100);
      db.prepare(`UPDATE invoices SET agency_charge_type = ?, agency_charge_value = ?, agency_amount = ?, subtotal = ?,
        cgst_amount = ?, sgst_amount = ?, tax_amount = ?, total = ? WHERE id = ?`)
        .run(inv.agency_charge_type, v, agency, subtotal, cgst, sgst, r2(cgst + sgst), r2(subtotal + agency + cgst + sgst), inv.id);
    }
    setSetting('invoice_gst_split', '1');
  });
}

// First run: create the admin account and a starter pay profile.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  tx(() => {
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('admin', 'Administrator', bcrypt.hashSync(password, 10), 'admin');

    const profile = db.prepare('INSERT INTO pay_profiles (name, description) VALUES (?, ?)').run(
      'Standard',
      'Basic 50% of gross, HRA 40% of basic, balance as special allowance; EPF 12% and ESI 0.75% (employer 13% and 3.25%), Telangana professional tax'
    );
    const comp = db.prepare('INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, ?, ?, ?, ?, ?)');
    [
      ['Basic', 'Earning', 'PctGross', 50],
      ['HRA', 'Earning', 'PctBasic', 40],
      ['Special Allowance', 'Earning', 'Balance', 0],
      ['EPF', 'Deduction', 'EPF', 12],
      ['ESI', 'Deduction', 'ESI', 0.75],
      ['Professional Tax', 'Deduction', 'PTTelangana', 0],
      ['Employer EPF', 'Employer', 'EPF', 13],
      ['Employer ESI', 'Employer', 'ESI', 3.25],
    ].forEach((c, i) => comp.run(profile.lastInsertRowid, ...c, i));
  });
  console.log(`Created initial admin user "admin"${process.env.ADMIN_PASSWORD ? '' : ' with password "admin123" — change it after first login'}.`);
}

module.exports = { db, tx, getSetting, setSetting, getSettings };
