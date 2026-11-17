// Attendance codes.
// lop: loss-of-pay days counted against salary. billable: days billable to the customer.
// hours: default hours recorded when none are entered.
const ATTENDANCE = {
  P: { label: 'Present', lop: 0, billable: 1, hours: 8 },
  HD: { label: 'Half day', lop: 0.5, billable: 0.5, hours: 4 },
  A: { label: 'Absent', lop: 1, billable: 0, hours: 0 },
  // There is one leave type, "Leave", and it is unpaid. UL is kept only so older daily records still read as leave.
  PL: { label: 'Leave', lop: 1, billable: 0, hours: 0 },
  UL: { label: 'Leave', lop: 1, billable: 0, hours: 0, legacy: true },
  H: { label: 'Holiday', lop: 0, billable: 0, hours: 0 },
  WO: { label: 'Week off', lop: 0, billable: 0, hours: 0 },
};

const COMPONENT_CALCS = {
  Fixed: 'Fixed amount',
  PctGross: '% of gross',
  PctBasic: '% of basic',
  Balance: 'Balance of gross',
  PTTelangana: 'Telangana PT slab',
  EPF: 'EPF: % of basic (max ₹15,000)',
  ESI: 'ESI: % of gross (if eligible)',
};

const COMPONENT_KINDS = {
  Earning: 'Earning',
  Deduction: 'Deduction',
  Employer: 'Employer contribution',
};

// ESI applies to employees whose monthly gross wages are at or below this limit.
const ESI_WAGE_LIMIT = 21000;

// Telangana professional tax on salary and wage earners, by monthly salary or wage
// (Schedule, entry 1: https://www.tgct.gov.in/tgportal/AllActs/APPT/APPTSchedule.aspx).
const TELANGANA_PT_SLABS = [
  { upTo: 15000, tax: 0 },
  { upTo: 20000, tax: 150 },
  { upTo: Infinity, tax: 200 },
];

const BILLING_TYPES = { Monthly: 'month', Daily: 'day', Hourly: 'hour' };

const INVOICE_STATUSES = ['Draft', 'Sent', 'Paid', 'Cancelled'];

module.exports = {
  ATTENDANCE, COMPONENT_CALCS, COMPONENT_KINDS, ESI_WAGE_LIMIT, TELANGANA_PT_SLABS, BILLING_TYPES, INVOICE_STATUSES,
};
