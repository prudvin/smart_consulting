const express = require('express');
const { db } = require('../db');
const f = require('../format');
const { currentAssignmentValue } = require('../services/designation');

const router = express.Router();
// An assignment ends at its end date, or at the employee's resignation date (last working day) if that is earlier.
const OPEN_END = "MIN(COALESCE(NULLIF(a.end_date, ''), '9999-12-31'), COALESCE(NULLIF(e.resignation_date, ''), '9999-12-31'))";

router.get('/', (req, res) => {
  const today = f.today();
  const month = f.currentMonth();
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;

  const stats = {
    employees: count("SELECT COUNT(*) AS n FROM employees WHERE status = 'Active'"),
    customers: count("SELECT COUNT(*) AS n FROM customers WHERE status = 'Active'"),
    assignments: count(`SELECT COUNT(*) AS n FROM assignments a JOIN employees e ON e.id = a.employee_id WHERE a.start_date <= ? AND ${OPEN_END} >= ?`, today, today),
    monthlyEntered: count('SELECT COUNT(*) AS n FROM monthly_attendance WHERE month = ?', month),
    leaveDays: db.prepare('SELECT COALESCE(SUM(leave_days), 0) AS n FROM monthly_attendance WHERE month = ?').get(month).n,
    outstanding: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM invoices WHERE status = 'Sent'").get(),
    payroll: db.prepare('SELECT * FROM payroll_runs WHERE month = ?').get(month),
  };

  const bench = db.prepare(`
    SELECT e.id, e.code, e.name, ${currentAssignmentValue('designation')} AS designation FROM employees e
    WHERE e.status = 'Active' AND NOT EXISTS (
      SELECT 1 FROM assignments a WHERE a.employee_id = e.id AND a.start_date <= ? AND ${OPEN_END} >= ?)
    ORDER BY e.code`).all(today, today);

  const recentInvoices = db.prepare(`
    SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id
    ORDER BY i.id DESC LIMIT 6`).all();

  res.render('dashboard', { title: 'Dashboard', stats, bench, recentInvoices, month, today });
});

module.exports = router;
