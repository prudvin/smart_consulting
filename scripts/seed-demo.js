// Loads demo data: pay profiles, billing rates, customers, employees, assignments, attendance and employee pay.
// Usage: npm run seed   (refuses to run if employees or customers already exist)
const { db, tx } = require('../src/db');
const f = require('../src/format');
const { ATTENDANCE } = require('../src/constants');

const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
if (count('employees') || count('customers')) {
  console.error('Employees or customers already exist — demo data is only loaded into an empty database.');
  process.exit(1);
}

// Deterministic pseudo-random numbers so every run produces the same data.
let seed = 20261115;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const PAY_PROFILES = [
  ['Junior Consultant', 'Freshers and associates: Basic 40% of gross, HRA 50% of basic, conveyance, balance as special allowance', [
    ['Basic', 'Earning', 'PctGross', 40],
    ['HRA', 'Earning', 'PctBasic', 50],
    ['Conveyance', 'Earning', 'Fixed', 1600],
    ['Special Allowance', 'Earning', 'Balance', 0],
    ['EPF', 'Deduction', 'EPF', 12],
    ['ESI', 'Deduction', 'ESI', 0.75],
    ['Professional Tax', 'Deduction', 'PTTelangana', 0],
    ['Employer EPF', 'Employer', 'EPF', 13],
    ['Employer ESI', 'Employer', 'ESI', 3.25],
  ]],
  ['Senior Consultant', 'Senior and lead consultants: Basic 50%, HRA 50% of basic, LTA, TDS 10% of gross', [
    ['Basic', 'Earning', 'PctGross', 50],
    ['HRA', 'Earning', 'PctBasic', 50],
    ['LTA', 'Earning', 'Fixed', 2500],
    ['Special Allowance', 'Earning', 'Balance', 0],
    ['EPF', 'Deduction', 'EPF', 12],
    ['ESI', 'Deduction', 'ESI', 0.75],
    ['Professional Tax', 'Deduction', 'PTTelangana', 0],
    ['Employer EPF', 'Employer', 'EPF', 13],
    ['Employer ESI', 'Employer', 'ESI', 3.25],
    ['TDS', 'Deduction', 'PctGross', 10],
  ]],
  ['Contract Consultant', 'Contractors paid a consultancy fee with 10% TDS', [
    ['Consultancy Fee', 'Earning', 'PctGross', 100],
    ['TDS', 'Deduction', 'PctGross', 10],
  ]],
];

const CUSTOMERS = [
  ['Nimbus Retail Pvt Ltd', 'Anil Mehta', 'accounts@nimbusretail.example', '+91 80 4123 5500', '4th Floor, Prestige Tower\nMG Road, Bengaluru 560001', '29AAACN1234M1Z5', 'Active'],
  ['Bharat Logistics Ltd', 'Sunita Rao', 'finance@bharatlogistics.example', '+91 22 6654 3200', 'Plot 18, MIDC Andheri East\nMumbai 400093', '27AABCB5678K1Z2', 'Active'],
  ['Kaveri Pharma Ltd', 'Dr. Ramesh Iyer', 'ap@kaveripharma.example', '+91 44 2815 7700', '22 Industrial Estate, Guindy\nChennai 600032', '33AAFCK9012L1Z8', 'Active'],
  ['Orion FinServ Pvt Ltd', 'Neha Kapoor', 'vendors@orionfinserv.example', '+91 124 470 9900', 'Tower B, Cyber City\nGurugram 122002', '06AABCO3456P1Z1', 'Active'],
  ['Deccan Motors Ltd', 'Vikram Reddy', 'payables@deccanmotors.example', '+91 40 2311 4400', 'Survey 45, Hitech City\nHyderabad 500081', '36AACCD7890Q1Z4', 'Active'],
  ['Sahyadri Foods Pvt Ltd', 'Meena Kulkarni', 'accounts@sahyadrifoods.example', '+91 20 2567 1100', 'Hinjewadi Phase 2\nPune 411057', '27AADCS2345R1Z6', 'Inactive'],
];

// [code, name, designation, department, join date, status, pay profile, monthly gross, raise from 2026-10-01]
const EMPLOYEES = [
  ['EMP001', 'Asha Rao', 'Lead Consultant', 'SAP Finance', '2021-06-14', 'Active', 'Senior Consultant', 185000, 200000],
  ['EMP002', 'Ravi Kumar', 'Senior Consultant', 'SAP Logistics', '2022-01-10', 'Active', 'Senior Consultant', 150000, null],
  ['EMP003', 'Priya Sharma', 'Developer', 'SAP Technical', '2023-03-01', 'Active', 'Standard', 95000, 105000],
  ['EMP004', 'Karthik Subramanian', 'Consultant', 'SAP Technical', '2022-08-22', 'Active', 'Standard', 110000, null],
  ['EMP005', 'Fatima Sheikh', 'Analyst', 'Analytics', '2024-02-05', 'Active', 'Junior Consultant', 65000, null],
  ['EMP006', 'Rahul Verma', 'Senior Consultant', 'SAP Logistics', '2021-11-15', 'Active', 'Senior Consultant', 160000, null],
  ['EMP007', 'Divya Nair', 'Associate Consultant', 'SAP Finance', '2025-07-01', 'Active', 'Junior Consultant', 48000, null],
  ['EMP008', 'Arjun Singh', 'Senior Developer', 'Digital', '2023-09-18', 'Active', 'Standard', 90000, null],
  ['EMP009', 'Sneha Patil', 'QA Engineer', 'Digital', '2024-06-03', 'Active', 'Junior Consultant', 55000, 60000],
  ['EMP010', 'Mohammed Irfan', 'Consultant', 'Analytics', '2023-12-11', 'Active', 'Standard', 85000, null],
  ['EMP011', 'Lakshmi Venkatesh', 'Senior Consultant', 'SAP HCM', '2022-04-25', 'Active', 'Contract Consultant', 175000, null],
  ['EMP012', 'Rohit Gupta', 'Project Manager', 'Delivery', '2020-09-07', 'Active', 'Senior Consultant', 230000, null],
  ['EMP013', 'Ananya Das', 'Associate Developer', 'Digital', '2026-10-12', 'Active', 'Junior Consultant', 42000, null],
  ['EMP014', 'Suresh Babu', 'Technical Writer', 'Delivery', '2024-01-15', 'Active', 'Junior Consultant', 50000, null],
  ['EMP015', 'Kavita Joshi', 'Consultant', 'SAP Logistics', '2021-03-08', 'Inactive', 'Standard', 120000, null],
];

// Standard billing rate per designation, used for assignments without an agreed rate: [designation, billing type, rate]
const DESIGNATION_RATES = [
  ['Project Manager', 'Monthly', 300000],
  ['Lead Consultant', 'Monthly', 425000],
  ['Senior Consultant', 'Monthly', 350000],
  ['Consultant', 'Monthly', 240000],
  ['Associate Consultant', 'Daily', 6500],
  ['Senior Developer', 'Daily', 12000],
  ['Developer', 'Daily', 9000],
  ['Associate Developer', 'Daily', 5000],
  ['Analyst', 'Hourly', 1200],
  ['QA Engineer', 'Hourly', 900],
  ['Technical Writer', 'Daily', 4500],
];

// [employee code, customer, role, start, end, billing type, rate]
// Billing type and rate are null where the standard rate for the designation applies; EMP012 is split across
// two customers at an agreed rate.
const ASSIGNMENTS = [
  ['EMP001', 'Nimbus Retail Pvt Ltd', 'S/4HANA Finance Lead', '2025-04-01', null, null, null],
  ['EMP002', 'Bharat Logistics Ltd', 'MM Consultant', '2025-10-01', null, null, null],
  ['EMP003', 'Nimbus Retail Pvt Ltd', 'ABAP Developer', '2026-01-05', null, null, null],
  ['EMP004', 'Kaveri Pharma Ltd', 'Basis Support', '2025-06-01', null, null, null],
  ['EMP005', 'Orion FinServ Pvt Ltd', 'Reporting Analyst', '2026-02-01', null, null, null],
  ['EMP006', 'Bharat Logistics Ltd', 'SD Consultant', '2026-03-16', null, null, null],
  ['EMP007', 'Nimbus Retail Pvt Ltd', 'FICO Support', '2026-08-01', null, null, null],
  ['EMP008', 'Orion FinServ Pvt Ltd', 'Portal Developer', '2025-12-01', '2026-09-30', null, null],
  ['EMP008', 'Deccan Motors Ltd', 'Dealer App Developer', '2026-10-05', null, null, null],
  ['EMP009', 'Deccan Motors Ltd', 'Test Engineer', '2026-05-01', null, null, null],
  ['EMP010', 'Kaveri Pharma Ltd', 'Power BI Dashboards', '2026-07-15', '2026-12-31', null, null],
  ['EMP011', 'Orion FinServ Pvt Ltd', 'SuccessFactors EC Consultant', '2025-11-01', null, null, null],
  ['EMP012', 'Bharat Logistics Ltd', 'Engagement Manager', '2025-10-01', null, 'Monthly', 150000],
  ['EMP012', 'Nimbus Retail Pvt Ltd', 'Engagement Manager', '2025-04-01', null, 'Monthly', 150000],
  ['EMP013', 'Deccan Motors Ltd', 'Junior Developer', '2026-12-01', null, null, null],
  ['EMP015', 'Sahyadri Foods Pvt Ltd', 'PP Consultant', '2024-06-01', '2026-06-30', null, null],
];
// EMP013 (until December) and EMP014 have no current assignment — they show as "on bench".

const HOLIDAYS = { '2026-08-15': 'Independence Day', '2026-10-02': 'Gandhi Jayanti', '2026-10-20': 'Dussehra', '2026-11-09': 'Diwali' };
const ATTENDANCE_FROM = '2026-08-01';
const ATTENDANCE_TO = f.addDays(f.today(), -1);

function dayStatus() {
  const r = rand();
  if (r < 0.88) return 'P';
  if (r < 0.92) return 'PL';
  if (r < 0.95) return 'HD';
  if (r < 0.98) return 'A';
  return 'UL';
}

const summary = tx(() => {
  const profileIds = Object.fromEntries(db.prepare('SELECT id, name FROM pay_profiles').all().map(p => [p.name, p.id]));
  const insProfile = db.prepare('INSERT INTO pay_profiles (name, description) VALUES (?, ?)');
  const insComp = db.prepare('INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, description, components] of PAY_PROFILES) {
    if (profileIds[name]) continue;
    profileIds[name] = Number(insProfile.run(name, description).lastInsertRowid);
    components.forEach((c, i) => insComp.run(profileIds[name], ...c, i));
  }


  const insCustomer = db.prepare('INSERT INTO customers (name, contact_person, email, phone, address, gstin, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const customerIds = Object.fromEntries(CUSTOMERS.map(c => [c[0], Number(insCustomer.run(...c).lastInsertRowid)]));

  const insEmployee = db.prepare(`INSERT INTO employees (code, name, email, phone, designation, department, join_date, status, pan, bank_name, bank_account, ifsc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insPay = db.prepare('INSERT INTO employee_pay (employee_id, profile_id, monthly_gross, effective_from) VALUES (?, ?, ?, ?)');
  const banks = [['HDFC Bank', 'HDFC0001234'], ['ICICI Bank', 'ICIC0004567'], ['State Bank of India', 'SBIN0007890'], ['Axis Bank', 'UTIB0002345']];
  const employeeIds = {};
  let payRecords = 0;
  EMPLOYEES.forEach(([code, name, designation, department, joinDate, status, profile, gross, raise], i) => {
    const [bank, ifsc] = banks[i % banks.length];
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@smartconsulting.example`;
    const pan = `ABCPS${String(1000 + i * 37).slice(-4)}${String.fromCharCode(65 + (i % 26))}`;
    const id = Number(insEmployee.run(code, name, email, `+91 98${String(45000000 + i * 104729).slice(-8)}`, designation, department, joinDate, status,
      pan, bank, String(50100000000000 + i * 7919237), ifsc).lastInsertRowid);
    employeeIds[code] = id;
    insPay.run(id, profileIds[profile], gross, joinDate > '2026-04-01' ? joinDate : '2026-04-01');
    payRecords++;
    if (raise) {
      insPay.run(id, profileIds[profile], raise, '2026-10-01');
      payRecords++;
    }
  });

  const insAssignment = db.prepare(`INSERT INTO assignments (employee_id, customer_id, role, designation, department, start_date, end_date, billing_type, rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byCode = Object.fromEntries(EMPLOYEES.map(e => [e[0], e]));
  for (const [code, customer, role, start, end, type, rate] of ASSIGNMENTS) {
    const [, , designation, department] = byCode[code];
    // Assignments without an agreed rate get the standard rate for their designation.
    const standard = DESIGNATION_RATES.find(r => r[0] === designation);
    insAssignment.run(employeeIds[code], customerIds[customer], role, designation, department, start, end,
      type || standard[1], rate ?? standard[2]);
  }

  // Completed months are recorded as monthly leave days; the current month day by day.
  const insAttendance = db.prepare('INSERT INTO attendance (employee_id, date, status, hours, note) VALUES (?, ?, ?, ?, ?)');
  const insMonthly = db.prepare('INSERT INTO monthly_attendance (employee_id, month, leave_days) VALUES (?, ?, ?)');
  const currentMonth = f.currentMonth();
  let attendanceRows = 0;
  let monthlyRows = 0;
  for (const [code, , , , joinDate, status] of EMPLOYEES) {
    if (status !== 'Active') continue;
    const months = new Map();
    for (let date = joinDate > ATTENDANCE_FROM ? joinDate : ATTENDANCE_FROM; date <= ATTENDANCE_TO; date = f.addDays(date, 1)) {
      const weekday = f.weekday(date);
      let s;
      let note = null;
      if (weekday === 'Sat' || weekday === 'Sun') s = 'WO';
      else if (HOLIDAYS[date]) [s, note] = ['H', HOLIDAYS[date]];
      else s = dayStatus();
      const hours = s === 'P' ? 8 + Math.floor(rand() * 5) * 0.5 : ATTENDANCE[s].hours;
      const month = date.slice(0, 7);
      if (month < currentMonth) {
        // Leave = weekdays not worked: paid/unpaid leave, absences and half of each half day.
        months.set(month, (months.get(month) || 0) + (s === 'PL' ? 1 : ATTENDANCE[s].lop));
        continue;
      }
      if (s === 'PL') note = 'Planned leave';
      if (s === 'A') note = 'Unplanned absence';
      insAttendance.run(employeeIds[code], date, s, hours, note);
      attendanceRows++;
    }
    for (const [month, leave] of months) {
      insMonthly.run(employeeIds[code], month, leave);
      monthlyRows++;
    }
  }

  return {
    'pay profiles': PAY_PROFILES.length, customers: CUSTOMERS.length, employees: EMPLOYEES.length,
    assignments: ASSIGNMENTS.length, 'monthly attendance entries': monthlyRows, 'daily attendance (current month)': attendanceRows,
    'employee pay records': payRecords,
  };
});

console.log(`Demo data loaded (attendance ${ATTENDANCE_FROM} to ${ATTENDANCE_TO}):`);
for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
