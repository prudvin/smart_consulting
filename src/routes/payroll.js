const express = require('express');
const { db, getSettings } = require('../db');
const f = require('../format');
const { flash } = require('../middleware');
const { currentAssignmentValue } = require('../services/designation');
const { generatePayroll, PayrollError } = require('../services/payroll');

const router = express.Router();

// Customers an employee was assigned to at any point in a month (up to their resignation date), comma-separated.
const MONTH_CUSTOMERS = `(SELECT GROUP_CONCAT(name, ', ') FROM (
  SELECT DISTINCT c.name FROM assignments a JOIN customers c ON c.id = a.customer_id JOIN employees e2 ON e2.id = a.employee_id
  WHERE a.employee_id = s.employee_id AND a.start_date <= date(r.month || '-01', '+1 month', '-1 day')
    AND MIN(COALESCE(NULLIF(a.end_date, ''), '9999-12-31'), COALESCE(NULLIF(e2.resignation_date, ''), '9999-12-31')) >= r.month || '-01'
  ORDER BY c.name))`;

const getRun = id => db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(Number(id));

router.get('/', (req, res) => {
  const runs = db.prepare(`
    SELECT r.*, u.name AS created_by_name, COUNT(s.id) AS employees,
      COALESCE(SUM(s.gross_earnings), 0) AS gross, COALESCE(SUM(s.total_deductions), 0) AS deductions, COALESCE(SUM(s.net_pay), 0) AS net
    FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN payslips s ON s.run_id = r.id
    GROUP BY r.id ORDER BY r.month DESC`).all();
  res.render('payroll/list', { title: 'Payroll', runs, month: f.currentMonth() });
});

router.post('/generate', (req, res) => {
  const month = String(req.body.month || '');
  if (!f.isMonth(month)) {
    flash(req, 'error', 'Choose a valid month.');
    return res.redirect('/payroll');
  }
  try {
    const r = generatePayroll(month, req.user.id, { allowFinalized: req.user.role === 'admin' });
    const action = r.replaced
      ? `Payroll for ${f.monthLabel(month)} regenerated: the previous ${r.replaced.toLowerCase()} run was cleared and ${r.count} payslip(s) created.`
      : `Payroll generated for ${f.monthLabel(month)}: ${r.count} payslip(s).`;
    const missing = r.missing ? ` ${r.missing} active employee(s) have no pay profile for this month and were skipped.` : '';
    // Group the employees left out for unfinalized attendance by customer.
    const byCustomer = new Map();
    for (const p of r.pending) for (const c of p.customers) byCustomer.set(c, (byCustomer.get(c) || 0) + 1);
    const pending = r.pending.length
      ? ` ${r.pending.length} employee(s) were left out because attendance isn't finalized for: ` +
        `${[...byCustomer].map(([c, n]) => `${c} (${n})`).join(', ')}. Finalize it under Attendance, then regenerate.`
      : '';
    flash(req, r.missing || r.pending.length ? 'info' : 'success', `${action}${missing}${pending}`);
    res.redirect(`/payroll/${r.runId}`);
  } catch (err) {
    if (!(err instanceof PayrollError)) throw err;
    flash(req, 'error', err.message);
    res.redirect('/payroll');
  }
});

router.get('/payslips/:id', (req, res, next) => {
  const slip = db.prepare(`
    SELECT s.*, r.month, r.status AS run_status, e.pan, e.bank_name, e.bank_account, e.ifsc, e.epf_number, e.esi_number, e.join_date,
      ${currentAssignmentValue('department', 'e', "date(r.month || '-01', '+1 month', '-1 day')")} AS department
    FROM payslips s JOIN payroll_runs r ON r.id = s.run_id JOIN employees e ON e.id = s.employee_id WHERE s.id = ?`).get(Number(req.params.id));
  if (!slip) return next();
  const lines = db.prepare('SELECT * FROM payslip_lines WHERE payslip_id = ? ORDER BY sort').all(slip.id);
  // ?popup=1: just the payslip, for showing in a popup over the current page.
  // ?panel=1: for the slide-over panel; ?popup=1: for the popup; otherwise the full page.
  const view = req.query.panel === '1' ? 'payroll/payslip-panel' : req.query.popup === '1' ? 'payroll/payslip-popup' : 'payroll/payslip';
  res.render(view, {
    title: `Payslip ${slip.employee_code} ${slip.month}`, slip, settings: getSettings(),
    earnings: lines.filter(l => l.kind === 'Earning'), deductions: lines.filter(l => l.kind === 'Deduction'),
    employer: lines.filter(l => l.kind === 'Employer'),
  });
});

router.get('/:id', (req, res, next) => {
  const run = getRun(req.params.id);
  if (!run) return next();
  const payslips = db.prepare(`SELECT s.*, ${MONTH_CUSTOMERS} AS customers
    FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.run_id = ? ORDER BY s.employee_code`).all(run.id);
  const totals = payslips.reduce((t, s) => ({
    gross: t.gross + s.gross_earnings, deductions: t.deductions + s.total_deductions, net: t.net + s.net_pay,
    employer: t.employer + s.employer_contributions,
  }), { gross: 0, deductions: 0, net: 0, employer: 0 });
  const components = componentBreakdown(run.id);
  const componentTotals = { Earning: {}, Deduction: {}, Employer: {} };
  for (const amounts of components.bySlip.values()) {
    for (const kind of ['Earning', 'Deduction', 'Employer']) {
      for (const [name, amt] of Object.entries(amounts[kind])) componentTotals[kind][name] = (componentTotals[kind][name] || 0) + amt;
    }
  }
  res.render('payroll/run', { title: `Payroll — ${f.monthLabel(run.month)}`, run, payslips, totals, components, componentTotals });
});

// Every earning, deduction and employer-contribution component in a run, in profile order, with each payslip's amounts.
function componentBreakdown(runId) {
  const lines = db.prepare(`
    SELECT l.* FROM payslip_lines l JOIN payslips s ON s.id = l.payslip_id WHERE s.run_id = ? ORDER BY l.sort, l.id`).all(runId);
  const names = { Earning: new Set(), Deduction: new Set(), Employer: new Set() };
  const bySlip = new Map();
  for (const l of lines) {
    names[l.kind].add(l.name);
    if (!bySlip.has(l.payslip_id)) bySlip.set(l.payslip_id, { Earning: {}, Deduction: {}, Employer: {} });
    bySlip.get(l.payslip_id)[l.kind][l.name] = l.amount;
  }
  return { earnings: [...names.Earning], deductions: [...names.Deduction], employer: [...names.Employer], bySlip };
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/:id/export.csv', (req, res, next) => {
  const run = getRun(req.params.id);
  if (!run) return next();
  const payslips = db.prepare(`
    SELECT s.*, e.pan, e.bank_name, e.bank_account, e.ifsc, e.epf_number, e.esi_number, ${MONTH_CUSTOMERS} AS customers
    FROM payslips s JOIN employees e ON e.id = s.employee_id JOIN payroll_runs r ON r.id = s.run_id
    WHERE s.run_id = ? ORDER BY s.employee_code`).all(run.id);
  const { earnings, deductions, employer, bySlip } = componentBreakdown(run.id);
  const amountsOf = (s, kind) => (bySlip.get(s.id) || { Earning: {}, Deduction: {}, Employer: {} })[kind];

  const header = ['Code', 'Name', 'Customer', 'Designation', 'PAN', 'Bank', 'Account', 'IFSC', 'EPF account no.', 'ESI no.', 'Monthly gross', 'Days', 'Leave days', 'Paid days',
    ...earnings, 'Gross earnings', ...deductions.map(n => `(-) ${n}`), 'Total deductions', 'Net pay',
    ...employer.map(n => `(Employer) ${n}`), 'Employer contributions', 'Cost to company'];
  const rows = payslips.map(s => [s.employee_code, s.employee_name, s.customers, s.designation, s.pan, s.bank_name, s.bank_account, s.ifsc, s.epf_number, s.esi_number,
    s.monthly_gross, s.days_in_month, s.leave_days, s.paid_days,
    ...earnings.map(n => amountsOf(s, 'Earning')[n] ?? ''), s.gross_earnings,
    ...deductions.map(n => amountsOf(s, 'Deduction')[n] ?? ''), s.total_deductions, s.net_pay,
    ...employer.map(n => amountsOf(s, 'Employer')[n] ?? ''), s.employer_contributions, f.round2(s.gross_earnings + s.employer_contributions)]);

  res.type('text/csv').attachment(`payroll-${run.month}.csv`);
  res.send([header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'));
});

router.post('/:id/finalize', (req, res, next) => {
  const run = getRun(req.params.id);
  if (!run) return next();
  db.prepare("UPDATE payroll_runs SET status = 'Finalized', finalized_at = datetime('now') WHERE id = ?").run(run.id);
  flash(req, 'success', `Payroll for ${f.monthLabel(run.month)} finalized.`);
  res.redirect(`/payroll/${run.id}`);
});

router.post('/:id/reopen', (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only administrators can reopen a finalized payroll.' });
  const run = getRun(req.params.id);
  if (!run) return next();
  db.prepare("UPDATE payroll_runs SET status = 'Draft', finalized_at = NULL WHERE id = ?").run(run.id);
  flash(req, 'success', `Payroll for ${f.monthLabel(run.month)} reopened as draft.`);
  res.redirect(`/payroll/${run.id}`);
});

router.post('/:id/delete', (req, res, next) => {
  const run = getRun(req.params.id);
  if (!run) return next();
  if (run.status === 'Finalized') {
    flash(req, 'error', 'A finalized payroll cannot be deleted.');
    return res.redirect(`/payroll/${run.id}`);
  }
  db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(run.id);
  flash(req, 'success', `Draft payroll for ${f.monthLabel(run.month)} deleted.`);
  res.redirect('/payroll');
});

module.exports = router;
