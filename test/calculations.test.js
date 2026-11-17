const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-consulting-test-'));
const { db } = require('../src/db');
const { computePayslip, generatePayroll, PayrollError } = require('../src/services/payroll');
const { buildResources, linesFromResources, agencyLine, generateForMonth } = require('../src/services/invoices');

const standard = [
  { name: 'Basic', kind: 'Earning', calc: 'PctGross', value: 50 },
  { name: 'HRA', kind: 'Earning', calc: 'PctBasic', value: 40 },
  { name: 'Special Allowance', kind: 'Earning', calc: 'Balance', value: 0 },
  { name: 'Provident Fund', kind: 'Deduction', calc: 'PctBasic', value: 12 },
  { name: 'Professional Tax', kind: 'Deduction', calc: 'Fixed', value: 200 },
];
const amountOf = (slip, name) => slip.lines.find(l => l.name === name).amount;

test('full-month payslip splits gross into components', () => {
  const slip = computePayslip(standard, 50000, 1);
  assert.equal(amountOf(slip, 'Basic'), 25000);
  assert.equal(amountOf(slip, 'HRA'), 10000);
  assert.equal(amountOf(slip, 'Special Allowance'), 15000);
  assert.equal(slip.gross, 50000);
  assert.equal(amountOf(slip, 'Provident Fund'), 3000);
  assert.equal(slip.deductions, 3200);
  assert.equal(slip.net, 46800);
});

test('earnings and percentage deductions prorate; fixed deductions do not', () => {
  const slip = computePayslip(standard, 30000, 15 / 30);
  assert.equal(slip.gross, 15000);
  assert.equal(amountOf(slip, 'Provident Fund'), 900);
  assert.equal(amountOf(slip, 'Professional Tax'), 200);
  assert.equal(slip.net, 13900);
});

test('no paid days means no pay and no fixed deductions', () => {
  const slip = computePayslip(standard, 30000, 0);
  assert.equal(slip.gross, 0);
  assert.equal(slip.deductions, 0);
  assert.equal(slip.net, 0);
});

test('balance never goes negative when components exceed gross', () => {
  const slip = computePayslip([
    { name: 'Basic', kind: 'Earning', calc: 'Fixed', value: 40000 },
    { name: 'Special', kind: 'Earning', calc: 'Balance', value: 0 },
  ], 30000, 1);
  assert.equal(amountOf(slip, 'Special'), 0);
});

test('payroll run uses attendance loss-of-pay and join date', () => {
  const profileId = db.prepare("SELECT id FROM pay_profiles WHERE name = 'Standard'").get().id;
  const emp = (code, joinDate) => Number(db.prepare("INSERT INTO employees (code, name, join_date) VALUES (?, ?, ?)").run(code, code, joinDate).lastInsertRowid);
  const a = emp('T1', '2025-01-01');
  const b = emp('T2', '2026-09-16');
  emp('T3', '2025-01-01'); // no pay profile → skipped
  for (const id of [a, b]) db.prepare('INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, ?, ?)').run(id, profileId, 30000, '2025-01-01');
  db.prepare("INSERT INTO attendance (employee_id, date, status) VALUES (?, '2026-09-02', 'A'), (?, '2026-09-03', 'HD'), (?, '2026-09-04', 'PL')").run(a, a, a);

  const r = generatePayroll('2026-09', null);
  assert.equal(r.count, 2);
  assert.equal(r.missing, 1);
  const slips = db.prepare('SELECT * FROM payslips WHERE run_id = ? ORDER BY employee_code').all(r.runId);
  assert.equal(slips[0].paid_days, 27.5); // 30 days − 1 absent − 0.5 half day − 1 leave (leave is unpaid)
  assert.equal(slips[0].leave_days, 2.5);
  assert.equal(slips[0].gross_earnings, 27500);
  assert.equal(slips[1].paid_days, 15); // joined on the 16th
  assert.equal(slips[1].gross_earnings, 15000);

  // Regenerating clears the existing run and all its payslips, then builds a new draft from current data.
  const countRuns = () => db.prepare("SELECT COUNT(*) AS n FROM payroll_runs WHERE month = '2026-09'").get().n;
  db.prepare("UPDATE employee_pay SET monthly_gross = 60000 WHERE employee_id = ?").run(a);
  const again = generatePayroll('2026-09', null);
  assert.equal(again.replaced, 'Draft');
  assert.equal(countRuns(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payslips WHERE run_id = ?').get(again.runId).n, 2);
  assert.equal(db.prepare('SELECT gross_earnings FROM payslips WHERE run_id = ? AND employee_id = ?').get(again.runId, a).gross_earnings, 55000);

  // A finalized run is only cleared and regenerated when explicitly allowed (administrators), as a new draft.
  db.prepare("UPDATE payroll_runs SET status = 'Finalized' WHERE id = ?").run(again.runId);
  assert.throws(() => generatePayroll('2026-09', null), PayrollError);
  const third = generatePayroll('2026-09', null, { allowFinalized: true });
  assert.equal(third.replaced, 'Finalized');
  assert.equal(db.prepare('SELECT status FROM payroll_runs WHERE id = ?').get(third.runId).status, 'Draft');
  assert.equal(countRuns(), 1);
  // Nothing from the cleared runs is left behind: only the new run's 2 payslips and their lines exist for the month.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE r.month = '2026-09'").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payslip_lines WHERE payslip_id NOT IN (SELECT id FROM payslips)').get().n, 0);
});

test('invoices bill at the rate on each assignment, grouped by designation, with per-employee annexure', () => {
  const cust = Number(db.prepare("INSERT INTO customers (name) VALUES ('Acme')").run().lastInsertRowid);
  const emp = (code, name, designation) =>
    Number(db.prepare('INSERT INTO employees (code, name, designation) VALUES (?, ?, ?)').run(code, name, designation).lastInsertRowid);
  const asha = emp('I1', 'Asha', 'Consultant');
  const ravi = emp('I2', 'Ravi', 'Consultant');
  const meera = emp('I3', 'Meera', 'Developer');
  const kiran = emp('I4', 'Kiran', 'Analyst');
  const omar = emp('I5', 'Omar', 'Designer');

  const asg = db.prepare(`INSERT INTO assignments (employee_id, customer_id, designation, start_date, end_date, billing_type, rate)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  asg.run(asha, cust, 'Consultant', '2026-10-17', null, 'Monthly', 310000); // half of October
  asg.run(ravi, cust, 'consultant ', '2026-01-01', null, 'Monthly', 310000); // grouped with "Consultant" (case/space-insensitive)
  asg.run(meera, cust, 'Developer', '2026-01-01', null, 'Daily', 8000);
  asg.run(kiran, cust, 'Analyst', '2026-01-01', '2026-10-15', 'Hourly', 1000);
  asg.run(kiran, cust, 'Analyst', '2026-11-01', null, 'Hourly', 1000); // outside month — ignored
  asg.run(omar, cust, 'Designer', '2026-01-01', null, 'Daily', 7000);
  const att = db.prepare('INSERT INTO attendance (employee_id, date, status, hours) VALUES (?, ?, ?, ?)');
  att.run(meera, '2026-10-01', 'P', 8);
  att.run(meera, '2026-10-02', 'HD', 4);
  att.run(meera, '2026-10-03', 'A', 0);
  att.run(meera, '2026-10-04', 'PL', 0);
  att.run(kiran, '2026-10-14', 'P', 6);
  att.run(kiran, '2026-10-20', 'P', 8); // after assignment end — not billable
  att.run(omar, '2026-10-05', 'P', 8);

  const resources = buildResources(cust, '2026-10');
  const byName = Object.fromEntries(resources.map(r => [r.employee_name, r]));
  assert.equal(resources.length, 5);
  assert.equal(byName.Asha.quantity, 0.48); // 15 of 31 days
  assert.equal(byName.Asha.rate_source, 'Assignment');
  assert.equal(byName.Ravi.rate, 310000);
  assert.equal(byName.Meera.quantity, 1.5);
  assert.deepEqual([byName.Meera.present, byName.Meera.half_day, byName.Meera.absent], [1, 1, 1]);
  assert.equal(byName.Meera.paid_leave, 2.5); // one leave type: leave + absence + half of the half day
  assert.equal(byName.Kiran.quantity, 6);
  assert.equal(byName.Kiran.period_to, '2026-10-15');
  assert.equal(byName.Omar.rate_source, 'Assignment');
  assert.equal(byName.Omar.amount, 7000);

  const lines = linesFromResources(resources);
  const consultant = lines.find(l => l.description.startsWith('Consultant'));
  assert.equal(lines.length, 4);
  assert.equal(consultant.description, 'Consultant — 2 resources');
  assert.equal(consultant.quantity, 1.48);

  const first = generateForMonth('2026-10');
  assert.equal(first.created.length, 1);
  assert.deepEqual(first.missingRates, []);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(first.created[0]);
  assert.equal(inv.subtotal, 1.48 * 310000 + 1.5 * 8000 + 6 * 1000 + 7000);
  assert.equal(inv.total, Math.round(inv.subtotal * 1.18 * 100) / 100);
  assert.match(inv.number, /^INV-202610-001$/);
  const annexure = db.prepare('SELECT * FROM invoice_annexure WHERE invoice_id = ?').all(inv.id);
  assert.equal(annexure.length, 5);
  assert.equal(Math.round(annexure.reduce((s, r) => s + r.amount, 0) * 100) / 100, inv.subtotal);
  assert.deepEqual(generateForMonth('2026-10'), { created: [], skipped: 1, missingRates: [] });
});

test('assignments without a rate are reported (billed at 0)', () => {
  const cust = Number(db.prepare("INSERT INTO customers (name) VALUES ('Globex')").run().lastInsertRowid);
  const e = Number(db.prepare("INSERT INTO employees (code, name, designation) VALUES ('M1', 'Zed', 'Architect')").run().lastInsertRowid);
  db.prepare("INSERT INTO assignments (employee_id, customer_id, designation, start_date) VALUES (?, ?, 'Architect', '2026-01-01')").run(e, cust);
  assert.deepEqual(generateForMonth('2026-10').missingRates, ['Zed']);
});

test('monthly leave days drive payroll and invoicing, overriding daily records', () => {
  const profileId = db.prepare("SELECT id FROM pay_profiles WHERE name = 'Standard'").get().id;
  const emp = (code, designation) =>
    Number(db.prepare("INSERT INTO employees (code, name, designation, join_date) VALUES (?, ?, ?, '2025-01-01')").run(code, code, designation).lastInsertRowid);
  const dev = emp('MA1', 'Developer');
  const analyst = emp('MA2', 'Analyst');
  const quiet = emp('MA3', 'Developer'); // nothing recorded — treated as no leave
  db.prepare("INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, 31000, '2025-01-01')").run(dev, profileId);
  const att = db.prepare("INSERT INTO attendance (employee_id, date, status, hours) VALUES (?, ?, 'A', 0)");
  ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'].forEach(d => att.run(dev, d)); // ignored once a monthly entry exists
  const entry = db.prepare('INSERT INTO monthly_attendance (employee_id, month, leave_days) VALUES (?, ?, ?)');
  entry.run(dev, '2026-08', 3);
  entry.run(analyst, '2026-08', 1);

  // Leave is unpaid: 31 days − 3 leave days.
  const run = generatePayroll('2026-08', null);
  const slip = db.prepare('SELECT * FROM payslips WHERE run_id = ? AND employee_id = ?').get(run.runId, dev);
  assert.equal(slip.leave_days, 3);
  assert.equal(slip.lop_days, 3);
  assert.equal(slip.paid_days, 28);
  assert.equal(slip.gross_earnings, 28000);

  const cust = Number(db.prepare("INSERT INTO customers (name) VALUES ('Initech')").run().lastInsertRowid);
  const asg = db.prepare('INSERT INTO assignments (employee_id, customer_id, start_date, billing_type, rate) VALUES (?, ?, ?, ?, ?)');
  asg.run(dev, cust, '2026-08-17', 'Daily', 8000); // 15 of 31 days, 11 weekdays, carrying 15/31 of the 3 leave days
  asg.run(analyst, cust, '2026-01-01', 'Hourly', 1000);
  asg.run(quiet, cust, '2026-01-01', 'Daily', 8000);
  const byCode = Object.fromEntries(buildResources(cust, '2026-08').map(r => [r.employee_code, r]));
  assert.equal(byCode.MA1.attendance_source, 'Monthly');
  assert.equal(byCode.MA1.paid_leave, 1.45);
  assert.equal(byCode.MA1.days_worked, 9.55);
  assert.equal(byCode.MA1.amount, 9.55 * 8000);
  assert.equal(byCode.MA2.days_worked, 20); // 21 weekdays in August 2026 − 1 leave day
  assert.equal(byCode.MA2.hours, 160);
  assert.equal(byCode.MA2.amount, 160000);
  assert.equal(byCode.MA3.attendance_source, 'None');
  assert.equal(byCode.MA3.quantity, 21);
});

test('Telangana professional tax follows the monthly salary slabs', () => {
  const profile = [
    { name: 'Basic', kind: 'Earning', calc: 'PctGross', value: 100 },
    { name: 'Professional Tax', kind: 'Deduction', calc: 'PTTelangana', value: 0 },
  ];
  const pt = (gross, ratio = 1, opts) => amountOf(computePayslip(profile, gross, ratio, opts), 'Professional Tax');
  assert.equal(pt(15000), 0);
  assert.equal(pt(15000.5), 150);
  assert.equal(pt(15001), 150);
  assert.equal(pt(20000), 150);
  assert.equal(pt(20001), 200);
  assert.equal(pt(250000), 200);
  // The slab applies to the salary earned in the month, after leave/LOP proration.
  assert.equal(pt(30000, 0.5), 0); // 15,000 earned
  assert.equal(pt(30000, 0.6), 150); // 18,000 earned
  assert.equal(pt(30000, 15 / 31), 0); // 14,516.13 earned
  assert.equal(pt(0), 0);
  assert.equal(pt(50000, 1, { ptExempt: true }), 0);
});

test('payroll applies PT exemption from the employee record', () => {
  const p = Number(db.prepare("INSERT INTO pay_profiles (name) VALUES ('PT test')").run().lastInsertRowid);
  db.prepare("INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, 'Basic', 'Earning', 'PctGross', 100, 0), (?, 'PT', 'Deduction', 'PTTelangana', 0, 1)").run(p, p);
  const emp = (code, exempt) =>
    Number(db.prepare("INSERT INTO employees (code, name, join_date, pt_exempt) VALUES (?, ?, '2025-01-01', ?)").run(code, code, exempt).lastInsertRowid);
  const payer = emp('PT1', 0);
  const exempt = emp('PT2', 1);
  for (const id of [payer, exempt]) db.prepare("INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, 40000, '2025-01-01')").run(id, p);
  const run = generatePayroll('2026-07', null);
  const ptOf = id => db.prepare(`SELECT l.amount FROM payslip_lines l JOIN payslips s ON s.id = l.payslip_id
    WHERE s.run_id = ? AND s.employee_id = ? AND l.name = 'PT'`).get(run.runId, id).amount;
  assert.equal(ptOf(payer), 200);
  assert.equal(ptOf(exempt), 0);
});

test('EPF and ESI follow the statutory rules, with employer shares on top of pay', () => {
  const profile = [
    { name: 'Basic', kind: 'Earning', calc: 'PctGross', value: 50 },
    { name: 'Special', kind: 'Earning', calc: 'Balance', value: 0 },
    { name: 'EPF', kind: 'Deduction', calc: 'EPF', value: 12 },
    { name: 'ESI', kind: 'Deduction', calc: 'ESI', value: 0.75 },
    { name: 'Employer EPF', kind: 'Employer', calc: 'EPF', value: 13 },
    { name: 'Employer ESI', kind: 'Employer', calc: 'ESI', value: 3.25 },
  ];
  const slip = (gross, ratio = 1, pfWageCeiling = 15000) => computePayslip(profile, gross, ratio, { pfWageCeiling });
  const amt = (s, name) => amountOf(s, name);

  // ₹18,000: basic 9,000 under the PF ceiling; ESI applies (gross ≤ ₹21,000).
  const a = slip(18000);
  assert.deepEqual([amt(a, 'EPF'), amt(a, 'ESI'), amt(a, 'Employer EPF'), amt(a, 'Employer ESI')], [1080, 135, 1170, 585]);
  assert.equal(a.net, 18000 - 1080 - 135); // employer shares don't reduce pay
  assert.equal(a.employer, 1755);
  assert.equal(a.ctc, 19755);

  // ₹50,000: PF wages capped at ₹15,000; no ESI above ₹21,000.
  const b = slip(50000);
  assert.deepEqual([amt(b, 'EPF'), amt(b, 'Employer EPF'), amt(b, 'ESI'), amt(b, 'Employer ESI')], [1800, 1950, 0, 0]);
  assert.equal(b.pfWages, 15000);
  assert.equal(amt(slip(50000, 1, 0), 'EPF'), 3000); // no ceiling: 12% of the full basic

  // Prorated month: contributions on earned wages; ESI eligibility from the monthly gross; ESI rounds up.
  const c = slip(20000, 0.5);
  assert.deepEqual([amt(c, 'EPF'), amt(c, 'ESI'), amt(c, 'Employer ESI')], [600, 75, 325]);
  assert.equal(amt(slip(15500), 'ESI'), 117); // 116.25 → 117
  assert.equal(amt(slip(21000), 'ESI'), 158); // at the limit: still covered (157.50 → 158)
  assert.equal(amt(slip(21001), 'ESI'), 0);
});

test('EPF counts basic only up to ₹15,000, including EPF paid as an earning', () => {
  const profile = [
    { name: 'Basic', kind: 'Earning', calc: 'PctGross', value: 100 },
    { name: 'EPF', kind: 'Earning', calc: 'EPF', value: 13 },
    { name: 'PF', kind: 'Deduction', calc: 'EPF', value: 12 },
    { name: 'Employer EPF', kind: 'Employer', calc: 'EPF', value: 26 },
  ];
  const slip = (gross, ratio = 1) => computePayslip(profile, gross, ratio, { pfWageCeiling: 15000 });
  const s = slip(40000); // basic 40,000 → PF wages 15,000
  assert.deepEqual([amountOf(s, 'EPF'), amountOf(s, 'PF'), amountOf(s, 'Employer EPF')], [1950, 1800, 3900]);
  assert.equal(s.gross, 41950); // EPF earning added on top of salary
  assert.equal(amountOf(slip(12000), 'EPF'), 1560); // under the ceiling: 13% of the full basic
  assert.equal(amountOf(slip(40000, 0.25), 'EPF'), 1300); // 10,000 earned basic is under the ceiling
});

test('an employee who resigns is paid, billed and counted only up to their last working day', () => {
  const p = Number(db.prepare("INSERT INTO pay_profiles (name) VALUES ('Resign test')").run().lastInsertRowid);
  db.prepare("INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, 'Basic', 'Earning', 'PctGross', 100, 0)").run(p);
  const emp = (code, resignation) => Number(db.prepare(
    "INSERT INTO employees (code, name, designation, join_date, status, resignation_date) VALUES (?, ?, 'Developer', '2025-01-01', 'Inactive', ?)")
    .run(code, code, resignation).lastInsertRowid);
  const leaver = emp('RS1', '2026-06-10');
  const gone = emp('RS2', '2026-05-31');
  for (const id of [leaver, gone]) db.prepare("INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, 30000, '2025-01-01')").run(id, p);
  db.prepare("INSERT INTO monthly_attendance (employee_id, month, leave_days) VALUES (?, '2026-06', 1)").run(leaver);

  // June: RS1 is paid for 1–10 June less 1 leave day; RS2 left in May and is not paid.
  const run = generatePayroll('2026-06', null);
  const slips = db.prepare('SELECT * FROM payslips WHERE run_id = ?').all(run.runId);
  const slip = slips.find(s => s.employee_id === leaver);
  assert.equal(slip.paid_days, 9);
  assert.equal(slip.gross_earnings, 9000); // 30,000 × 9/30
  assert.ok(!slips.some(s => s.employee_id === gone));
  assert.equal(generatePayroll('2026-07', null).count >= 0, true);
  assert.ok(!db.prepare('SELECT 1 FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE r.month = ? AND s.employee_id = ?').get('2026-07', leaver));

  // Billing stops at the resignation date: 1–10 June has 8 weekdays, less 1 leave day.
  const cust = Number(db.prepare("INSERT INTO customers (name) VALUES ('Hooli')").run().lastInsertRowid);
  db.prepare("INSERT INTO assignments (employee_id, customer_id, start_date, billing_type, rate) VALUES (?, ?, '2026-01-01', 'Daily', 8000)").run(leaver, cust);
  const [row] = buildResources(cust, '2026-06');
  assert.equal(row.period_to, '2026-06-10');
  assert.equal(row.days_worked, 7);
  assert.equal(buildResources(cust, '2026-07').length, 0);
});

test('designation and rate are taken from the assignment: invoice line and payslip', () => {
  const p = Number(db.prepare("INSERT INTO pay_profiles (name) VALUES ('Designation test')").run().lastInsertRowid);
  db.prepare("INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, 'Basic', 'Earning', 'PctGross', 100, 0)").run(p);
  const emp = Number(db.prepare("INSERT INTO employees (code, name, designation, join_date) VALUES ('DG1', 'Dana', 'Developer', '2025-01-01')").run().lastInsertRowid);
  db.prepare("INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, 20000, '2025-01-01')").run(emp, p);
  const cust = Number(db.prepare("INSERT INTO customers (name) VALUES ('Umbrella')").run().lastInsertRowid);
  db.prepare(`INSERT INTO assignments (employee_id, customer_id, designation, department, start_date, billing_type, rate)
    VALUES (?, ?, 'Solution Architect', 'Cloud', '2026-01-01', 'Monthly', 500000)`).run(emp, cust);

  const [row] = buildResources(cust, '2026-04');
  assert.equal(row.designation, 'Solution Architect'); // not the employee's old "Developer"
  assert.equal(row.rate, 500000);
  assert.equal(linesFromResources([row])[0].description, 'Solution Architect — 1 resource');

  db.prepare("INSERT INTO attendance_finalized (customer_id, month) VALUES (?, '2026-04')").run(cust);
  const run = generatePayroll('2026-04', null);
  const slip = db.prepare('SELECT designation FROM payslips WHERE run_id = ? AND employee_id = ?').get(run.runId, emp);
  assert.equal(slip.designation, 'Solution Architect');
});

test('payroll includes only employees whose customer attendance is finalized', () => {
  const month = '2025-11';
  const p = Number(db.prepare("INSERT INTO pay_profiles (name) VALUES ('Finalize test')").run().lastInsertRowid);
  db.prepare("INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, 'Basic', 'Earning', 'PctGross', 100, 0)").run(p);
  const emp = code => {
    const id = Number(db.prepare("INSERT INTO employees (code, name, join_date) VALUES (?, ?, '2025-01-01')").run(code, code).lastInsertRowid);
    db.prepare("INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, 10000, '2025-01-01')").run(id, p);
    return id;
  };
  const cust = name => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  const assign = (e, c) => db.prepare("INSERT INTO assignments (employee_id, customer_id, start_date, billing_type, rate) VALUES (?, ?, '2025-01-01', 'Monthly', 1)").run(e, c);
  const open = cust('Open Co');
  const done = cust('Done Co');
  const a = emp('FZ1'); assign(a, open);           // only an open customer: left out
  const b = emp('FZ2'); assign(b, done);           // finalized customer: paid
  const both = emp('FZ3'); assign(both, open); assign(both, done); // one of two finalized: leave is locked, paid
  const slipsFor = run => new Set(db.prepare('SELECT employee_id FROM payslips WHERE run_id = ?').all(run.runId).map(s => s.employee_id));

  // Before finalizing, none of the three is paid.
  const before = slipsFor(generatePayroll(month, null));
  assert.ok(![a, b, both].some(id => before.has(id)));

  db.prepare('INSERT INTO attendance_finalized (customer_id, month) VALUES (?, ?)').run(done, month);
  const run = generatePayroll(month, null);
  const paid = slipsFor(run);
  assert.ok(!paid.has(a));
  assert.ok(paid.has(b));
  assert.ok(paid.has(both));
  assert.deepEqual(run.pending.find(x => x.id === a).customers, ['Open Co']);
});

test('agency charges: percentage of manpower or a fixed amount per invoice', () => {
  const lines = [{ quantity: 2, rate: 30000 }, { quantity: 0.5, rate: 20000 }]; // manpower 70,000
  const pct = agencyLine({ agency_charge_type: 'Percent', agency_charge_value: 10 }, lines);
  assert.equal(pct.quantity, 1);
  assert.equal(pct.rate, 7000);
  assert.match(pct.description, /10%/);
  assert.equal(agencyLine({ agency_charge_type: 'Fixed', agency_charge_value: 2500 }, lines).rate, 2500);
  assert.equal(agencyLine({ agency_charge_type: 'None', agency_charge_value: 10 }, lines), null);
  assert.equal(agencyLine({ agency_charge_type: 'Percent', agency_charge_value: 0 }, lines), null);
  assert.equal(agencyLine({ agency_charge_type: 'Fixed', agency_charge_value: 2500 }, []), null); // nothing billed
});
