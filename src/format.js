// Formatting and date helpers. Dates are stored as ISO 'YYYY-MM-DD' strings, months as 'YYYY-MM'.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const plain = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const money = n => inr.format(Number(n) || 0);
const amount = n => plain.format(Number(n) || 0);
const round2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const qty = n => String(round2(n));

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const currentMonth = () => today().slice(0, 7);

const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));

const daysInMonth = ym => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthStart = ym => `${ym}-01`;
const monthEnd = ym => `${ym}-${pad(daysInMonth(ym))}`;

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
// Inclusive count of days between two ISO dates.
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

// Inclusive count of Monday–Friday days between two ISO dates.
const weekdaysBetween = (from, to) => {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
};

const fmtDate = iso =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const monthLabel = ym =>
  ym ? new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
const weekday = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });

module.exports = {
  money, amount, round2, qty, today, currentMonth, isMonth, isDate, daysInMonth, monthStart, monthEnd,
  addDays, addMonths, daysBetween, weekdaysBetween, fmtDate, monthLabel, weekday,
};
