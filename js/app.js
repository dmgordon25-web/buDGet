import { openDb, getAll, putMany, putOne, deleteOne, exportAll, importAll, clearAll } from './db.js';
import { buildDemoData } from './demoData.js';
import { uid, formatCurrency, monthRange, toYearMonth } from './utils.js';
import { expandScheduledItemsToOccurrences, calcMonthlyPlan, calcActuals, calcRemaining, calcProjectedBalance } from './engine.js';
import { parseCsv, mapCsvToTransactions } from './csv.js';
import { findMatchSuggestions, applyMatchSuggestions } from './matching.js';

const state = {
  db: null,
  page: 'dashboard',
  data: {},
};

const stores = ['accounts', 'categories', 'scheduledItems', 'scheduledOverrides', 'transactions', 'matchRules', 'scenarios', 'scenarioOverrides', 'settings', 'auditLog'];

function currentSettings() {
  return state.data.settings?.[0] || { id: 'app_settings', bufferAmount: 800, selectedMonth: toYearMonth(new Date()), selectedScenarioId: 'scn_baseline' };
}

function findCategoryName(id) {
  return state.data.categories.find((c) => c.id === id)?.name || 'Uncategorized';
}
function findAccountName(id) {
  return state.data.accounts.find((a) => a.id === id)?.name || 'Unknown';
}

async function loadAllData() {
  const result = {};
  for (const s of stores) result[s] = await getAll(state.db, s);
  state.data = result;
}

async function ensureSeed() {
  await loadAllData();
  if (!state.data.accounts.length) {
    const demo = buildDemoData();
    for (const s of stores) {
      if (demo[s]?.length) await putMany(state.db, s, demo[s]);
    }
    await loadAllData();
  }
}

function getScenarioAdjustedScheduledItems() {
  const settings = currentSettings();
  const selectedScenarioId = settings.selectedScenarioId;
  let items = [...state.data.scheduledItems];
  if (selectedScenarioId !== 'scn_baseline') {
    const overrides = state.data.scenarioOverrides.filter((o) => o.scenarioId === selectedScenarioId && o.targetType === 'scheduledItem');
    items = items.map((item) => {
      const o = overrides.find((ov) => ov.targetId === item.id);
      return o ? { ...item, ...o.overrideData } : item;
    });
  }
  return items;
}

function calculateModel() {
  const settings = currentSettings();
  const months = monthRange('2026-01', '2026-12');
  const scheduledItems = getScenarioAdjustedScheduledItems();
  const occurrences = expandScheduledItemsToOccurrences(scheduledItems, state.data.scheduledOverrides, { startYm: months[0], endYm: months[11] });
  const plan = calcMonthlyPlan(occurrences);
  const actual = calcActuals(state.data.transactions, months);
  const remaining = calcRemaining(plan, actual, settings.selectedMonth, settings.bufferAmount);

  return { months, occurrences, plan, actual, remaining };
}

function render() {
  const app = document.querySelector('#app');
  const settings = currentSettings();
  const model = calculateModel();

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <h1>Master Control Center</h1>
        <nav>${['dashboard', 'schedule', 'transactions', 'calendar', 'scenarios', 'settings'].map((p) => `<button data-nav="${p}" class="nav-btn ${state.page === p ? 'active' : ''}">${p[0].toUpperCase()}${p.slice(1)}</button>`).join('')}</nav>
      </aside>
      <main class="main">
        <header class="sticky">
          <label>Month
            <input id="monthPicker" type="month" value="${settings.selectedMonth}" />
          </label>
          <label>Scenario
            <select id="scenarioPicker">${state.data.scenarios.map((s) => `<option value="${s.id}" ${s.id === settings.selectedScenarioId ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
          </label>
          <button data-action="quick-add-tx">Add Transaction</button>
          <button data-action="quick-add-scheduled">Add Scheduled</button>
          <button data-action="quick-import">Import CSV</button>
        </header>
        <section class="content">${renderPage(state.page, model)}</section>
      </main>
    </div>`;
}

function alerts(model) {
  const settings = currentSettings();
  const monthOcc = model.occurrences.filter((o) => o.yearMonth === settings.selectedMonth && o.type === 'Expense');
  const monthTx = state.data.transactions.filter((t) => toYearMonth(t.date) === settings.selectedMonth);
  const missingBills = monthOcc.filter((o) => !monthTx.some((t) => t.matchedScheduledOccurrenceId === o.id));
  const unmatchedTx = monthTx.filter((t) => !t.matchedScheduledOccurrenceId);
  const vals = Object.values(model.plan.byMonth);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const current = model.plan.byMonth[settings.selectedMonth] || 0;
  const spike = current > avg + 500;
  return { missingBills, unmatchedTx, spike };
}

function renderDashboard(model) {
  const settings = currentSettings();
  const a = alerts(model);
  const checking = state.data.accounts.find((acc) => acc.type === 'Checking') || state.data.accounts[0];
  const today = `${settings.selectedMonth}-01`;
  const end = `${settings.selectedMonth}-28`;
  const paydays = model.occurrences.filter((o) => o.type === 'Income' && o.accountId === checking.id);
  const occ = model.occurrences.filter((o) => o.type !== 'Income' && o.accountId === checking.id);
  const known = state.data.transactions.filter((t) => t.accountId === checking.id);
  const timeline = calcProjectedBalance(checking.startingBalance || 0, occ, paydays, known, { start: today, end });

  return `
    <div class="cards">
      <article><h3>Planned Total</h3><p>${formatCurrency(model.remaining.planned)}</p></article>
      <article><h3>Actual Spent</h3><p>${formatCurrency(model.remaining.spent)}</p></article>
      <article><h3>Remaining</h3><p>${formatCurrency(model.remaining.remaining)}</p></article>
      <article><h3>Disposable After Buffer</h3><p>${formatCurrency(model.remaining.disposableAfterBuffer)}</p></article>
    </div>
    <div class="panel">
      <h3>Upcoming 14 Days (Projected Balance)</h3>
      <ul>${timeline.slice(0, 14).map((t) => `<li>${t.date} • ${t.label} • ${formatCurrency(t.amount)} • Bal: ${formatCurrency(t.runningBalance)}</li>`).join('')}</ul>
    </div>
    <div class="panel recon">
      <h3>Reconciliation Inbox</h3>
      <p>Unmatched: ${state.data.transactions.filter((t) => t.status !== 'Matched').length}</p>
      <p>Needs Review: ${state.data.transactions.filter((t) => t.status === 'Needs Review').length}</p>
      <button data-action="auto-match">Run Auto-Match</button>
    </div>
    <div class="panel alerts"><h3>Alerts</h3>
      <p>Planned bill not seen: ${a.missingBills.length}</p>
      <p>Transaction with no planned item: ${a.unmatchedTx.length}</p>
      <p>Spike month coming: ${a.spike ? 'Yes' : 'No'}</p>
    </div>`;
}

function renderSchedule(model) {
  const lines = state.data.scheduledItems.map((item) => {
    const cells = model.months.map((m) => {
      const found = model.occurrences.find((o) => o.scheduledItemId === item.id && o.yearMonth === m);
      return `<td data-action="edit-override" data-id="${item.id}" data-month="${m}">${found ? found.amount : '-'}</td>`;
    }).join('');
    const annual = model.months.reduce((sum, m) => sum + (model.occurrences.find((o) => o.scheduledItemId === item.id && o.yearMonth === m)?.amount || 0), 0);
    return `<tr><td>${item.name}</td><td>${item.type}</td><td>${findCategoryName(item.categoryId)}</td><td>${findAccountName(item.accountId)}</td>${cells}<td>${annual}</td><td><button data-action="delete-scheduled" data-id="${item.id}">Delete</button></td></tr>`;
  }).join('');

  const totals = model.months.map((m) => `<td>${model.plan.byMonth[m] || 0}</td>`).join('');

  return `<div class="panel"><h3>Planned Items</h3>
    ${scheduledForm()}
    <table><thead><tr><th>Name</th><th>Type</th><th>Category</th><th>Account</th>${model.months.map((m) => `<th>${m.slice(5)}</th>`).join('')}<th>Annual</th><th>Actions</th></tr></thead>
    <tbody>${lines}<tr class="total"><td colspan="4">Month Totals</td>${totals}<td>${model.plan.annualTotal}</td><td></td></tr></tbody></table></div>`;
}

function scheduledForm() {
  return `<form id="scheduledForm" class="grid-form">
    <input name="name" placeholder="Name" required />
    <select name="type"><option>Expense</option><option>Income</option><option>Transfer</option><option>Sinking Fund Contribution</option></select>
    <select name="categoryId">${state.data.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
    <select name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select>
    <input type="number" step="0.01" name="amount" placeholder="Amount" required />
    <select name="recurrence"><option value="monthly">monthly</option><option value="annual">annual</option><option value="custom">custom</option></select>
    <input type="number" name="dueDay" placeholder="Due Day" min="1" max="28" />
    <input type="number" name="dueMonth" placeholder="Due Month" min="1" max="12" />
    <input name="customMonths" placeholder="Custom months 1,3,8" />
    <input name="notes" placeholder="Notes" />
    <button>Add</button>
  </form>`;
}

function renderTransactions() {
  const rows = state.data.transactions.map((t) => `<tr>
    <td>${t.date}</td><td>${t.description}</td><td>${formatCurrency(t.amount)}</td><td>${findAccountName(t.accountId)}</td>
    <td>${findCategoryName(t.categoryId)}</td><td>${t.status || 'Unmatched'}</td>
    <td><button data-action="split-tx" data-id="${t.id}">Split</button></td>
  </tr>`).join('');

  return `<div class="panel"><h3>Transactions</h3>
    ${transactionForm()}
    <form id="csvForm" class="grid-form"><input type="file" id="csvFile" accept=".csv" required />
      <select name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select>
      <input name="dateIdx" type="number" placeholder="Date col idx" required />
      <input name="descIdx" type="number" placeholder="Desc col idx" required />
      <input name="amountIdx" type="number" placeholder="Amount idx (or blank)" />
      <input name="debitIdx" type="number" placeholder="Debit idx" />
      <input name="creditIdx" type="number" placeholder="Credit idx" />
      <label><input name="idempotent" type="checkbox" checked />Idempotent</label>
      <button>Import CSV</button></form>
    <table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Account</th><th>Category</th><th>Status</th><th>Tools</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function transactionForm() {
  return `<form id="txForm" class="grid-form">
    <input type="date" name="date" required />
    <input name="description" placeholder="Description" required />
    <input type="number" step="0.01" name="amount" placeholder="Amount" required />
    <select name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select>
    <select name="categoryId"><option value="">Uncategorized</option>${state.data.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
    <button>Add Transaction</button>
  </form>`;
}

function renderCalendar(model) {
  const checking = state.data.accounts.find((a) => a.type === 'Checking') || state.data.accounts[0];
  const settings = currentSettings();
  const ym = settings.selectedMonth;
  const occ = model.occurrences.filter((o) => o.yearMonth === ym && o.accountId === checking.id);
  const pay = occ.filter((o) => o.type === 'Income');
  const nonPay = occ.filter((o) => o.type !== 'Income');
  const tx = state.data.transactions.filter((t) => toYearMonth(t.date) === ym && t.accountId === checking.id);
  const timeline = calcProjectedBalance(checking.startingBalance || 0, nonPay, pay, tx, { start: `${ym}-01`, end: `${ym}-28` });

  return `<div class="panel"><h3>Cashflow Timeline (${checking.name})</h3>
    <table><thead><tr><th>Date</th><th>Type</th><th>Label</th><th>Amount</th><th>Running Balance</th></tr></thead>
      <tbody>${timeline.map((e) => `<tr><td>${e.date}</td><td>${e.kind}</td><td>${e.label}</td><td>${formatCurrency(e.amount)}</td><td>${formatCurrency(e.runningBalance)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderScenarios(model) {
  const baselineId = 'scn_baseline';
  const baselineItems = state.data.scheduledItems;
  const baseOcc = expandScheduledItemsToOccurrences(baselineItems, state.data.scheduledOverrides, { startYm: '2026-01', endYm: '2026-12' });
  const basePlan = calcMonthlyPlan(baseOcc);

  const selectedScenario = currentSettings().selectedScenarioId;
  const compare = selectedScenario === baselineId ? model.plan : calcMonthlyPlan(expandScheduledItemsToOccurrences(getScenarioAdjustedScheduledItems(), state.data.scheduledOverrides, { startYm: '2026-01', endYm: '2026-12' }));

  return `<div class="panel"><h3>Scenarios</h3>
    <form id="scenarioForm" class="grid-form"><input name="name" placeholder="Scenario name" required /><button>Create Scenario from Baseline</button></form>
    <table><thead><tr><th>Month</th><th>Baseline</th><th>Selected Scenario</th><th>Delta</th></tr></thead><tbody>
      ${model.months.map((m) => {
        const b = basePlan.byMonth[m] || 0;
        const s = compare.byMonth[m] || 0;
        return `<tr><td>${m}</td><td>${formatCurrency(b)}</td><td>${formatCurrency(s)}</td><td>${formatCurrency(s - b)}</td></tr>`;
      }).join('')}
      <tr class="total"><td>Year Total</td><td>${formatCurrency(basePlan.annualTotal)}</td><td>${formatCurrency(compare.annualTotal)}</td><td>${formatCurrency(compare.annualTotal - basePlan.annualTotal)}</td></tr>
    </tbody></table>
  </div>`;
}

function renderSettings() {
  const settings = currentSettings();
  return `<div class="panel"><h3>Settings / Data</h3>
    <form id="bufferForm" class="grid-form"><input type="number" step="1" name="bufferAmount" value="${settings.bufferAmount}" /><button>Save Buffer</button></form>
    <div class="buttons">
      <button data-action="export-json">Export JSON</button>
      <input type="file" id="importJsonFile" accept="application/json" />
      <button data-action="import-json">Import JSON</button>
      <button data-action="reset-demo">Reset Demo Data</button>
    </div>
    ${accountsCategoriesForms()}
  </div>`;
}

function accountsCategoriesForms() {
  return `<div class="split">
    <form id="accountForm" class="grid-form"><h4>Accounts</h4><input name="name" placeholder="Account name" required /><select name="type"><option>Checking</option><option>Savings</option><option>Cash</option><option>Credit Card</option></select><input name="startingBalance" type="number" placeholder="Starting Balance" value="0" /><button>Add Account</button></form>
    <form id="categoryForm" class="grid-form"><h4>Categories</h4><input name="name" placeholder="Category name" required /><button>Add Category</button></form>
    <ul>${state.data.accounts.map((a) => `<li>${a.name} (${a.type})</li>`).join('')}</ul>
    <ul>${state.data.categories.map((c) => `<li>${c.name}</li>`).join('')}</ul>
  </div>`;
}

function renderPage(page, model) {
  if (page === 'dashboard') return renderDashboard(model);
  if (page === 'schedule') return renderSchedule(model);
  if (page === 'transactions') return renderTransactions();
  if (page === 'calendar') return renderCalendar(model);
  if (page === 'scenarios') return renderScenarios(model);
  return renderSettings();
}

async function saveSettings(next) {
  const merged = { ...currentSettings(), ...next };
  await putOne(state.db, 'settings', merged);
  await loadAllData();
}

async function onClick(e) {
  const target = e.target.closest('[data-action],[data-nav]');
  if (!target) return;

  if (target.dataset.nav) {
    state.page = target.dataset.nav;
    render();
    return;
  }

  if (target.dataset.action === 'delete-scheduled') {
    await deleteOne(state.db, 'scheduledItems', target.dataset.id);
    await loadAllData();
    render();
    return;
  }

  if (target.dataset.action === 'edit-override') {
    const amount = window.prompt('Override amount for this month (blank to cancel):');
    if (amount === null || amount === '') return;
    await putOne(state.db, 'scheduledOverrides', { id: uid('ovr'), scheduledItemId: target.dataset.id, yearMonth: target.dataset.month, amountOverride: Number(amount) });
    await loadAllData();
    render();
    return;
  }

  if (target.dataset.action === 'auto-match') {
    const model = calculateModel();
    const suggestions = findMatchSuggestions(state.data.transactions, model.occurrences, state.data.matchRules);
    const next = applyMatchSuggestions(state.data.transactions, suggestions);
    await putMany(state.db, 'transactions', next);
    await loadAllData();
    render();
    return;
  }

  if (target.dataset.action === 'split-tx') {
    const tx = state.data.transactions.find((t) => t.id === target.dataset.id);
    const amount = Number(window.prompt('Enter first split amount (negative for expense):', String(tx.amount / 2)));
    if (!Number.isFinite(amount)) return;
    const second = tx.amount - amount;
    await deleteOne(state.db, 'transactions', tx.id);
    await putMany(state.db, 'transactions', [{ ...tx, id: uid('tx'), amount }, { ...tx, id: uid('tx'), amount: second, notes: 'Split transaction' }]);
    await loadAllData();
    render();
    return;
  }

  if (target.dataset.action === 'export-json') {
    const payload = await exportAll(state.db);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'budget-export.json';
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  if (target.dataset.action === 'import-json') {
    const file = document.querySelector('#importJsonFile').files[0];
    if (!file) return;
    const text = await file.text();
    await importAll(state.db, JSON.parse(text));
    await loadAllData();
    render();
    return;
  }

  if (target.dataset.action === 'reset-demo') {
    await clearAll(state.db);
    const demo = buildDemoData();
    for (const s of stores) {
      if (demo[s]?.length) await putMany(state.db, s, demo[s]);
    }
    await loadAllData();
    render();
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const id = e.target.id;

  if (id === 'scheduledForm') {
    const fd = new FormData(e.target);
    await putOne(state.db, 'scheduledItems', {
      id: uid('sch'),
      name: fd.get('name'),
      type: fd.get('type'),
      categoryId: fd.get('categoryId'),
      accountId: fd.get('accountId'),
      amount: Number(fd.get('amount')),
      recurrence: fd.get('recurrence'),
      dueDay: Number(fd.get('dueDay')) || null,
      dueMonth: Number(fd.get('dueMonth')) || null,
      customMonths: String(fd.get('customMonths') || '').split(',').map((v) => Number(v.trim())).filter(Boolean),
      notes: fd.get('notes') || '',
    });
  }

  if (id === 'txForm') {
    const fd = new FormData(e.target);
    await putOne(state.db, 'transactions', {
      id: uid('tx'),
      date: fd.get('date'),
      description: fd.get('description'),
      amount: Number(fd.get('amount')),
      accountId: fd.get('accountId'),
      categoryId: fd.get('categoryId') || null,
      status: 'Unmatched',
      notes: '',
    });
  }

  if (id === 'csvForm') {
    const fd = new FormData(e.target);
    const file = document.querySelector('#csvFile').files[0];
    if (file) {
      const rows = parseCsv(await file.text());
      const mapper = {
        date: Number(fd.get('dateIdx')),
        description: Number(fd.get('descIdx')),
        amount: fd.get('amountIdx') !== '' ? Number(fd.get('amountIdx')) : null,
        debit: fd.get('debitIdx') !== '' ? Number(fd.get('debitIdx')) : null,
        credit: fd.get('creditIdx') !== '' ? Number(fd.get('creditIdx')) : null,
        idempotent: fd.get('idempotent') === 'on',
      };
      const newTx = mapCsvToTransactions(rows, mapper, fd.get('accountId'), state.data.transactions);
      if (newTx.length) await putMany(state.db, 'transactions', newTx);
    }
  }

  if (id === 'scenarioForm') {
    const fd = new FormData(e.target);
    await putOne(state.db, 'scenarios', { id: uid('scn'), name: fd.get('name'), baseScenarioId: 'scn_baseline', createdAt: new Date().toISOString() });
  }

  if (id === 'bufferForm') {
    const fd = new FormData(e.target);
    await saveSettings({ bufferAmount: Number(fd.get('bufferAmount')) || 800 });
  }

  if (id === 'accountForm') {
    const fd = new FormData(e.target);
    await putOne(state.db, 'accounts', { id: uid('acct'), name: fd.get('name'), type: fd.get('type'), startingBalance: Number(fd.get('startingBalance')) || 0 });
  }

  if (id === 'categoryForm') {
    const fd = new FormData(e.target);
    await putOne(state.db, 'categories', { id: uid('cat'), name: fd.get('name') });
  }

  await loadAllData();
  render();
}

async function onChange(e) {
  if (e.target.id === 'monthPicker') {
    await saveSettings({ selectedMonth: e.target.value });
    render();
  }
  if (e.target.id === 'scenarioPicker') {
    await saveSettings({ selectedScenarioId: e.target.value });
    render();
  }
}

async function init() {
  state.db = await openDb();
  await ensureSeed();

  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);

  render();
}

init();
