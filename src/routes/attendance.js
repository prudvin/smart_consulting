const express = require('express');
const { db, tx } = require('../db');
const f = require('../format');
const { ATTENDANCE } = require('../constants');
const { flash } = require('../middleware');
const { currentAssignmentValue } = require('../services/designation');
const { summarizeDaily, attendanceFor, employedFrom, employedTo, employedInMonth } = require('../services/attendance');

const router = express.Router();

const COLUMNS = `e.id, e.code, e.name, ${currentAssignmentValue('designation')} AS designation, e.join_date, e.resignation_date`;
// Employees on the books on a date: active, or resigned with a last working day on or after it.
const activeEmployeesOn = date => db.prepare(`SELECT ${COLUMNS} FROM employees e
  WHERE (e.status = 'Active' OR e.resignation_date >= ?) AND (e.join_date IS NULL OR e.join_date <= ?) ORDER BY e.code`).all(date, date);
// Employees on the books at any point in a month (including those who resigned during it), with the customers they
// worked for in that month and their designation at the month end. (month is a validated YYYY-MM.)
const employeesInMonth = month => {
  const c = employedInMonth(month);
  const start = f.monthStart(month);
  const end = f.monthEnd(month);
  return db.prepare(`SELECT ${COLUMNS},
      ${currentAssignmentValue('designation', 'e', `'${end}'`)} AS month_designation,
      (SELECT GROUP_CONCAT(name, ', ') FROM (
        SELECT DISTINCT cu.name FROM assignments a JOIN customers cu ON cu.id = a.customer_id
        WHERE a.employee_id = e.id AND a.start_date <= '${end}'
          AND MIN(COALESCE(NULLIF(a.end_date, ''), '9999-12-31'), COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31')) >= '${start}'
        ORDER BY cu.name)) AS month_customers,
      (SELECT GROUP_CONCAT(DISTINCT a.customer_id) FROM assignments a
        WHERE a.employee_id = e.id AND a.start_date <= '${end}'
          AND MIN(COALESCE(NULLIF(a.end_date, ''), '9999-12-31'), COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31')) >= '${start}'
      ) AS month_customer_ids
    FROM employees e WHERE ${c.sql} ORDER BY e.code`).all(...c.params)
    .map(e => ({ ...e, customerIds: e.month_customer_ids ? String(e.month_customer_ids).split(',').map(Number) : [] }));
};

// Customers whose attendance is finalized for a month: customer id -> { name, finalized_at, finalized_by_name }.
const finalizedCustomers = month => new Map(db.prepare(`
  SELECT af.customer_id, af.finalized_at, cu.name, u.name AS finalized_by_name
  FROM attendance_finalized af JOIN customers cu ON cu.id = af.customer_id LEFT JOIN users u ON u.id = af.finalized_by
  WHERE af.month = ?`).all(month).map(r => [r.customer_id, r]));
// Names of the finalized customers that lock an employee's leave days for the month (empty if not locked).
const lockedBy = (e, finalized) => e.customerIds.filter(id => finalized.has(id)).map(id => finalized.get(id).name);
// Employee ids locked for a month by a finalized customer.
const lockedEmployeeIds = month => {
  const finalized = finalizedCustomers(month);
  if (!finalized.size) return new Set();
  return new Set(employeesInMonth(month).filter(e => lockedBy(e, finalized).length).map(e => e.id));
};
const monthlyEntries = month =>
  new Map(db.prepare('SELECT * FROM monthly_attendance WHERE month = ?').all(month).map(r => [r.employee_id, r]));

// Attendance is maintained monthly.
router.get('/', (req, res) => res.redirect('/attendance/month'));

// Daily sheet: mark every active employee for one date. Not linked from the menus (attendance is entered monthly);
// existing daily records still apply to months without a monthly entry.
router.get('/daily', (req, res) => {
  const date = f.isDate(req.query.date) ? req.query.date : f.today();
  const employees = activeEmployeesOn(date);
  const records = new Map(db.prepare('SELECT * FROM attendance WHERE date = ?').all(date).map(r => [r.employee_id, r]));
  res.render('attendance/daily', {
    title: 'Attendance', date, employees, records, ATTENDANCE, entries: monthlyEntries(date.slice(0, 7)),
    prev: f.addDays(date, -1), next: f.addDays(date, 1),
  });
});

// Monthly entry: leave days (unpaid) per employee for a month; every other weekday counts as worked.
// An entry overrides the employee's daily records for that month in payroll and invoicing.
function renderMonthEntry(res, month, posted, error) {
  const start = f.monthStart(month);
  const end = f.monthEnd(month);
  const entries = monthlyEntries(month);
  const daily = new Map();
  for (const r of db.prepare('SELECT employee_id, status, hours FROM attendance WHERE date BETWEEN ? AND ?').all(start, end)) {
    if (!daily.has(r.employee_id)) daily.set(r.employee_id, []);
    daily.get(r.employee_id).push(r);
  }

  const finalized = finalizedCustomers(month);
  const employees = employeesInMonth(month);
  const rows = employees.map(e => {
    const from = employedFrom(e.join_date, month);
    const to = employedTo(e.resignation_date, month);
    const entry = entries.get(e.id);
    const locked = lockedBy(e, finalized);
    const p = !locked.length && posted && posted[`e${e.id}`];
    const d = daily.has(e.id) ? summarizeDaily(daily.get(e.id)) : null;
    return {
      ...e,
      employedDays: f.daysBetween(from, to),
      weekdays: f.weekdaysBetween(from, to),
      // Leave recorded day by day, shown for reference and used by "fill from daily".
      dailyLeave: d ? d.leave : null,
      hasEntry: Boolean(entry),
      leave_days: p ? p.leave_days : entry ? entry.leave_days : '',
      note: p ? p.note : entry ? entry.note || '' : '',
      locked,
    };
  });

  // Customers with consultants this month, with their finalization status.
  const counts = new Map();
  for (const e of employees) for (const id of e.customerIds) counts.set(id, (counts.get(id) || 0) + 1);
  const names = new Map(db.prepare('SELECT id, name FROM customers').all().map(c => [c.id, c.name]));
  const customers = [...counts].map(([id, consultants]) => ({ id, name: names.get(id), consultants, finalized: finalized.get(id) || null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.status(error ? 400 : 200).render('attendance/month', {
    title: `Monthly attendance — ${f.monthLabel(month)}`, month, rows, error, dim: f.daysInMonth(month),
    customers, hasDaily: daily.size > 0,
    prev: f.addMonths(month, -1), next: f.addMonths(month, 1),
  });
}

router.get('/month', (req, res) => {
  renderMonthEntry(res, f.isMonth(req.query.month) ? req.query.month : f.currentMonth(), null, null);
});

router.post('/month', (req, res) => {
  const month = String(req.body.month || '');
  if (!f.isMonth(month)) {
    flash(req, 'error', 'Invalid month.');
    return res.redirect('/attendance/month');
  }
  const end = f.monthEnd(month);
  const finalized = finalizedCustomers(month);
  const employees = new Map(employeesInMonth(month).map(e => [e.id, e]));
  const posted = req.body.rows || {};
  const toSave = [];
  const toDelete = [];
  let skippedLocked = 0;
  let error = null;

  // Keys are "e<employeeId>" so the body parser keeps them as object keys rather than array indexes.
  for (const [key, row] of Object.entries(posted)) {
    const e = employees.get(Number(key.slice(1)));
    if (!e) continue;
    // Leave days of consultants of a finalized customer can't be changed until the customer is reopened.
    if (lockedBy(e, finalized).length) {
      skippedLocked++;
      continue;
    }
    const raw = String(row.leave_days ?? '').trim();
    if (raw === '') {
      toDelete.push(e.id);
      continue;
    }
    const leave = Number(raw);
    const workingDays = f.weekdaysBetween(employedFrom(e.join_date, month), employedTo(e.resignation_date, month));
    if (!(leave >= 0)) error = `${e.name}: leave days must be zero or more.`;
    else if ((leave * 2) % 1) error = `${e.name}: use whole or half days.`;
    else if (leave > workingDays) error = `${e.name}: ${leave} leave days is more than the ${workingDays} working days this month.`;
    if (error) break;
    toSave.push([e.id, month, leave, String(row.note || '').trim() || null]);
  }
  if (error) return renderMonthEntry(res, month, posted, error);

  const upsert = db.prepare(`
    INSERT INTO monthly_attendance (employee_id, month, leave_days, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, month) DO UPDATE SET leave_days = excluded.leave_days, note = excluded.note`);
  const remove = db.prepare('DELETE FROM monthly_attendance WHERE employee_id = ? AND month = ?');
  tx(() => {
    toSave.forEach(r => upsert.run(...r));
    toDelete.forEach(id => remove.run(id, month));
  });
  const lockedMsg = skippedLocked ? ` ${skippedLocked} finalized employee${skippedLocked === 1 ? ' was' : 's were'} not changed.` : '';
  flash(req, 'success', `Leave days saved for ${f.monthLabel(month)} (${toSave.length} employee${toSave.length === 1 ? '' : 's'}).${lockedMsg}`);
  res.redirect(`/attendance/month?month=${month}`);
});

// Finalize a customer's attendance for a month: locks the leave days of the consultants who worked for it.
router.post('/month/finalize', (req, res) => {
  const month = String(req.body.month || '');
  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(Number(req.body.customer_id) || 0);
  if (!f.isMonth(month) || !customer) {
    flash(req, 'error', 'Choose a valid customer and month.');
    return res.redirect(`/attendance/month${f.isMonth(month) ? `?month=${month}` : ''}`);
  }
  const r = db.prepare('INSERT INTO attendance_finalized (customer_id, month, finalized_by) VALUES (?, ?, ?) ON CONFLICT(customer_id, month) DO NOTHING')
    .run(customer.id, month, req.user.id);
  flash(req, r.changes ? 'success' : 'info', r.changes
    ? `Attendance for ${customer.name} finalized for ${f.monthLabel(month)}.`
    : `Attendance for ${customer.name} was already finalized for ${f.monthLabel(month)}.`);
  res.redirect(`/attendance/month?month=${month}`);
});

// Reopen a finalized customer's attendance (administrators only).
router.post('/month/reopen', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only administrators can reopen finalized attendance.' });
  const month = String(req.body.month || '');
  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(Number(req.body.customer_id) || 0);
  if (!f.isMonth(month) || !customer) {
    flash(req, 'error', 'Choose a valid customer and month.');
    return res.redirect('/attendance/month');
  }
  db.prepare('DELETE FROM attendance_finalized WHERE customer_id = ? AND month = ?').run(customer.id, month);
  flash(req, 'success', `Attendance for ${customer.name} reopened for ${f.monthLabel(month)}.`);
  res.redirect(`/attendance/month?month=${month}`);
});

router.post('/', (req, res) => {
  const date = String(req.body.date || '');
  if (!f.isDate(date)) {
    flash(req, 'error', 'Invalid date.');
    return res.redirect('/attendance');
  }
  const upsert = db.prepare(`
    INSERT INTO attendance (employee_id, date, status, hours, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(employee_id, date) DO UPDATE SET status = excluded.status, hours = excluded.hours, note = excluded.note`);
  const remove = db.prepare('DELETE FROM attendance WHERE employee_id = ? AND date = ?');
  const exists = db.prepare('SELECT 1 FROM employees WHERE id = ?');
  const locked = lockedEmployeeIds(date.slice(0, 7));

  let marked = 0;
  tx(() => {
    // Keys are "e<employeeId>" so the body parser keeps them as object keys rather than array indexes.
    for (const [key, row] of Object.entries(req.body.rows || {})) {
      const employeeId = Number(key.slice(1));
      if (!employeeId || !exists.get(employeeId) || locked.has(employeeId)) continue;
      const status = String(row.status || '');
      if (!status) {
        remove.run(employeeId, date);
        continue;
      }
      if (!ATTENDANCE[status]) continue;
      const hours = row.hours === '' || row.hours == null ? ATTENDANCE[status].hours : Math.min(24, Math.max(0, Number(row.hours) || 0));
      upsert.run(employeeId, date, status, hours, String(row.note || '').trim() || null);
      marked++;
    }
  });
  flash(req, 'success', `Attendance saved for ${f.fmtDate(date)} — ${marked} employee(s) marked.`);
  res.redirect(`/attendance/daily?date=${date}`);
});

// Leave register: leave days per employee for each month of a financial year (April–March), with totals.
// A month uses the employee's monthly entry, or their daily records if they have no entry; months after the
// current one, and months before the employee joined, are left blank.
router.get('/monthly', (req, res) => {
  const ref = f.isMonth(req.query.month) ? req.query.month : f.currentMonth();
  const fy = /^\d{4}$/.test(String(req.query.fy || '')) ? Number(req.query.fy)
    : Number(ref.slice(0, 4)) - (Number(ref.slice(5)) < 4 ? 1 : 0);
  const months = Array.from({ length: 12 }, (_, i) => f.addMonths(`${fy}-04`, i));
  const current = f.currentMonth();
  const entries = new Map(db.prepare('SELECT * FROM monthly_attendance WHERE month BETWEEN ? AND ?')
    .all(months[0], months[11]).map(r => [`${r.employee_id}|${r.month}`, r]));

  const monthTotals = Object.fromEntries(months.map(m => [m, 0]));
  // Everyone employed at some point in the year.
  const inYear = db.prepare(`SELECT ${COLUMNS}, ${currentAssignmentValue('customer')} AS customer FROM employees e
    WHERE (e.status = 'Active' OR e.resignation_date >= ?) AND (e.join_date IS NULL OR e.join_date <= ?) ORDER BY e.code`)
    .all(f.monthStart(months[0]), f.monthEnd(months[11]));
  const rows = inYear.map(e => {
    let total = 0;
    const cells = months.map(m => {
      const before = e.join_date && e.join_date > f.monthEnd(m);
      const after = e.resignation_date && e.resignation_date < f.monthStart(m);
      if (m > current || before || after) return null;
      const entry = entries.get(`${e.id}|${m}`);
      const cell = entry
        ? { leave: entry.leave_days, source: 'Monthly', note: entry.note }
        : { leave: attendanceFor(e, m, employedFrom(e.join_date, m), employedTo(e.resignation_date, m)).leave, source: 'Daily' };
      total += cell.leave;
      monthTotals[m] += cell.leave;
      return cell;
    });
    return { ...e, cells, total };
  });

  res.render('attendance/monthly', {
    title: `Leave register — FY ${fy}–${String(fy + 1).slice(2)}`, fy, months, rows, monthTotals, current,
    grandTotal: rows.reduce((s, r) => s + r.total, 0), tabMonth: months.includes(ref) ? ref : months[0],
  });
});

module.exports = router;
