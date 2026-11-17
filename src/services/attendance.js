const { db } = require('../db');
const { ATTENDANCE } = require('../constants');
const f = require('../format');

// Totals for a set of daily records: billable days worked, leave days (every day off work: leave, absence and half of
// each half day — all unpaid), and hours on billable days.
function summarizeDaily(rows) {
  const counts = Object.fromEntries(Object.keys(ATTENDANCE).map(k => [k, 0]));
  let worked = 0;
  let lop = 0;
  let hours = 0;
  for (const r of rows) {
    const a = ATTENDANCE[r.status];
    counts[r.status]++;
    worked += a.billable;
    lop += a.lop;
    if (a.billable > 0) hours += r.hours;
  }
  return { counts, worked, leave: lop, lop, hours: f.round2(hours) };
}

// First and last day of the month the employee was employed: their join date if they joined mid-month, and their
// resignation date (last working day) if they left during the month.
const employedFrom = (joinDate, month) => (joinDate && joinDate > f.monthStart(month) ? joinDate : f.monthStart(month));
const employedTo = (resignationDate, month) =>
  (resignationDate && resignationDate < f.monthEnd(month) ? resignationDate : f.monthEnd(month));

// SQL condition (with its parameters) for employees on the books in a month: active ones, plus inactive ones with a
// resignation date in or after the month (they are paid and billed up to that date); joined by the month end.
// Inactive employees without a resignation date are left out.
const employedInMonth = (month, alias = 'e') => ({
  sql: `(${alias}.status = 'Active' OR ${alias}.resignation_date IS NOT NULL)
    AND (${alias}.join_date IS NULL OR ${alias}.join_date <= ?)
    AND (${alias}.resignation_date IS NULL OR ${alias}.resignation_date >= ?)`,
  params: [f.monthEnd(month), f.monthStart(month)],
});

const monthlyStmt = db.prepare('SELECT * FROM monthly_attendance WHERE employee_id = ? AND month = ?');
const dailyStmt = db.prepare('SELECT status, hours FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?');

// Attendance for an employee over [from, to], a period within `month`.
// - Monthly entry: leave days are unpaid (loss of pay) and every other weekday is worked (8 hours a day).
//   The month's leave is apportioned by the share of the employee's days in the month that the period covers
//   (e.g. an assignment that starts mid-month).
// - No monthly entry but daily records: the daily records are used.
// - Nothing recorded: treated as a monthly entry with no leave.
function attendanceFor(employee, month, from, to) {
  const entry = monthlyStmt.get(employee.id, month);
  if (!entry) {
    const rows = dailyStmt.all(employee.id, from, to);
    if (rows.length) return { source: 'Daily', ...summarizeDaily(rows) };
  }

  const employedDays = Math.max(1, f.daysBetween(employedFrom(employee.join_date, month), employedTo(employee.resignation_date, month)));
  const share = Math.min(1, f.daysBetween(from, to) / employedDays);
  const leave = f.round2((entry ? entry.leave_days : 0) * share);
  const worked = Math.max(0, f.round2(f.weekdaysBetween(from, to) - leave));
  return {
    source: entry ? 'Monthly' : 'None',
    counts: null,
    worked,
    leave,
    lop: leave,
    hours: f.round2(worked * ATTENDANCE.P.hours),
  };
}

// Employees whose attendance for a month isn't final yet: they worked for one or more customers that month and none
// of those customers has finalized its attendance (once any has, the employee's leave days are locked).
// Returns employee id -> names of their open customers. Employees with no customer that month are never pending.
function unfinalizedEmployees(month) {
  const rows = db.prepare(`
    SELECT DISTINCT a.employee_id, c.name,
      EXISTS (SELECT 1 FROM attendance_finalized af WHERE af.customer_id = c.id AND af.month = ?) AS finalized
    FROM assignments a JOIN customers c ON c.id = a.customer_id JOIN employees e ON e.id = a.employee_id
    WHERE a.start_date <= ?
      AND MIN(COALESCE(NULLIF(a.end_date, ''), '9999-12-31'), COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31')) >= ?
    ORDER BY c.name`).all(month, f.monthEnd(month), f.monthStart(month));
  const finalized = new Set(rows.filter(r => r.finalized).map(r => r.employee_id));
  const pending = new Map();
  for (const r of rows) {
    if (finalized.has(r.employee_id)) continue;
    if (!pending.has(r.employee_id)) pending.set(r.employee_id, []);
    pending.get(r.employee_id).push(r.name);
  }
  return pending;
}

module.exports = { summarizeDaily, attendanceFor, employedFrom, employedTo, employedInMonth, unfinalizedEmployees };
