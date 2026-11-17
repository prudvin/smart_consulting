const { db, tx, getSetting } = require('../db');
const { attendanceFor, employedFrom, employedTo, employedInMonth, unfinalizedEmployees } = require('./attendance');
const { ESI_WAGE_LIMIT, TELANGANA_PT_SLABS } = require('../constants');
const { currentAssignmentValue } = require('./designation');
const f = require('../format');

class PayrollError extends Error {}

const isBasic = c => c.name.trim().toLowerCase() === 'basic';
const isStatutory = c => c.calc === 'EPF' || c.calc === 'ESI';

// Full-month amounts of the salary earnings for a monthly gross (EPF/ESI earnings are worked out separately,
// on top). "% of basic" refers to the earning named "Basic" (or the first earning if none is named that).
// The first "Balance" earning takes whatever is left of the gross after all other earnings.
function fullMonthEarnings(components, gross) {
  const earnings = components.filter(c => c.kind === 'Earning' && !isStatutory(c));
  const basicComp = earnings.find(isBasic) || earnings[0];
  const calc = (c, basic) =>
    c.calc === 'Fixed' ? c.value
      : c.calc === 'PctGross' ? (gross * c.value) / 100
        : c.calc === 'PctBasic' ? (basic * c.value) / 100
          : 0;

  const basic = basicComp && basicComp.calc !== 'Balance' ? calc(basicComp, 0) : 0;
  const amounts = new Map();
  for (const c of earnings) {
    if (c.calc !== 'Balance') amounts.set(c, c === basicComp ? basic : calc(c, basic));
  }
  let remaining = Math.max(0, gross - [...amounts.values()].reduce((a, b) => a + b, 0));
  for (const c of earnings) {
    if (c.calc === 'Balance') {
      amounts.set(c, remaining);
      remaining = 0;
    }
  }
  return { earnings: earnings.map(c => ({ c, full: amounts.get(c) })), basicComp };
}

// Telangana professional tax for a month's salary or wages.
const telanganaPT = monthlySalary => TELANGANA_PT_SLABS.find(s => monthlySalary <= s.upTo).tax;

// Computes a payslip. `ratio` = paid days / days in month; salary earnings are prorated by it.
// Deductions reduce net pay; employer contributions are costs on top of gross and do not.
// Everything else is calculated on the earned (prorated) amounts:
// - Fixed applies only if anything was earned; % of gross / % of basic use earned gross / basic.
// - Telangana PT: the slab for the gross earned in the month, unless the employee is exempt.
// - EPF: rate × PF wages, i.e. the earned basic capped at `pfWageCeiling` (₹15,000) when it is set,
//   rounded to the nearest rupee. So a basic above ₹15,000 is counted as ₹15,000.
// - ESI: rate × earned wages, rounded up to the next rupee, only when the monthly gross is within the ESI wage limit.
// EPF/ESI can also be earnings (paid to the employee on top of salary), calculated the same way.
function computePayslip(components, monthlyGross, ratio, { ptExempt = false, pfWageCeiling = 0 } = {}) {
  const { earnings, basicComp } = fullMonthEarnings(components, monthlyGross);
  const earned = new Map();
  let wages = 0;
  let earnedBasic = 0;
  for (const { c, full } of earnings) {
    const amt = f.round2(full * ratio);
    earned.set(c, amt);
    wages += amt;
    if (c === basicComp) earnedBasic = amt;
  }
  wages = f.round2(wages);

  const pfWages = pfWageCeiling > 0 ? Math.min(earnedBasic, pfWageCeiling) : earnedBasic;
  const esiApplies = monthlyGross <= ESI_WAGE_LIMIT;
  const statutory = c => (c.calc === 'EPF' ? Math.round((pfWages * c.value) / 100)
    : esiApplies ? Math.ceil(f.round2((wages * c.value) / 100)) : 0);

  // Earnings in profile order; EPF/ESI earnings are added on top of the salary earnings.
  const lines = [];
  let gross = 0;
  for (const c of components.filter(x => x.kind === 'Earning')) {
    const amt = isStatutory(c) ? statutory(c) : earned.get(c);
    lines.push({ name: c.name, kind: 'Earning', amount: amt });
    gross += amt;
  }
  gross = f.round2(gross);

  const amountOf = c => f.round2(
    isStatutory(c) ? statutory(c)
      : c.calc === 'Fixed' ? (gross > 0 ? c.value : 0)
        : c.calc === 'PctGross' ? (gross * c.value) / 100
          : c.calc === 'PctBasic' ? (earnedBasic * c.value) / 100
            : c.calc === 'PTTelangana' ? (ptExempt ? 0 : telanganaPT(gross))
              : 0
  );

  const totals = { Deduction: 0, Employer: 0 };
  for (const kind of ['Deduction', 'Employer']) {
    for (const c of components.filter(x => x.kind === kind)) {
      const amt = amountOf(c);
      lines.push({ name: c.name, kind, amount: amt });
      totals[kind] += amt;
    }
  }
  const deductions = f.round2(totals.Deduction);
  const employer = f.round2(totals.Employer);

  return {
    lines, gross, deductions, net: f.round2(gross - deductions),
    employer, ctc: f.round2(gross + employer), pfWages: f.round2(pfWages), esiApplies,
  };
}

// Generates the payroll run for a month as a new draft. If the month already has a run, it is cleared
// completely (run and all its payslips) and generated again from current pay, attendance and profiles.
// A finalized run is only replaced when `allowFinalized` is set.
// Only employees whose attendance is final are paid: those who worked for a customer must have at least one of
// their customers' attendance finalized for the month (see unfinalizedEmployees). The rest are left out and reported
// in `pending`; regenerate after finalizing to add them.
function generatePayroll(month, userId, { allowFinalized = false } = {}) {
  const end = f.monthEnd(month);
  const dim = f.daysInMonth(month);

  return tx(() => {
    const existing = db.prepare('SELECT * FROM payroll_runs WHERE month = ?').get(month);
    if (existing && existing.status === 'Finalized' && !allowFinalized) {
      throw new PayrollError(`Payroll for ${f.monthLabel(month)} is finalized. Only an administrator can clear and regenerate it.`);
    }

    // Active employees, plus those who resigned during or after this month (paid up to their last working day).
    const eligible = employedInMonth(month);
    const withPay = db.prepare(`
      SELECT e.*, ${currentAssignmentValue('designation', 'e', `'${end}'`)} AS month_designation,
        ep.monthly_gross, ep.profile_id, p.name AS profile_name
      FROM employees e
      JOIN employee_pay ep ON ep.id = (
        SELECT id FROM employee_pay WHERE employee_id = e.id AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1)
      JOIN pay_profiles p ON p.id = ep.profile_id
      WHERE ${eligible.sql}
      ORDER BY e.code`).all(end, ...eligible.params);
    const totalEligible = db.prepare(`SELECT COUNT(*) AS n FROM employees e WHERE ${eligible.sql}`).get(...eligible.params).n;
    const unfinalized = unfinalizedEmployees(month);
    const employees = withPay.filter(e => !unfinalized.has(e.id));
    const pending = withPay.filter(e => unfinalized.has(e.id)).map(e => ({ id: e.id, name: e.name, customers: unfinalized.get(e.id) }));
    if (!employees.length && pending.length) {
      throw new PayrollError(`Attendance for ${f.monthLabel(month)} isn't finalized for any customer yet. ` +
        'Finalize it under Attendance → Monthly entry, then generate payroll.');
    }

    if (existing) db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(existing.id); // payslips and lines cascade
    const runId = Number(db.prepare('INSERT INTO payroll_runs (month, created_by) VALUES (?, ?)').run(month, userId).lastInsertRowid);

    const pfWageCeiling = Number(getSetting('pf_wage_ceiling', '15000')) || 0;
    const compStmt = db.prepare('SELECT * FROM pay_components WHERE profile_id = ? ORDER BY sort, id');
    const slipStmt = db.prepare(`
      INSERT INTO payslips (run_id, employee_id, employee_code, employee_name, designation, profile_name, monthly_gross,
        days_in_month, lop_days, leave_days, paid_days, gross_earnings, total_deductions, net_pay, employer_contributions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const lineStmt = db.prepare('INSERT INTO payslip_lines (payslip_id, name, kind, amount, sort) VALUES (?, ?, ?, ?, ?)');

    for (const e of employees) {
      // Days before joining and after the resignation date are unpaid; within employment, only leave reduces pay.
      const from = employedFrom(e.join_date, month);
      const to = employedTo(e.resignation_date, month);
      const employedDays = f.daysBetween(from, to);
      const att = attendanceFor(e, month, from, to);
      const paidDays = Math.max(0, employedDays - att.lop);
      const slip = computePayslip(compStmt.all(e.profile_id), e.monthly_gross, paidDays / dim,
        { ptExempt: Boolean(e.pt_exempt), pfWageCeiling });

      const slipId = slipStmt.run(runId, e.id, e.code, e.name, e.month_designation, e.profile_name, e.monthly_gross,
        dim, dim - paidDays, att.leave, paidDays, slip.gross, slip.deductions, slip.net, slip.employer).lastInsertRowid;
      slip.lines.forEach((l, i) => lineStmt.run(slipId, l.name, l.kind, l.amount, i));
    }

    return { runId, count: employees.length, missing: totalEligible - withPay.length, pending, replaced: existing ? existing.status : null };
  });
}

module.exports = { computePayslip, generatePayroll, PayrollError };
