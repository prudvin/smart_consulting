const express = require('express');
const { db } = require('../db');
const f = require('../format');
const { attendanceFor, employedFrom, employedTo } = require('../services/attendance');
const { currentAssignmentValue } = require('../services/designation');
// Employee columns plus their latest customer, designation and department (from their assignments).
const WITH_CURRENT = `SELECT e.*, ${currentAssignmentValue('customer')} AS cur_customer,
  ${currentAssignmentValue('designation')} AS cur_designation, ${currentAssignmentValue('department')} AS cur_department FROM employees e`;
const { flash, isUniqueError, isForeignKeyError, pick, toDb } = require('../middleware');

const router = express.Router();
const FIELDS = ['code', 'name', 'email', 'phone', 'join_date', 'resignation_date', 'status',
  'pan', 'bank_name', 'bank_account', 'ifsc', 'pt_exempt'];

function readEmployee(body) {
  const e = pick(body, FIELDS);
  e.pt_exempt = body.pt_exempt === '1' ? 1 : 0;
  if (!['Active', 'Inactive'].includes(e.status)) e.status = 'Active';
  // An employee with a resignation date (their last working day) is inactive.
  if (e.resignation_date) e.status = 'Inactive';
  e.pan = e.pan.toUpperCase();
  e.ifsc = e.ifsc.toUpperCase();
  return e;
}

function validate(e) {
  if (!e.code) return 'Employee code is required.';
  if (!e.name) return 'Name is required.';
  if (e.join_date && !f.isDate(e.join_date)) return 'Join date is invalid.';
  if (e.resignation_date && !f.isDate(e.resignation_date)) return 'Resignation date is invalid.';
  if (e.resignation_date && e.join_date && e.resignation_date < e.join_date) return 'Resignation date cannot be before the join date.';
  return null;
}

function nextCode() {
  const rows = db.prepare("SELECT code FROM employees WHERE code GLOB 'EMP[0-9]*'").all();
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.code.slice(3), 10) || 0), 0);
  return `EMP${String(max + 1).padStart(3, '0')}`;
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status ?? 'Active');
  const filters = {
    customer: String(req.query.customer || ''),
    designation: String(req.query.designation || ''),
    department: String(req.query.department || ''),
  };
  let sql = `SELECT * FROM (${WITH_CURRENT}) WHERE 1 = 1`;
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    if (value === '__none__') sql += ` AND cur_${key} IS NULL`;
    else { sql += ` AND cur_${key} = ?`; params.push(value); }
  }
  if (q) {
    sql += ' AND (name LIKE ? OR code LIKE ? OR email LIKE ? OR cur_customer LIKE ? OR cur_designation LIKE ? OR cur_department LIKE ?)';
    params.push(...Array(6).fill(`%${q}%`));
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  const employees = db.prepare(`${sql} ORDER BY code`).all(...params);
  // Dropdown choices: every latest customer / designation / department across all employees.
  const all = db.prepare(`SELECT cur_customer, cur_designation, cur_department FROM (${WITH_CURRENT})`).all();
  const distinct = key => [...new Set(all.map(r => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const options = { customer: distinct('cur_customer'), designation: distinct('cur_designation'), department: distinct('cur_department') };
  res.render('employees/list', { title: 'Employees', employees, q, status, filters, options });
});

router.get('/new', (req, res) => {
  res.render('employees/form', { title: 'Add employee', e: { code: nextCode(), status: 'Active', join_date: f.today() }, isNew: true, error: null });
});

router.post('/', (req, res) => {
  const e = readEmployee(req.body);
  let error = validate(e);
  if (!error) {
    try {
      const id = db.prepare(`INSERT INTO employees (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`)
        .run(...toDb(e, FIELDS)).lastInsertRowid;
      flash(req, 'success', `Employee ${e.name} added.`);
      return res.redirect(`/employees/${id}`);
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'That employee code is already in use.';
    }
  }
  res.status(400).render('employees/form', { title: 'Add employee', e, isNew: true, error });
});

router.get('/:id', (req, res, next) => {
  const e = db.prepare(`${WITH_CURRENT} WHERE e.id = ?`).get(Number(req.params.id));
  if (!e) return next();
  const assignments = db.prepare(`
    SELECT a.*, c.name AS customer_name FROM assignments a JOIN customers c ON c.id = a.customer_id
    WHERE a.employee_id = ? ORDER BY a.start_date DESC`).all(e.id);
  const pay = db.prepare(`
    SELECT ep.*, p.name AS profile_name FROM employee_pay ep JOIN pay_profiles p ON p.id = ep.profile_id
    WHERE ep.employee_id = ? ORDER BY ep.effective_from DESC`).all(e.id);
  const month = f.currentMonth();
  const leaveThisMonth = attendanceFor(e, month, employedFrom(e.join_date, month), employedTo(e.resignation_date, month)).leave;
  const payslips = db.prepare(`
    SELECT s.id, s.net_pay, s.paid_days, r.month FROM payslips s JOIN payroll_runs r ON r.id = s.run_id
    WHERE s.employee_id = ? ORDER BY r.month DESC LIMIT 12`).all(e.id);
  const monthlyEntry = db.prepare('SELECT * FROM monthly_attendance WHERE employee_id = ? AND month = ?').get(e.id, month);
  const ended = Number(req.query.ended) || 0;
  const savedMsg = req.query.saved === 'assignment'
    ? `Assignment saved.${ended ? ` ${ended} previous assignment${ended === 1 ? '' : 's'} ended the day before it starts.` : ''}`
    : req.query.saved === '1' ? 'Employee details saved.' : null;
  const fromCustomer = Number(req.query.from_customer) ? db.prepare('SELECT id, name FROM customers WHERE id = ?').get(Number(req.query.from_customer)) : null;
  const data = { title: e.name, e, assignments, pay, leaveThisMonth, monthlyEntry, payslips, month, savedMsg, fromCustomer };
  // ?panel=1: just the details, for the slide-over panel on the Employees list.
  res.render(req.query.panel === '1' ? 'employees/panel' : 'employees/show', data);
});

router.get('/:id/edit', (req, res, next) => {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!e) return next();
  // ?panel=1: just the form, for the slide-over panel on the Employees list.
  res.render(req.query.panel === '1' ? 'employees/edit-panel' : 'employees/form', { title: `Edit ${e.name}`, e, isNew: false, error: null });
});

router.post('/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(id)) return next();
  const e = { ...readEmployee(req.body), id };
  let error = validate(e);
  if (!error) {
    try {
      db.prepare(`UPDATE employees SET ${FIELDS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...toDb(e, FIELDS), id);
      // From the panel, go back to the details panel; otherwise to the employee page.
      if (req.body._panel === '1') return res.redirect(`/employees/${id}?panel=1&saved=1`);
      flash(req, 'success', 'Employee updated.');
      return res.redirect(`/employees/${id}`);
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'That employee code is already in use.';
    }
  }
  res.status(400).render(req.body._panel === '1' ? 'employees/edit-panel' : 'employees/form', { title: 'Edit employee', e, isNew: false, error });
});

router.post('/:id/delete', (req, res) => {
  try {
    db.prepare('DELETE FROM employees WHERE id = ?').run(Number(req.params.id));
    flash(req, 'success', 'Employee deleted.');
    res.redirect('/employees');
  } catch (err) {
    if (!isForeignKeyError(err)) throw err;
    flash(req, 'error', 'This employee has payslips and cannot be deleted. Mark them Inactive instead.');
    res.redirect(`/employees/${Number(req.params.id)}`);
  }
});

module.exports = router;
