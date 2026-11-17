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

// Amount in words, Indian numbering (thousand, lakh, crore):
// 1051344.6 → "Rupees Ten Lakh Fifty-One Thousand Three Hundred Forty-Four and Sixty Paise Only".
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const belowHundred = n => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const belowThousand = n => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', belowHundred(n % 100)].filter(Boolean).join(' ');
function integerWords(n) {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7);
  const rest = n % 1e7;
  const parts = [
    crore ? `${integerWords(crore)} Crore` : '',
    Math.floor(rest / 1e5) ? `${belowHundred(Math.floor(rest / 1e5))} Lakh` : '',
    Math.floor((rest % 1e5) / 1000) ? `${belowHundred(Math.floor((rest % 1e5) / 1000))} Thousand` : '',
    belowThousand(rest % 1000),
  ];
  return parts.filter(Boolean).join(' ');
}
function amountInWords(value) {
  const paiseTotal = Math.round(Math.abs(Number(value) || 0) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  return `Rupees ${integerWords(rupees)}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`;
}

module.exports = {
  money, amount, round2, qty, today, currentMonth, isMonth, isDate, daysInMonth, monthStart, monthEnd,
  addDays, addMonths, daysBetween, weekdaysBetween, fmtDate, monthLabel, weekday, amountInWords,
};
