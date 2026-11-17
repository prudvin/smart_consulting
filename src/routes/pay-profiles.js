const express = require('express');
const { db, tx, getSetting } = require('../db');
const { COMPONENT_CALCS, COMPONENT_KINDS } = require('../constants');
const { computePayslip } = require('../services/payroll');
const { flash, isUniqueError, isForeignKeyError } = require('../middleware');

const router = express.Router();
const SAMPLE_GROSS = 18000;

function readProfile(body) {
  const components = Object.values(body.components || {})
    .map(c => ({
      name: String(c.name || '').trim(),
      kind: COMPONENT_KINDS[c.kind] ? c.kind : 'Earning',
      calc: COMPONENT_CALCS[c.calc] ? c.calc : 'Fixed',
      value: c.calc === 'PTTelangana' ? 0 : Number(c.value) || 0,
    }))
    .filter(c => c.name);
  return { name: String(body.name || '').trim(), description: String(body.description || '').trim(), components };
}

function validate(p) {
  if (!p.name) return 'Profile name is required.';
  if (!p.components.some(c => c.kind === 'Earning' && !['EPF', 'ESI'].includes(c.calc))) return 'Add at least one salary earning (e.g. Basic).';
  for (const c of p.components) {
    if (c.value < 0) return `"${c.name}" cannot have a negative value.`;
    if (c.kind !== 'Earning' && c.calc === 'Balance') return `"${c.name}": "Balance of gross" is only valid for earnings.`;
    if (c.kind !== 'Deduction' && c.calc === 'PTTelangana') return `"${c.name}": the Telangana PT slab is only valid for deductions.`;
    // EPF must use the EPF calculation so the PF wage ceiling (basic counted up to ₹15,000) applies.
    if (/(e?pf|provident)/i.test(c.name) && c.calc === 'PctBasic') {
      return `"${c.name}": use the "EPF" calculation instead of "% of basic", so a basic above the PF wage ceiling (₹15,000) is counted as ₹15,000.`;
    }
    if ((c.calc.startsWith('Pct') || ['EPF', 'ESI'].includes(c.calc)) && c.value > 100) return `"${c.name}": percentage cannot exceed 100.`;
  }
  if (p.components.filter(c => c.calc === 'Balance').length > 1) return 'Only one component can use "Balance of gross".';
  const earnings = p.components.filter(c => c.kind === 'Earning');
  const basic = earnings.find(c => c.name.trim().toLowerCase() === 'basic') || earnings[0];
  if (basic && basic.calc === 'PctBasic') {
    return `"${basic.name}" is the basic component, so it can't be a % of basic. Use % of gross or a fixed amount.`;
  }
  if (p.components.filter(c => c.calc === 'PTTelangana').length > 1) return 'Only one component can use the Telangana PT slab.';
  return null;
}

function saveComponents(profileId, components) {
  db.prepare('DELETE FROM pay_components WHERE profile_id = ?').run(profileId);
  const stmt = db.prepare('INSERT INTO pay_components (profile_id, name, kind, calc, value, sort) VALUES (?, ?, ?, ?, ?, ?)');
  components.forEach((c, i) => stmt.run(profileId, c.name, c.kind, c.calc, c.value, i));
}

const pfWageCeiling = () => Number(getSetting('pf_wage_ceiling', '15000')) || 0;
const sampleGrossFrom = req => (Number(req.query.sample_gross) > 0 ? Number(req.query.sample_gross) : SAMPLE_GROSS);

const renderForm = (res, p, isNew, error, sampleGross = SAMPLE_GROSS) =>
  res.status(error ? 400 : 200).render('pay-profiles/form', {
    title: isNew ? 'New pay profile' : `Edit pay profile ${p.name}`, p, isNew, error, COMPONENT_CALCS, COMPONENT_KINDS,
    sample: p.components.length ? { gross: sampleGross, ...computePayslip(p.components, sampleGross, 1, { pfWageCeiling: pfWageCeiling() }) } : null,
  });

router.get('/', (req, res) => {
  const profiles = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM pay_components WHERE profile_id = p.id) AS component_count,
      (SELECT COUNT(DISTINCT employee_id) FROM employee_pay WHERE profile_id = p.id) AS employee_count
    FROM pay_profiles p ORDER BY p.name`).all();
  res.render('pay-profiles/list', { title: 'Pay profiles', profiles });
});

router.get('/new', (req, res) => {
  renderForm(res, {
    name: '', description: '',
    components: [
      { name: 'Basic', kind: 'Earning', calc: 'PctGross', value: 50 },
      { name: 'Special Allowance', kind: 'Earning', calc: 'Balance', value: 0 },
      { name: 'EPF', kind: 'Deduction', calc: 'EPF', value: 12 },
      { name: 'ESI', kind: 'Deduction', calc: 'ESI', value: 0.75 },
      { name: 'Professional Tax', kind: 'Deduction', calc: 'PTTelangana', value: 0 },
      { name: 'Employer EPF', kind: 'Employer', calc: 'EPF', value: 13 },
      { name: 'Employer ESI', kind: 'Employer', calc: 'ESI', value: 3.25 },
    ],
  }, true, null, sampleGrossFrom(req));
});

router.post('/', (req, res) => {
  const p = readProfile(req.body);
  let error = validate(p);
  if (!error) {
    try {
      tx(() => {
        const id = db.prepare('INSERT INTO pay_profiles (name, description) VALUES (?, ?)').run(p.name, p.description || null).lastInsertRowid;
        saveComponents(id, p.components);
      });
      flash(req, 'success', `Pay profile "${p.name}" created.`);
      return res.redirect('/pay-profiles');
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'A pay profile with that name already exists.';
    }
  }
  renderForm(res, p, true, error);
});

router.get('/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM pay_profiles WHERE id = ?').get(Number(req.params.id));
  if (!p) return next();
  p.components = db.prepare('SELECT * FROM pay_components WHERE profile_id = ? ORDER BY sort, id').all(p.id);
  renderForm(res, p, false, null, sampleGrossFrom(req));
});

router.post('/:id', (req, res, next) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM pay_profiles WHERE id = ?').get(id)) return next();
  const p = { ...readProfile(req.body), id };
  let error = validate(p);
  if (!error) {
    try {
      tx(() => {
        db.prepare('UPDATE pay_profiles SET name = ?, description = ? WHERE id = ?').run(p.name, p.description || null, id);
        saveComponents(id, p.components);
      });
      flash(req, 'success', `Pay profile "${p.name}" updated. Regenerate any draft payroll to apply the changes.`);
      return res.redirect('/pay-profiles');
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      error = 'A pay profile with that name already exists.';
    }
  }
  renderForm(res, p, false, error);
});

router.post('/:id/delete', (req, res) => {
  try {
    db.prepare('DELETE FROM pay_profiles WHERE id = ?').run(Number(req.params.id));
    flash(req, 'success', 'Pay profile deleted.');
  } catch (err) {
    if (!isForeignKeyError(err)) throw err;
    flash(req, 'error', 'This pay profile is assigned to employees and cannot be deleted.');
  }
  res.redirect('/pay-profiles');
});

module.exports = router;
