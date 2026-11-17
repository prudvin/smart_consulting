const express = require('express');
const { db, tx } = require('../db');
const f = require('../format');
const { BILLING_TYPES } = require('../constants');
const { currentAssignmentValue } = require('../services/designation');
const { flash, pick, toDb } = require('../middleware');

const router = express.Router();
const FIELDS = ['employee_id', 'customer_id', 'role', 'designation', 'department', 'start_date', 'end_date', 'billing_type', 'rate', 'notes'];

function readAssignment(body) {
  const a = pick(body, FIELDS);
  a.close_previous = body.close_previous === '1';
  a.employee_id = Number(a.employee_id) || null;
  a.customer_id = Number(a.customer_id) || null;
  if (!BILLING_TYPES[a.billing_type]) a.billing_type = '';
  a.rate = a.rate !== '' ? Number(a.rate) : '';
  return a;
}

function validate(a) {
  if (!a.employee_id || !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(a.employee_id)) return 'Select an employee.';
  if (!a.customer_id || !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(a.customer_id)) return 'Select a customer.';
  if (!a.designation) return 'Designation is required (it sets the billing rate).';
  if (!f.isDate(a.start_date)) return 'Start date is required.';
  if (a.end_date && !f.isDate(a.end_date)) return 'End date is invalid.';
  if (a.end_date && a.end_date < a.start_date) return 'End date cannot be before the start date.';
  if (!a.billing_type) return 'Choose how the customer is billed (per month, day or hour).';
  if (a.rate === '' || !(a.rate >= 0)) return 'Enter the billing rate.';
  return null;
}

// Suggestions for designation and department (values in use), and each employee's current values,
// used to prefill a new assignment.
const distinctValues = sql => db.prepare(sql).all().map(r => r.v).filter(Boolean);
function formOptions(a) {
  return {
    employees: db.prepare(`SELECT e.id, e.code, e.name, ${currentAssignmentValue('designation')} AS designation, ${currentAssignmentValue('department')} AS department
      FROM employees e WHERE e.status = 'Active' OR e.id = ? ORDER BY e.name`).all(a.employee_id || 0),
    designationOptions: distinctValues("SELECT DISTINCT TRIM(designation) AS v FROM assignments WHERE TRIM(COALESCE(designation, '')) <> '' ORDER BY 1"),
    departmentOptions: distinctValues("SELECT DISTINCT TRIM(department) AS v FROM assignments WHERE TRIM(COALESCE(department, '')) <> '' ORDER BY 1"),
    customers: db.prepare("SELECT id, name FROM customers WHERE status = 'Active' OR id = ? ORDER BY name").all(a.customer_id || 0),
    BILLING_TYPES,
  };
}

// Assignments of an employee still running on a date (a new assignment starting then would end them).
const openAssignmentsOn = (employeeId, date, exceptId = 0) => db.prepare(`
  SELECT a.*, c.name AS customer_name FROM assignments a JOIN customers c ON c.id = a.customer_id
  WHERE a.employee_id = ? AND a.id <> ? AND a.start_date < ? AND COALESCE(NULLIF(a.end_date, ''), '9999-12-31') >= ?
  ORDER BY a.start_date`).all(employeeId, exceptId, date, date);

// panel: render the form for the slide-over panel on the Employees list (employee fixed) instead of the full page.
function renderForm(res, a, isNew, error, panel = false) {
  const lockEmployee = panel && a.employee_id ? db.prepare('SELECT id, code, name FROM employees WHERE id = ?').get(a.employee_id) : null;
  const openAssignments = isNew && a.employee_id ? openAssignmentsOn(a.employee_id, f.isDate(a.start_date) ? a.start_date : f.today()) : [];
  res.status(error ? 400 : 200).render(lockEmployee ? 'assignments/form-panel' : 'assignments/form', {
    title: isNew ? 'New assignment' : 'Edit assignment', a, isNew, error, lockEmployee, openAssignments, ...formOptions(a),
  });
}
const fromPanel = req => req.query.panel === '1' || (req.body && req.body._panel === '1');

// There is no assignments list: assignments are managed from each employee's details.
router.get('/', (req, res) => res.redirect('/employees'));

router.get('/new', (req, res) => {
  const employeeId = Number(req.query.employee_id) || null;
  const current = employeeId ? db.prepare(`SELECT ${currentAssignmentValue('designation')} AS designation, ${currentAssignmentValue('department')} AS department FROM employees e WHERE e.id = ?`).get(employeeId) : null;
  const lastRate = employeeId ? db.prepare(`SELECT billing_type, rate FROM assignments WHERE employee_id = ? AND billing_type IS NOT NULL
    ORDER BY start_date DESC, id DESC LIMIT 1`).get(employeeId) : null;
  renderForm(res, {
    employee_id: employeeId,
    designation: current ? current.designation : '',
    department: current ? current.department : '',
    billing_type: lastRate ? lastRate.billing_type : 'Monthly',
    rate: lastRate ? lastRate.rate : '',
    customer_id: Number(req.query.customer_id) || null,
    start_date: f.today(),
  }, true, null, fromPanel(req));
});

// Creating an assignment ends the employee's current assignments the day before it starts, unless
// "End current assignment(s)" is unticked (e.g. for someone shared between customers).
router.post('/', (req, res) => {
  const a = readAssignment(req.body);
  const error = validate(a);
  if (error) return renderForm(res, a, true, error, fromPanel(req));
  const end = f.addDays(a.start_date, -1);
  const ended = tx(() => {
    const id = Number(db.prepare(`INSERT INTO assignments (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`)
      .run(...toDb(a, FIELDS)).lastInsertRowid);
    if (!a.close_previous) return [];
    const open = openAssignmentsOn(a.employee_id, a.start_date, id);
    const stmt = db.prepare('UPDATE assignments SET end_date = ? WHERE id = ?');
    open.forEach(o => stmt.run(end, o.id));
    return open;
  });
  if (fromPanel(req)) return res.redirect(`/employees/${a.employee_id}?panel=1&saved=assignment&ended=${ended.length}`);
  const endedMsg = ended.length ? ` Ended ${ended.map(o => o.customer_name).join(', ')} on ${f.fmtDate(end)}.` : '';
  flash(req, 'success', `Assignment created.${endedMsg}`);
  res.redirect(`/employees/${a.employee_id}`);
});

router.get('/:id/edit', (req, res, next) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(req.params.id));
  if (!a) return next();
  renderForm(res, a, false, null, fromPanel(req));
});

router.post('/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM assignments WHERE id = ?').get(id)) return next();
  const a = { ...readAssignment(req.body), id };
  const error = validate(a);
  if (error) return renderForm(res, a, false, error, fromPanel(req));
  db.prepare(`UPDATE assignments SET ${FIELDS.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...toDb(a, FIELDS), id);
  if (fromPanel(req)) return res.redirect(`/employees/${a.employee_id}?panel=1&saved=assignment`);
  flash(req, 'success', 'Assignment updated.');
  res.redirect(`/employees/${a.employee_id}`);
});

router.post('/:id/delete', (req, res) => {
  const a = db.prepare('SELECT employee_id FROM assignments WHERE id = ?').get(Number(req.params.id));
  db.prepare('DELETE FROM assignments WHERE id = ?').run(Number(req.params.id));
  flash(req, 'success', 'Assignment deleted.');
  res.redirect(a ? `/employees/${a.employee_id}` : '/employees');
});

module.exports = router;
