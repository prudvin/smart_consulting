const express = require('express');
const { db } = require('../db');
const f = require('../format');
const { currentAssignmentValue } = require('../services/designation');
const { flash, isUniqueError } = require('../middleware');

const router = express.Router();

function readPay(body) {
  return {
    employee_id: Number(body.employee_id) || null,
    profile_id: Number(body.profile_id) || null,
    monthly_gross: Number(body.monthly_gross) || 0,
    effective_from: String(body.effective_from || '').trim(),
  };
}

function validate(p) {
  if (!p.employee_id || !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(p.employee_id)) return 'Select an employee.';
  if (!p.profile_id || !db.prepare('SELECT 1 FROM pay_profiles WHERE id = ?').get(p.profile_id)) return 'Select a pay profile.';
  if (!(p.monthly_gross > 0)) return 'Monthly gross must be greater than zero.';
  if (!f.isDate(p.effective_from)) return 'Effective-from date is required.';
  return null;
}

const renderForm = (res, p, isNew, error) =>
  res.status(error ? 400 : 200).render('employee-pay/form', {
    title: isNew ? 'Assign pay profile' : 'Edit employee salary', p, isNew, error,
    employees: db.prepare("SELECT id, code, name FROM employees WHERE status = 'Active' OR id = ? ORDER BY name").all(p.employee_id || 0),
    profiles: db.prepare('SELECT id, name FROM pay_profiles ORDER BY name').all(),
  });

// Every employee with the customers they are assigned to today, their current pay (the latest record effective
// today), and the next upcoming change, if any.
router.get('/', (req, res) => {
  const today = f.today();
  const employees = db.prepare(`
    SELECT e.id, e.code, e.name, ${currentAssignmentValue('designation')} AS designation, e.status,
      (SELECT GROUP_CONCAT(name, ', ') FROM (
        SELECT DISTINCT c.name FROM assignments a JOIN customers c ON c.id = a.customer_id
        WHERE a.employee_id = e.id AND a.start_date <= :today AND COALESCE(NULLIF(a.end_date, ''), '9999-12-31') >= :today
          AND COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31') >= :today
        ORDER BY c.name)) AS customers,
      cur.profile_id, cur.monthly_gross, cur.effective_from, cp.name AS profile_name,
      nxt.monthly_gross AS next_gross, nxt.effective_from AS next_from, np.name AS next_profile
    FROM employees e
    LEFT JOIN employee_pay cur ON cur.id = (
      SELECT id FROM employee_pay WHERE employee_id = e.id AND effective_from <= :today ORDER BY effective_from DESC LIMIT 1)
    LEFT JOIN pay_profiles cp ON cp.id = cur.profile_id
    LEFT JOIN employee_pay nxt ON nxt.id = (
      SELECT id FROM employee_pay WHERE employee_id = e.id AND effective_from > :today ORDER BY effective_from LIMIT 1)
    LEFT JOIN pay_profiles np ON np.id = nxt.profile_id
    ORDER BY e.status = 'Inactive', e.code`).all({ today });
  const distinct = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  res.render('employee-pay/list', {
    title: 'Employee salary', employees,
    profiles: db.prepare('SELECT id, name FROM pay_profiles ORDER BY name').all(),
    defaultEffective: f.monthStart(f.currentMonth()),
    filterOptions: {
      designations: distinct(employees.map(e => e.designation)),
      customers: distinct(employees.flatMap(e => (e.customers || '').split(', '))),
      profiles: distinct(employees.map(e => e.profile_name)),
    },
  });
});

// Change an employee's pay from a date (from the popup on the list). Adds a pay record from that date so earlier
// payroll keeps its history; if a record already starts on that date, it is updated instead.
router.post('/change', (req, res) => {
  const p = readPay(req.body);
  const error = validate(p);
  if (error) {
    flash(req, 'error', error);
    return res.redirect('/employee-pay');
  }
  db.prepare(`
    INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, effective_from) DO UPDATE SET profile_id = excluded.profile_id, monthly_gross = excluded.monthly_gross`)
    .run(p.employee_id, p.profile_id, p.monthly_gross, p.effective_from);
  const e = db.prepare('SELECT name FROM employees WHERE id = ?').get(p.employee_id);
  const profile = db.prepare('SELECT name FROM pay_profiles WHERE id = ?').get(p.profile_id);
  flash(req, 'success', `Pay for ${e.name} set to "${profile.name}", ${f.money(p.monthly_gross)} a month from ${f.fmtDate(p.effective_from)}.`);
  res.redirect('/employee-pay');
});


router.get('/new', (req, res) => {
  renderForm(res, {
    employee_id: Number(req.query.employee_id) || null,
    profile_id: null,
    monthly_gross: '',
    effective_from: f.monthStart(f.currentMonth()),
  }, true, null);
});

router.post('/', (req, res) => {
  const p = readPay(req.body);
  let error = validate(p);
  if (!error) {
    try {
      db.prepare('INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, ?, ?)')
        .run(p.employee_id, p.profile_id, p.monthly_gross, p.effective_from);
      flash(req, 'success', 'Pay profile assigned.');
      return res.redirect(req.body.return_to === 'employee' ? `/employees/${p.employee_id}` : '/employee-pay');
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'This employee already has a pay record with that effective date. Edit it instead.';
    }
  }
  renderForm(res, p, true, error);
});

router.get('/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM employee_pay WHERE id = ?').get(Number(req.params.id));
  if (!p) return next();
  renderForm(res, p, false, null);
});

router.post('/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM employee_pay WHERE id = ?').get(id)) return next();
  const p = { ...readPay(req.body), id };
  let error = validate(p);
  if (!error) {
    try {
      db.prepare('UPDATE employee_pay SET employee_id = ?, profile_id = ?, monthly_gross = ?, effective_from = ? WHERE id = ?')
        .run(p.employee_id, p.profile_id, p.monthly_gross, p.effective_from, id);
      flash(req, 'success', 'Employee salary updated.');
      return res.redirect('/employee-pay');
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'This employee already has a pay record with that effective date.';
    }
  }
  renderForm(res, p, false, error);
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM employee_pay WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'Pay record deleted.');
  res.redirect('/employee-pay');
});

module.exports = router;
