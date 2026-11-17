const express = require('express');
const { getSettings, setSetting, tx } = require('../db');
const { flash } = require('../middleware');

const router = express.Router();
const KEYS = ['company_name', 'company_address', 'company_gstin', 'company_email', 'company_phone',
  'invoice_prefix', 'default_tax_rate', 'tax_label', 'payment_terms_days', 'bank_details', 'pf_wage_ceiling'];

router.get('/', (req, res) => {
  res.render('settings', { title: 'Settings', s: getSettings(), error: null });
});

router.post('/', (req, res) => {
  const s = Object.fromEntries(KEYS.map(k => [k, String(req.body[k] ?? '').trim()]));
  let error = null;
  if (!s.company_name) error = 'Company name is required.';
  else if (!(Number(s.default_tax_rate) >= 0 && Number(s.default_tax_rate) <= 100)) error = 'Default tax rate must be between 0 and 100.';
  else if (!(Number.isInteger(Number(s.payment_terms_days)) && Number(s.payment_terms_days) >= 0)) error = 'Payment terms must be a whole number of days.';
  else if (!(Number(s.pf_wage_ceiling) >= 0)) error = 'PF wage ceiling must be zero or more.';
  if (error) return res.status(400).render('settings', { title: 'Settings', s, error });

  tx(() => KEYS.forEach(k => setSetting(k, s[k])));
  flash(req, 'success', 'Settings saved.');
  res.redirect('/settings');
});

module.exports = router;
