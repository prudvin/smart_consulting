// Mobile menu: the ☰ button slides the sidebar in; the backdrop, Esc or choosing a page closes it.
function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  const btn = document.querySelector('[data-nav-toggle]');
  if (btn) {
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-nav-toggle]')) setNav(!document.body.classList.contains('nav-open'));
  else if (e.target.closest('[data-nav-close]') || e.target.closest('.sidebar nav a')) setNav(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setNav(false);
});

// Confirm destructive actions: <form data-confirm="Are you sure?">
document.addEventListener('submit', e => {
  const msg = e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

document.addEventListener('click', e => {
  // Add a row from a <template>: <button data-add-row="tbodyId" data-template="templateId">
  const add = e.target.closest('[data-add-row]');
  if (add) {
    e.preventDefault();
    const tbody = document.getElementById(add.dataset.addRow);
    const tpl = document.getElementById(add.dataset.template);
    const next = Number(tbody.dataset.next || tbody.children.length) + 1;
    tbody.dataset.next = String(next);
    tbody.insertAdjacentHTML('beforeend', tpl.innerHTML.replaceAll('__i__', `n${next}`));
    return;
  }

  const remove = e.target.closest('[data-remove-row]');
  if (remove) {
    e.preventDefault();
    remove.closest('tr').remove();
    return;
  }

  // Attendance: fill every status select with a value.
  const mark = e.target.closest('[data-mark-all]');
  if (mark) {
    e.preventDefault();
    const onlyEmpty = mark.dataset.onlyEmpty === '1';
    document.querySelectorAll('select[data-att]').forEach(s => {
      if (!onlyEmpty || !s.value) s.value = mark.dataset.markAll;
    });
  }
});

// Monthly attendance: live paid days and days worked from leave days, and filling empty rows.
function recalcMonthRows() {
  document.querySelectorAll('tr[data-month-row]').forEach(tr => {
    const input = tr.querySelector('[data-leave]');
    const paidCell = tr.querySelector('[data-paid]');
    const workedCell = tr.querySelector('[data-worked]');
    if (input.value === '' && tr.dataset.dailyLeave !== '') {
      paidCell.textContent = workedCell.textContent = 'daily';
      paidCell.className = workedCell.className = 'num muted';
      return;
    }
    const leave = parseFloat(input.value) || 0;
    const weekdays = Number(tr.dataset.weekdays);
    paidCell.textContent = String(Number(tr.dataset.employed) - leave);
    workedCell.textContent = String(weekdays - leave);
    paidCell.className = 'num';
    workedCell.className = leave > weekdays ? 'num error-text' : 'num';
    workedCell.title = leave > weekdays ? 'Leave days are more than working days' : '';
  });
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-fill-month]');
  if (!btn) return;
  e.preventDefault();
  document.querySelectorAll('tr[data-month-row]').forEach(tr => {
    const input = tr.querySelector('[data-leave]');
    // Only fill rows shown by the current filters, and never finalized (locked) rows.
    if (input.value !== '' || tr.hidden || input.disabled) return;
    if (btn.dataset.fillMonth === 'zero') input.value = 0;
    else if (tr.dataset.dailyLeave !== '') input.value = tr.dataset.dailyLeave;
  });
  recalcMonthRows();
});
document.addEventListener('input', recalcMonthRows);
document.addEventListener('DOMContentLoaded', recalcMonthRows);

// Payroll: confirm before generating a month that already has a run, since it will be cleared and regenerated.
document.addEventListener('submit', e => {
  const form = e.target;
  if (!form.matches('[data-generate-payroll]')) return;
  const month = form.querySelector('[name="month"]').value;
  const status = JSON.parse(form.dataset.existing || '{}')[month];
  if (!status) return;
  if (status === 'Finalized' && !form.dataset.admin) {
    e.preventDefault();
    window.alert(`Payroll for ${month} is finalized. Only an administrator can clear and regenerate it.`);
    return;
  }
  const msg = `Payroll for ${month} already exists (${status}). Clear it and all its payslips, and generate it again?`;
  if (!window.confirm(msg)) e.preventDefault();
});

// Table filters for a <tbody id="...">:
// - <input data-filter-table="id">: rows must contain every typed word.
// - <select data-filter-for="id" data-filter-attr="x">: rows whose data-x matches the choice ("|" separates several values).
// - <button data-filter-clear="id">: resets them all.
const dataRows = tbody => [...tbody.rows].filter(r => !r.hasAttribute('data-filter-empty') && !r.querySelector('td.empty'));
function filterTable(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const search = document.querySelector(`[data-filter-table="${tbodyId}"]`);
  const words = search ? search.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const selects = [...document.querySelectorAll(`[data-filter-for="${tbodyId}"]`)].filter(s => s.value);
  const rows = dataRows(tbody);
  let shown = 0;
  for (const row of rows) {
    const text = row.textContent.toLowerCase();
    const match = words.every(w => text.includes(w))
      && selects.every(s => (row.dataset[s.dataset.filterAttr] || '').split('|').includes(s.value));
    row.hidden = !match;
    if (match) shown++;
  }
  const empty = tbody.querySelector('[data-filter-empty]');
  if (empty) empty.hidden = shown > 0 || rows.length === 0;
  const count = document.querySelector(`[data-filter-count="${tbodyId}"]`);
  if (count) count.textContent = words.length || selects.length ? `${shown} of ${rows.length} shown` : `${rows.length} employees`;
}
document.addEventListener('input', e => {
  const id = e.target.dataset.filterTable || e.target.dataset.filterFor;
  if (id) filterTable(id);
});
document.addEventListener('click', e => {
  const clear = e.target.closest('[data-filter-clear]');
  if (!clear) return;
  const id = clear.dataset.filterClear;
  document.querySelectorAll(`[data-filter-table="${id}"], [data-filter-for="${id}"]`).forEach(el => { el.value = ''; });
  filterTable(id);
});
document.addEventListener('DOMContentLoaded', () => {
  const ids = new Set([...document.querySelectorAll('[data-filter-table], [data-filter-for]')].map(el => el.dataset.filterTable || el.dataset.filterFor));
  ids.forEach(filterTable);
});

// Sortable tables: <table data-sortable="tbodyId"> with <button data-sort-col="n" data-sort-type="text|num"> in headers.
// A cell's data-sort value is used when present, otherwise its text; values starting with "~" (e.g. "On bench",
// "No pay profile") sort after everything else. Clicking again reverses the order.
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-sort-col]');
  if (!btn) return;
  const table = btn.closest('table');
  const tbody = document.getElementById(table.dataset.sortable);
  const th = btn.closest('th');
  const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
  table.querySelectorAll('th[aria-sort]').forEach(h => h.removeAttribute('aria-sort'));
  th.setAttribute('aria-sort', dir);

  const col = Number(btn.dataset.sortCol);
  const numeric = btn.dataset.sortType === 'num';
  const key = row => {
    const cell = row.cells[col];
    const v = cell.dataset.sort ?? cell.textContent.trim();
    if (numeric) return v === '' ? -Infinity : Number(v);
    return (v.startsWith('~') ? '￿' : '') + v.toLowerCase();
  };
  const rows = dataRows(tbody);
  rows.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    const c = numeric ? x - y : x.localeCompare(y, undefined, { numeric: true });
    return dir === 'ascending' ? c : -c;
  });
  const tail = tbody.querySelector('[data-filter-empty]');
  rows.forEach(r => tbody.insertBefore(r, tail));
});

// Employee pay: the change icon opens a popup prefilled with the employee's current pay.
document.addEventListener('click', e => {
  const open = e.target.closest('[data-change-pay]');
  if (open) {
    const dialog = document.getElementById('change-pay');
    const field = name => dialog.querySelector(`[name="${name}"]`);
    field('employee_id').value = open.dataset.employeeId;
    field('profile_id').value = open.dataset.profileId;
    field('monthly_gross').value = open.dataset.gross;
    dialog.querySelector('[data-name]').textContent = open.dataset.employeeName;
    dialog.showModal();
    field(open.dataset.profileId ? 'monthly_gross' : 'profile_id').focus();
    return;
  }
  const close = e.target.closest('[data-close-dialog]');
  if (close) closeDialog(close.closest('dialog'));
  // Clicking the backdrop (outside the popup's box) closes it too.
  if (e.target.matches('dialog.modal, dialog.drawer, dialog.doc-popup')) closeDialog(e.target);
});

// Closing a panel with unsaved form changes asks first.
const hasUnsavedChanges = dialog => dialog.dataset.unsaved === '1';
const confirmDiscard = dialog => !hasUnsavedChanges(dialog) || window.confirm('Discard your unsaved changes?');
function closeDialog(dialog) {
  if (dialog && confirmDiscard(dialog)) dialog.close();
}

// Employee form: a resignation date makes the employee Inactive, so lock the status while one is set.
function syncResignation() {
  const date = document.querySelector('[data-resignation]');
  const status = document.querySelector('[data-status]');
  if (!date || !status) return;
  if (date.value) {
    status.value = 'Inactive';
    status.disabled = true;
    status.title = 'Inactive because a resignation date is set';
  } else {
    status.disabled = false;
    status.title = '';
  }
}
document.addEventListener('input', e => { if (e.target.matches('[data-resignation]')) syncResignation(); });
document.addEventListener('DOMContentLoaded', syncResignation);

// Customer form: the agency charge value is a percentage or a ₹ amount, and isn't needed for "None".
function syncAgency() {
  document.querySelectorAll('[data-agency-type]').forEach(type => {
    const form = type.form;
    const wrap = form.querySelector('[data-agency-value-wrap]');
    const input = form.querySelector('[data-agency-value]');
    const none = type.value === 'None';
    wrap.hidden = none;
    input.required = !none;
    input.max = type.value === 'Percent' ? '100' : '';
    form.querySelector('[data-agency-label]').textContent = type.value === 'Percent' ? 'Agency charges (%)' : 'Agency charges (₹ per invoice)';
  });
}
document.addEventListener('change', e => { if (e.target.matches('[data-agency-type]')) syncAgency(); });
document.addEventListener('DOMContentLoaded', syncAgency);

// Slide-over panel (<dialog class="drawer" id="detail-drawer">) on list pages:
// - <tr data-panel-url="..."> opens that URL in the panel when clicked (links, buttons and fields inside keep their behaviour);
// - [data-panel-load="url"] inside the panel loads another view into it (e.g. Edit, Cancel);
// - <form data-panel-form> inside the panel is submitted in place, showing the server's response in the panel.
// After a save (the response URL has saved=1) the list is reloaded when the panel closes, so it shows the changes.
const drawer = () => document.getElementById('detail-drawer');
function showInPanel(html) {
  const dialog = drawer();
  const box = dialog.querySelector('[data-drawer-content]');
  box.innerHTML = html;
  dialog.dataset.unsaved = '';
  dialog.scrollTop = 0;
  syncResignation();
  syncAgency();
  const focusTarget = box.querySelector('.flash.error') ? box.querySelector('input:not([type=hidden]), select') : box.querySelector('[data-close-dialog]');
  if (focusTarget) focusTarget.focus();
}
async function loadPanel(url, options = {}) {
  const dialog = drawer();
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' }, ...options });
    if (res.url.includes('/login')) return window.location.reload(); // session expired
    if (!res.ok && res.status !== 400) throw new Error(String(res.status)); // 400 = form with validation errors
    if (/[?&]saved=/.test(res.url)) dialog.dataset.changed = '1';
    showInPanel(await res.text());
  } catch {
    const page = url.replace(/\?.*$/, '').replace(/\/edit$/, '');
    showInPanel(`<p class="flash error" style="margin: 20px">Couldn't load this. <a href="${page}">Open the full page</a>.</p>`);
  }
}
function openPanel(row) {
  const dialog = drawer();
  if (!dialog) return;
  document.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));
  row.classList.add('row-selected');
  showInPanel('<p class="drawer-loading muted">Loading…</p>');
  loadPanel(row.dataset.panelUrl);
}
document.addEventListener('click', e => {
  const row = e.target.closest('tr[data-panel-url]');
  if (row && !e.target.closest('a, button, input, select, textarea, label, form')) return openPanel(row);
  const load = e.target.closest('[data-panel-load]');
  if (load && drawer() && drawer().contains(load)) {
    e.preventDefault();
    if (load.hasAttribute('data-discard-check') && !confirmDiscard(drawer())) return;
    loadPanel(load.dataset.panelLoad);
  }
});
// Rows inside a details view (e.g. a customer's consultants): <tr data-panel-row="url" data-href="page">.
// In the slide-over panel they load that URL into the panel; elsewhere (a full page) they open data-href.
function openRowInPlace(row) {
  const dialog = drawer();
  if (dialog && dialog.contains(row)) loadPanel(row.dataset.panelRow);
  else if (row.dataset.href) window.location.assign(row.dataset.href);
}
document.addEventListener('click', e => {
  const row = e.target.closest('tr[data-panel-row]');
  if (row && !e.target.closest('a, button, input, select, textarea, label, form')) openRowInPlace(row);
});
document.addEventListener('click', e => {
  const link = e.target.closest('a[data-panel-open]');
  if (!link || !drawer() || e.ctrlKey || e.metaKey || e.shiftKey) return; // Ctrl/Shift-click still opens the page
  e.preventDefault();
  showInPanel('<p class="drawer-loading muted">Loading…</p>');
  loadPanel(link.dataset.panelOpen);
});
document.addEventListener('keydown', e => {
  const row = e.target.closest && e.target.closest('tr[data-panel-row]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openRowInPlace(row);
  }
});
document.addEventListener('keydown', e => {
  const row = e.target.closest && e.target.closest('tr[data-panel-url]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openPanel(row);
  }
});
document.addEventListener('input', e => {
  if (e.target.closest('form[data-panel-form]')) drawer().dataset.unsaved = '1';
});
document.addEventListener('submit', e => {
  const form = e.target.closest('form[data-panel-form]');
  if (!form) return;
  e.preventDefault();
  const button = form.querySelector('[type=submit]');
  if (button) { button.disabled = true; button.textContent = 'Saving…'; }
  loadPanel(form.getAttribute('action'), {
    method: 'POST',
    headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(new FormData(form)).toString(),
  });
});
// Esc on a panel with unsaved changes asks first.
document.addEventListener('cancel', e => {
  if (e.target.id === 'detail-drawer' && !confirmDiscard(e.target)) e.preventDefault();
}, true);
// When the panel closes: reload the list if something was saved, otherwise return focus to the row.
document.addEventListener('close', e => {
  if (e.target.id !== 'detail-drawer') return;
  e.target.dataset.unsaved = '';
  if (e.target.dataset.changed === '1') return window.location.reload();
  const row = document.querySelector('tr.row-selected');
  if (row) { row.classList.remove('row-selected'); row.focus(); }
}, true);

// Document popup: [data-popup-load="url"] shows that URL (e.g. a payslip) in <dialog id="popup-dialog"> over the page,
// even on top of the slide-over panel. [data-print-popup] prints just the popup's document.
// The server normally returns just the popup content. If it returns a whole page instead (e.g. a server that hasn't
// been restarted since an update), show only that page's document (.doc) with the popup's own header.
function popupContent(html, fallback) {
  if (!/<html[\s>]/i.test(html)) return html;
  const page = new DOMParser().parseFromString(html, 'text/html');
  const doc = page.querySelector('.doc');
  if (!doc) return html;
  const title = (page.title || '').split(' · ')[0];
  return `<div class="popup-head no-print">
    <h2 id="popup-title"></h2>
    <div class="popup-actions">
      <button type="button" class="btn" data-print-popup>Print / Save as PDF</button>
      <a class="btn secondary" href="${fallback}">Open full page</a>
      <button type="button" class="icon-btn" data-close-dialog aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41 6.3 6.3-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/></svg>
      </button>
    </div>
  </div>
  <div class="popup-body">${doc.outerHTML}</div>`.replace('<h2 id="popup-title"></h2>', `<h2 id="popup-title">${title.replace(/</g, '&lt;')}</h2>`);
}
async function openPopup(url, fallback) {
  const dialog = document.getElementById('popup-dialog');
  if (!dialog) return window.location.assign(fallback);
  const box = dialog.querySelector('[data-popup-content]');
  box.innerHTML = '<p class="drawer-loading muted">Loading…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } });
    if (res.url.includes('/login')) return window.location.reload(); // session expired
    if (!res.ok) throw new Error(String(res.status));
    box.innerHTML = popupContent(await res.text(), fallback);
    dialog.scrollTop = 0;
    const close = box.querySelector('[data-close-dialog]');
    if (close) close.focus();
  } catch {
    box.innerHTML = `<p class="flash error" style="margin: 20px">Couldn't load this. <a href="${fallback}">Open the full page</a>.</p>`;
  }
}
document.addEventListener('click', e => {
  const link = e.target.closest('[data-popup-load]');
  if (link) {
    e.preventDefault();
    openPopup(link.dataset.popupLoad, link.getAttribute('href'));
    return;
  }
  if (e.target.closest('[data-print-popup]')) {
    document.documentElement.classList.add('print-popup');
    window.print();
  }
});
window.addEventListener('afterprint', () => document.documentElement.classList.remove('print-popup', 'print-panel'));
document.addEventListener('click', e => {
  if (!e.target.closest('[data-print-panel]')) return;
  document.documentElement.classList.add('print-panel');
  window.print();
});

// Assignment form: choosing an employee fills Designation and Department with their current values,
// unless the user has typed their own.
document.addEventListener('change', e => {
  const select = e.target.closest('select[name="employee_id"]');
  if (!select || !select.form) return;
  const option = select.selectedOptions[0];
  for (const field of ['designation', 'department']) {
    const input = select.form.querySelector(`[data-prefill="${field}"]`);
    if (input && (!input.value || input.dataset.prefilled === '1')) {
      input.value = (option && option.dataset[field]) || '';
      input.dataset.prefilled = '1';
    }
  }
});
document.addEventListener('input', e => {
  if (e.target.matches('[data-prefill]')) e.target.dataset.prefilled = '';
});

// Filter bars marked <form data-autosubmit> apply a dropdown change straight away.
document.addEventListener('change', e => {
  const form = e.target.closest('form[data-autosubmit]');
  if (form && e.target.matches('select')) form.requestSubmit();
});

// Invoice editor: live totals from the line amounts.
const fmt = n => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function recalcInvoice() {
  const table = document.querySelector('[data-invoice-lines]');
  if (!table) return;
  let subtotal = 0;
  table.querySelectorAll('tr[data-line]').forEach(tr => {
    subtotal += Math.round((parseFloat(tr.querySelector('[data-line-amount]').value) || 0) * 100) / 100;
  });
  subtotal = Math.round(subtotal * 100) / 100;
  const r2 = n => Math.round(n * 100) / 100;
  const rate = name => parseFloat(document.querySelector(`[name="${name}"]`).value) || 0;
  const agencyValue = parseFloat(table.dataset.agencyValue) || 0;
  const agency = subtotal <= 0 ? 0
    : table.dataset.agencyType === 'Percent' ? r2(subtotal * agencyValue / 100)
      : table.dataset.agencyType === 'Fixed' ? r2(agencyValue) : 0;
  const taxable = r2(subtotal + agency);
  const cgst = r2(taxable * rate('cgst_rate') / 100);
  const sgst = r2(taxable * rate('sgst_rate') / 100);
  document.querySelector('[data-subtotal]').textContent = fmt(subtotal);
  const agencyCell = document.querySelector('[data-agency]');
  if (agencyCell) agencyCell.textContent = fmt(agency);
  document.querySelector('[data-cgst]').textContent = fmt(cgst);
  document.querySelector('[data-sgst]').textContent = fmt(sgst);
  document.querySelector('[data-total]').textContent = fmt(taxable + cgst + sgst);
}
document.addEventListener('input', recalcInvoice);
document.addEventListener('click', () => setTimeout(recalcInvoice));
document.addEventListener('DOMContentLoaded', recalcInvoice);

// Phone layout for tables: every table in a .table-wrap or .doc-scroll (except .stack-table, which has its own layout,
// and .no-stack) gets the .stack-auto class, and each body and footer cell a data-label from its column header(s),
// so the CSS can show each row as a card of "Label  value" pairs. Multi-row headers with colspan/rowspan are
// supported: a column's label joins the header texts above it (e.g. "Earnings (₹) · Basic").
function columnLabels(table) {
  const grid = [];
  (table.tHead ? [...table.tHead.rows] : []).forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const th of tr.cells) {
      while (grid[r][c] !== undefined) c++;
      const text = th.textContent.replace(/\s+/g, ' ').trim();
      for (let dr = 0; dr < th.rowSpan; dr++) {
        grid[r + dr] = grid[r + dr] || [];
        for (let dc = 0; dc < th.colSpan; dc++) grid[r + dr][c + dc] = text;
      }
      c += th.colSpan;
    }
  });
  const width = Math.max(0, ...grid.map(row => row.length));
  return Array.from({ length: width }, (_, c) => [...new Set(grid.map(row => row[c]).filter(Boolean))].join(' · '));
}
function labelTable(table) {
  if (table.matches('.stack-table, .no-stack') || !table.closest('.table-wrap, .doc-scroll')) return;
  const labels = columnLabels(table);
  if (!labels.length) return;
  table.classList.add('stack-auto');
  for (const section of [...table.tBodies, table.tFoot].filter(Boolean)) {
    for (const tr of section.rows) {
      let c = 0;
      for (const td of tr.cells) {
        // A cell spanning several columns (a group heading, a note, a "Total" caption) gets no label.
        if (td.colSpan === 1 && labels[c] && !td.hasAttribute('data-label')) td.dataset.label = labels[c];
        c += td.colSpan;
      }
    }
  }
}
// Cards on phones, and at any width when the table is wider than its container, so tables never scroll sideways.
const phone = window.matchMedia('(max-width: 820px)');
function layoutTable(table) {
  const wrap = table.closest('.table-wrap, .doc-scroll');
  if (phone.matches) return table.classList.add('cards');
  table.classList.remove('cards');
  if (!wrap.clientWidth) return; // hidden (e.g. a closed panel): measured again when shown
  if (table.offsetWidth > wrap.clientWidth + 1) table.classList.add('cards');
}
function layoutTables() {
  document.querySelectorAll('table').forEach(labelTable);
  document.querySelectorAll('table.stack-auto').forEach(layoutTable);
}
document.addEventListener('DOMContentLoaded', () => {
  layoutTables();
  // Tables added or changed later: panel and popup content, added invoice lines, pay components; and resizing.
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; layoutTables(); });
  };
  new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', queue);
});