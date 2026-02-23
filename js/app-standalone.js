(function () {
  function uid(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  function toYearMonth(dateInput) {
    const d = new Date(dateInput);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    return `${y}-${m}`;
  }

  function parseYearMonth(yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    return { year, month };
  }

  function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
  }

  function normalizeDescription(value) {
    return (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function monthRange(startYm, endYm) {
    const out = [];
    let start = parseYearMonth(startYm);
    const end = parseYearMonth(endYm);
    while (start.year < end.year || (start.year === end.year && start.month <= end.month)) {
      out.push(`${start.year}-${`${start.month}`.padStart(2, '0')}`);
      start.month += 1;
      if (start.month > 12) {
        start.month = 1;
        start.year += 1;
      }
    }
    return out;
  }

  function sortByDate(items, key) {
    return [...items].sort((a, b) => new Date(a[key || 'date']) - new Date(b[key || 'date']));
  }

  const DB_NAME = 'master-control-center-budget';
  const DB_VERSION = 1;
  const STORES = [
    'accounts',
    'categories',
    'scheduledItems',
    'scheduledOverrides',
    'transactions',
    'matchRules',
    'scenarios',
    'scenarioOverrides',
    'settings',
    'auditLog',
  ];

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function getAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function putMany(db, storeName, items) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    items.forEach((i) => store.put(i));
    await txPromise(tx);
  }

  async function putOne(db, storeName, item) {
    await putMany(db, storeName, [item]);
  }

  async function deleteOne(db, storeName, id) {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    await txPromise(tx);
  }

  async function clearAll(db) {
    for (const storeName of STORES) {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      await txPromise(tx);
    }
  }

  async function exportAll(db) {
    const data = {};
    for (const storeName of STORES) data[storeName] = await getAll(db, storeName);
    return { exportedAt: new Date().toISOString(), data };
  }

  async function importAll(db, payload) {
    await clearAll(db);
    for (const storeName of STORES) {
      const items = payload?.data?.[storeName] || [];
      if (items.length) await putMany(db, storeName, items);
    }
  }

  function getOverrideMap(overrides) {
    const map = new Map();
    (overrides || []).forEach((ov) => map.set(`${ov.scheduledItemId}:${ov.yearMonth}`, ov.amountOverride));
    return map;
  }

  function buildDate(yearMonth, dueDay, explicitDate) {
    if (explicitDate) return explicitDate;
    const ym = parseYearMonth(yearMonth);
    const day = Math.max(1, Math.min(28, Number(dueDay) || 1));
    return `${ym.year}-${`${ym.month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`;
  }

  function expandScheduledItemsToOccurrences(items, overrides, range) {
    const months = monthRange(range.startYm, range.endYm);
    const overrideMap = getOverrideMap(overrides);
    const occurrences = [];
    for (const item of items) {
      for (const ym of months) {
        const p = parseYearMonth(ym);
        let include = false;
        if (item.recurrence === 'monthly') include = true;
        if (item.recurrence === 'annual' && Number(item.dueMonth) === p.month) include = true;
        if (item.recurrence === 'custom' && Array.isArray(item.customMonths) && item.customMonths.includes(p.month)) include = true;
        if (!include) continue;
        const amount = Number(overrideMap.get(`${item.id}:${ym}`) ?? item.amount ?? 0);
        occurrences.push({
          id: `${item.id}:${ym}`,
          scheduledItemId: item.id,
          yearMonth: ym,
          date: buildDate(ym, item.dueDay, item.recurrence === 'annual' ? item.dueDate : null),
          name: item.name,
          type: item.type,
          categoryId: item.categoryId,
          accountId: item.accountId,
          amount,
        });
      }
    }
    return sortByDate(occurrences, 'date');
  }

  function calcMonthlyPlan(occurrences) {
    const byMonth = {};
    const byLine = {};
    for (const occ of occurrences) {
      byMonth[occ.yearMonth] = (byMonth[occ.yearMonth] || 0) + occ.amount;
      byLine[`${occ.scheduledItemId}:${occ.yearMonth}`] = occ.amount;
    }
    const annualTotal = Object.values(byMonth).reduce((sum, v) => sum + v, 0);
    return { byMonth, byLine, annualTotal };
  }

  function calcActuals(transactions, monthRangeFilter) {
    const byMonth = {};
    const byCategory = {};
    const byAccount = {};
    for (const tx of transactions) {
      const ym = toYearMonth(tx.date);
      if (monthRangeFilter && !monthRangeFilter.includes(ym)) continue;
      byMonth[ym] = (byMonth[ym] || 0) + tx.amount;
      byCategory[tx.categoryId || 'uncategorized'] = (byCategory[tx.categoryId || 'uncategorized'] || 0) + tx.amount;
      byAccount[tx.accountId] = (byAccount[tx.accountId] || 0) + tx.amount;
    }
    return { byMonth, byCategory, byAccount };
  }

  function calcRemaining(plan, actual, month, buffer) {
    const planned = plan.byMonth[month] || 0;
    const spent = actual.byMonth[month] || 0;
    const remaining = planned - spent;
    return { planned, spent, remaining, disposableAfterBuffer: remaining - (buffer || 800) };
  }

  function calcProjectedBalance(startBalance, occurrences, paydays, knownTransactions, dateRange) {
    const rows = [];
    occurrences.forEach((o) => {
      if (o.date >= dateRange.start && o.date <= dateRange.end) rows.push({ date: o.date, amount: -Math.abs(o.amount), kind: 'planned', label: o.name });
    });
    paydays.forEach((p) => {
      if (p.date >= dateRange.start && p.date <= dateRange.end) rows.push({ date: p.date, amount: Math.abs(p.amount), kind: 'payday', label: p.name || 'Payday' });
    });
    knownTransactions.forEach((tx) => {
      if (tx.date >= dateRange.start && tx.date <= dateRange.end) rows.push({ date: tx.date, amount: tx.amount, kind: 'actual', label: tx.description });
    });

    rows.sort((a, b) => {
      if (a.date === b.date) return a.kind.localeCompare(b.kind);
      return new Date(a.date) - new Date(b.date);
    });

    let running = startBalance;
    return rows.map((r) => {
      running += r.amount;
      return { ...r, runningBalance: running };
    });
  }

  function findMatchSuggestions(transactions, occurrences, rules) {
    const suggestions = [];
    for (const tx of transactions) {
      const desc = normalizeDescription(tx.description);
      const candidateRules = (rules || []).filter((r) => {
        if (r.accountId && r.accountId !== tx.accountId) return false;
        if (!r.pattern) return true;
        const pattern = r.isRegex ? new RegExp(r.pattern, 'i') : null;
        return pattern ? pattern.test(desc) : desc.includes(normalizeDescription(r.pattern));
      });

      const candidates = occurrences.filter((occ) => {
        const tolerance = Number(candidateRules[0]?.amountTolerance ?? 2);
        const dateWindow = Number(candidateRules[0]?.dateWindowDays ?? 5);
        const diff = Math.abs(Math.abs(occ.amount) - Math.abs(tx.amount));
        const dayDiff = Math.abs((new Date(occ.date) - new Date(tx.date)) / (1000 * 60 * 60 * 24));
        return occ.accountId === tx.accountId && diff <= tolerance && dayDiff <= dateWindow;
      });

      if (candidates.length) suggestions.push({ txId: tx.id, occurrenceId: candidates[0].id, confidence: 0.9, status: 'Matched' });
      else suggestions.push({ txId: tx.id, occurrenceId: null, confidence: 0, status: 'Needs Review' });
    }
    return suggestions;
  }

  function applyMatchSuggestions(transactions, suggestions) {
    const map = new Map(suggestions.map((s) => [s.txId, s]));
    return transactions.map((tx) => {
      const s = map.get(tx.id);
      if (!s || !s.occurrenceId) return { ...tx, status: tx.status || 'Unmatched' };
      return { ...tx, status: 'Matched', matchedScheduledOccurrenceId: s.occurrenceId };
    });
  }

  function parseCsv(text) {
    const rows = [];
    let current = '';
    let row = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"') {
        if (inQuotes && text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = !inQuotes;
        continue;
      }
      if (c === ',' && !inQuotes) {
        row.push(current);
        current = '';
        continue;
      }
      if ((c === '\n' || c === '\r') && !inQuotes) {
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        if (current.length || row.length) {
          row.push(current);
          rows.push(row);
        }
        current = '';
        row = [];
        continue;
      }
      current += c;
    }
    if (current.length || row.length) {
      row.push(current);
      rows.push(row);
    }
    return rows;
  }

  function parseCsvDate(input) {
    if (!input) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    const mdy = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    return null;
  }

  function hashTx(tx) {
    return `${tx.date}|${tx.amount.toFixed(2)}|${tx.description.trim().toLowerCase()}|${tx.accountId}`;
  }

  function mapCsvToTransactions(rows, mapper, accountId, existingTransactions) {
    const data = rows.slice(1);
    if (!rows.length || !data.length) return [];
    const seen = new Set((existingTransactions || []).map(hashTx));
    const created = [];

    data.forEach((r) => {
      const date = parseCsvDate(r[mapper.date]);
      if (!date) return;
      const description = r[mapper.description] || 'Imported Transaction';
      let amount = 0;
      if (mapper.amount != null) {
        amount = Number((r[mapper.amount] || '0').replace(/[$,]/g, ''));
      } else {
        const debit = Number((r[mapper.debit] || '0').replace(/[$,]/g, ''));
        const credit = Number((r[mapper.credit] || '0').replace(/[$,]/g, ''));
        amount = credit - debit;
      }
      const tx = { id: uid('tx'), date, description, amount, accountId, categoryId: null, status: 'Unmatched', notes: '' };
      const key = hashTx(tx);
      if (mapper.idempotent && seen.has(key)) return;
      seen.add(key);
      created.push(tx);
    });

    return created;
  }

  function buildDemoData() {
    const checking = { id: 'acct_checking', name: 'Checking', type: 'Checking', startingBalance: 3200 };
    const savings = { id: 'acct_savings', name: 'Savings', type: 'Savings', startingBalance: 12000 };
    const cash = { id: 'acct_cash', name: 'Cash', type: 'Cash', startingBalance: 200 };
    const capOne = { id: 'acct_capone', name: 'Cap One Card', type: 'Credit Card', startingBalance: -400 };
    const categories = ['Child', 'Housing', 'Auto', 'Subscriptions', 'Food', 'Dog', 'Medical', 'Fun', 'Annual/One-offs', 'Income', 'Transfers']
      .map((name) => ({ id: `cat_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name }));
    const cat = (name) => categories.find((c) => c.name === name).id;

    return {
      accounts: [checking, savings, cash, capOne],
      categories,
      scheduledItems: [
        { id: 'sch_child_support', name: 'Child Support', type: 'Expense', categoryId: cat('Child'), accountId: checking.id, amount: 600, recurrence: 'monthly', dueDay: 1, notes: '' },
        { id: 'sch_rent', name: 'Rent', type: 'Expense', categoryId: cat('Housing'), accountId: checking.id, amount: 1450, recurrence: 'monthly', dueDay: 1, notes: '' },
        { id: 'sch_car_payment', name: 'Car Payment', type: 'Expense', categoryId: cat('Auto'), accountId: checking.id, amount: 453, recurrence: 'monthly', dueDay: 12, notes: '' },
        { id: 'sch_groceries', name: 'Groceries', type: 'Expense', categoryId: cat('Food'), accountId: checking.id, amount: 950, recurrence: 'monthly', dueDay: 5, notes: '' },
        { id: 'sch_paycheck_1', name: 'Paycheck A', type: 'Income', categoryId: cat('Income'), accountId: checking.id, amount: 2390, recurrence: 'monthly', dueDay: 1, notes: '' },
        { id: 'sch_paycheck_2', name: 'Paycheck B', type: 'Income', categoryId: cat('Income'), accountId: checking.id, amount: 2390, recurrence: 'monthly', dueDay: 15, notes: '' },
        { id: 'sch_prime', name: 'Amazon Prime', type: 'Expense', categoryId: cat('Annual/One-offs'), accountId: capOne.id, amount: 139, recurrence: 'annual', dueMonth: 3, dueDate: '2026-03-13', notes: '' },
        { id: 'sch_car_tax', name: 'Car Tax', type: 'Expense', categoryId: cat('Annual/One-offs'), accountId: checking.id, amount: 1325, recurrence: 'annual', dueMonth: 4, dueDate: '2026-04-10', notes: '' },
        { id: 'sch_holiday_trip', name: 'Holiday Trip', type: 'Expense', categoryId: cat('Fun'), accountId: checking.id, amount: 2800, recurrence: 'annual', dueMonth: 11, dueDate: '2026-11-05', notes: 'Spike month item' },
        { id: 'sch_vet_sinking', name: 'Vet Sinking Fund', type: 'Sinking Fund Contribution', categoryId: cat('Dog'), accountId: savings.id, amount: 100, recurrence: 'monthly', dueDay: 25, notes: '' },
      ],
      scheduledOverrides: [
        { id: uid('ovr'), scheduledItemId: 'sch_groceries', yearMonth: '2026-05', amountOverride: 1150 },
        { id: uid('ovr'), scheduledItemId: 'sch_groceries', yearMonth: '2026-11', amountOverride: 1100 },
      ],
      transactions: [
        { id: uid('tx'), date: '2026-05-01', description: 'Payroll Deposit', amount: 2390, accountId: checking.id, categoryId: cat('Income'), status: 'Matched' },
        { id: uid('tx'), date: '2026-05-01', description: 'Monthly Rent', amount: -1450, accountId: checking.id, categoryId: cat('Housing'), status: 'Matched' },
        { id: uid('tx'), date: '2026-05-03', description: 'Walmart Grocery', amount: -260, accountId: checking.id, categoryId: cat('Food'), status: 'Unmatched' },
        { id: uid('tx'), date: '2026-05-12', description: 'Car Loan Payment', amount: -453, accountId: checking.id, categoryId: cat('Auto'), status: 'Matched' },
        { id: uid('tx'), date: '2026-05-15', description: 'Payroll Deposit', amount: 2390, accountId: checking.id, categoryId: cat('Income'), status: 'Matched' },
        { id: uid('tx'), date: '2026-05-17', description: 'Amazon Purchase', amount: -42.13, accountId: capOne.id, categoryId: null, status: 'Needs Review' },
      ],
      matchRules: [
        { id: uid('rule'), pattern: 'payroll', categoryId: cat('Income'), accountId: checking.id, amountTolerance: 2, dateWindowDays: 3 },
        { id: uid('rule'), pattern: 'rent', categoryId: cat('Housing'), accountId: checking.id, amountTolerance: 3, dateWindowDays: 5 },
      ],
      scenarios: [
        { id: 'scn_baseline', name: 'Baseline', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'scn_future_move', name: 'Future Move', baseScenarioId: 'scn_baseline', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      scenarioOverrides: [
        { id: uid('sovr'), scenarioId: 'scn_future_move', targetType: 'scheduledItem', targetId: 'sch_rent', yearMonth: null, overrideData: { amount: 1750 } },
        { id: uid('sovr'), scenarioId: 'scn_future_move', targetType: 'scheduledItem', targetId: 'sch_paycheck_1', yearMonth: null, overrideData: { amount: 2500 } },
      ],
      settings: [{ id: 'app_settings', bufferAmount: 800, selectedMonth: '2026-05', selectedScenarioId: 'scn_baseline' }],
      auditLog: [],
    };
  }

  const state = { db: null, page: 'dashboard', data: {} };

  function currentSettings() {
    return state.data.settings && state.data.settings[0] ? state.data.settings[0] : { id: 'app_settings', bufferAmount: 800, selectedMonth: toYearMonth(new Date()), selectedScenarioId: 'scn_baseline' };
  }

  function findCategoryName(id) {
    const found = state.data.categories.find((c) => c.id === id);
    return found ? found.name : 'Uncategorized';
  }

  function findAccountName(id) {
    const found = state.data.accounts.find((a) => a.id === id);
    return found ? found.name : 'Unknown';
  }

  async function loadAllData() {
    const result = {};
    for (const s of STORES) result[s] = await getAll(state.db, s);
    state.data = result;
  }

  async function ensureSeed() {
    await loadAllData();
    if (!state.data.accounts.length) {
      const demo = buildDemoData();
      for (const s of STORES) {
        if (demo[s] && demo[s].length) await putMany(state.db, s, demo[s]);
      }
      await loadAllData();
    }
  }

  function getScenarioAdjustedScheduledItems() {
    const selectedScenarioId = currentSettings().selectedScenarioId;
    let items = [...state.data.scheduledItems];
    if (selectedScenarioId !== 'scn_baseline') {
      const overrides = state.data.scenarioOverrides.filter((o) => o.scenarioId === selectedScenarioId && o.targetType === 'scheduledItem');
      items = items.map((item) => {
        const found = overrides.find((ov) => ov.targetId === item.id);
        return found ? { ...item, ...found.overrideData } : item;
      });
    }
    return items;
  }

  function calculateModel() {
    const settings = currentSettings();
    const months = monthRange('2026-01', '2026-12');
    const occurrences = expandScheduledItemsToOccurrences(getScenarioAdjustedScheduledItems(), state.data.scheduledOverrides, { startYm: months[0], endYm: months[11] });
    const plan = calcMonthlyPlan(occurrences);
    const actual = calcActuals(state.data.transactions, months);
    const remaining = calcRemaining(plan, actual, settings.selectedMonth, settings.bufferAmount);
    return { months, occurrences, plan, actual, remaining };
  }

  function renderPage(page, model) {
    if (page === 'dashboard') return renderDashboard(model);
    if (page === 'schedule') return renderSchedule(model);
    if (page === 'transactions') return renderTransactions();
    if (page === 'calendar') return renderCalendar(model);
    if (page === 'scenarios') return renderScenarios(model);
    return renderSettings();
  }

  function render() {
    const app = document.querySelector('#app');
    if (!app) return;
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
            <label>Month<input id="monthPicker" type="month" value="${settings.selectedMonth}" /></label>
            <label>Scenario<select id="scenarioPicker">${state.data.scenarios.map((s) => `<option value="${s.id}" ${s.id === settings.selectedScenarioId ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
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
    return { missingBills, unmatchedTx, spike: current > avg + 500 };
  }

  function renderDashboard(model) {
    const settings = currentSettings();
    const a = alerts(model);
    const checking = state.data.accounts.find((acc) => acc.type === 'Checking') || state.data.accounts[0];
    const paydays = model.occurrences.filter((o) => o.type === 'Income' && o.accountId === checking.id);
    const occ = model.occurrences.filter((o) => o.type !== 'Income' && o.accountId === checking.id);
    const known = state.data.transactions.filter((t) => t.accountId === checking.id);
    const timeline = calcProjectedBalance(checking.startingBalance || 0, occ, paydays, known, { start: `${settings.selectedMonth}-01`, end: `${settings.selectedMonth}-28` });

    return `
      <div class="cards">
        <article><h3>Planned Total</h3><p>${formatCurrency(model.remaining.planned)}</p></article>
        <article><h3>Actual Spent</h3><p>${formatCurrency(model.remaining.spent)}</p></article>
        <article><h3>Remaining</h3><p>${formatCurrency(model.remaining.remaining)}</p></article>
        <article><h3>Disposable After Buffer</h3><p>${formatCurrency(model.remaining.disposableAfterBuffer)}</p></article>
      </div>
      <div class="panel"><h3>Upcoming 14 Days (Projected Balance)</h3><ul>${timeline.slice(0, 14).map((t) => `<li>${t.date} • ${t.label} • ${formatCurrency(t.amount)} • Bal: ${formatCurrency(t.runningBalance)}</li>`).join('')}</ul></div>
      <div class="panel recon"><h3>Reconciliation Inbox</h3><p>Unmatched: ${state.data.transactions.filter((t) => t.status !== 'Matched').length}</p><p>Needs Review: ${state.data.transactions.filter((t) => t.status === 'Needs Review').length}</p><button data-action="auto-match">Run Auto-Match</button></div>
      <div class="panel alerts"><h3>Alerts</h3><p>Planned bill not seen: ${a.missingBills.length}</p><p>Transaction with no planned item: ${a.unmatchedTx.length}</p><p>Spike month coming: ${a.spike ? 'Yes' : 'No'}</p></div>`;
  }

  function scheduledForm() {
    return `<form id="scheduledForm" class="grid-form"><input name="name" placeholder="Name" required /><select name="type"><option>Expense</option><option>Income</option><option>Transfer</option><option>Sinking Fund Contribution</option></select><select name="categoryId">${state.data.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select><select name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select><input type="number" step="0.01" name="amount" placeholder="Amount" required /><select name="recurrence"><option value="monthly">monthly</option><option value="annual">annual</option><option value="custom">custom</option></select><input type="number" name="dueDay" placeholder="Due Day" min="1" max="28" /><input type="number" name="dueMonth" placeholder="Due Month" min="1" max="12" /><input name="customMonths" placeholder="Custom months 1,3,8" /><input name="notes" placeholder="Notes" /><button>Add</button></form>`;
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
    return `<div class="panel"><h3>Planned Items</h3>${scheduledForm()}<table><thead><tr><th>Name</th><th>Type</th><th>Category</th><th>Account</th>${model.months.map((m) => `<th>${m.slice(5)}</th>`).join('')}<th>Annual</th><th>Actions</th></tr></thead><tbody>${lines}<tr class="total"><td colspan="4">Month Totals</td>${totals}<td>${model.plan.annualTotal}</td><td></td></tr></tbody></table></div>`;
  }

  function transactionForm() {
    return `<form id="txForm" class="grid-form"><input type="date" name="date" required /><input name="description" placeholder="Description" required /><input type="number" step="0.01" name="amount" placeholder="Amount" required /><select name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select><select name="categoryId"><option value="">Uncategorized</option>${state.data.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select><button>Add Transaction</button></form>`;
  }

  function renderTransactions() {
    const rows = state.data.transactions.map((t) => `<tr><td>${t.date}</td><td>${t.description}</td><td>${formatCurrency(t.amount)}</td><td>${findAccountName(t.accountId)}</td><td>${findCategoryName(t.categoryId)}</td><td>${t.status || 'Unmatched'}</td><td><button data-action="split-tx" data-id="${t.id}">Split</button></td></tr>`).join('');
    return `<div class="panel"><h3>Transactions</h3>${transactionForm()}<form id="csvForm" class="grid-form"><input type="file" id="csvFile" accept=".csv" required /><select name="accountId">${state.data.accounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select><input name="dateIdx" type="number" placeholder="Date col idx" required /><input name="descIdx" type="number" placeholder="Desc col idx" required /><input name="amountIdx" type="number" placeholder="Amount idx (or blank)" /><input name="debitIdx" type="number" placeholder="Debit idx" /><input name="creditIdx" type="number" placeholder="Credit idx" /><label><input name="idempotent" type="checkbox" checked />Idempotent</label><button>Import CSV</button></form><table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Account</th><th>Category</th><th>Status</th><th>Tools</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderCalendar(model) {
    const checking = state.data.accounts.find((a) => a.type === 'Checking') || state.data.accounts[0];
    const ym = currentSettings().selectedMonth;
    const occ = model.occurrences.filter((o) => o.yearMonth === ym && o.accountId === checking.id);
    const pay = occ.filter((o) => o.type === 'Income');
    const nonPay = occ.filter((o) => o.type !== 'Income');
    const tx = state.data.transactions.filter((t) => toYearMonth(t.date) === ym && t.accountId === checking.id);
    const timeline = calcProjectedBalance(checking.startingBalance || 0, nonPay, pay, tx, { start: `${ym}-01`, end: `${ym}-28` });
    return `<div class="panel"><h3>Cashflow Timeline (${checking.name})</h3><table><thead><tr><th>Date</th><th>Type</th><th>Label</th><th>Amount</th><th>Running Balance</th></tr></thead><tbody>${timeline.map((e) => `<tr><td>${e.date}</td><td>${e.kind}</td><td>${e.label}</td><td>${formatCurrency(e.amount)}</td><td>${formatCurrency(e.runningBalance)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderScenarios(model) {
    const baseOcc = expandScheduledItemsToOccurrences(state.data.scheduledItems, state.data.scheduledOverrides, { startYm: '2026-01', endYm: '2026-12' });
    const basePlan = calcMonthlyPlan(baseOcc);
    const selectedScenarioId = currentSettings().selectedScenarioId;
    const compare = selectedScenarioId === 'scn_baseline'
      ? model.plan
      : calcMonthlyPlan(expandScheduledItemsToOccurrences(getScenarioAdjustedScheduledItems(), state.data.scheduledOverrides, { startYm: '2026-01', endYm: '2026-12' }));

    return `<div class="panel"><h3>Scenarios</h3><form id="scenarioForm" class="grid-form"><input name="name" placeholder="Scenario name" required /><button>Create Scenario from Baseline</button></form><table><thead><tr><th>Month</th><th>Baseline</th><th>Selected Scenario</th><th>Delta</th></tr></thead><tbody>${model.months.map((m) => { const b = basePlan.byMonth[m] || 0; const s = compare.byMonth[m] || 0; return `<tr><td>${m}</td><td>${formatCurrency(b)}</td><td>${formatCurrency(s)}</td><td>${formatCurrency(s - b)}</td></tr>`; }).join('')}<tr class="total"><td>Year Total</td><td>${formatCurrency(basePlan.annualTotal)}</td><td>${formatCurrency(compare.annualTotal)}</td><td>${formatCurrency(compare.annualTotal - basePlan.annualTotal)}</td></tr></tbody></table></div>`;
  }

  function accountsCategoriesForms() {
    return `<div class="split"><form id="accountForm" class="grid-form"><h4>Accounts</h4><input name="name" placeholder="Account name" required /><select name="type"><option>Checking</option><option>Savings</option><option>Cash</option><option>Credit Card</option></select><input name="startingBalance" type="number" placeholder="Starting Balance" value="0" /><button>Add Account</button></form><form id="categoryForm" class="grid-form"><h4>Categories</h4><input name="name" placeholder="Category name" required /><button>Add Category</button></form><ul>${state.data.accounts.map((a) => `<li>${a.name} (${a.type})</li>`).join('')}</ul><ul>${state.data.categories.map((c) => `<li>${c.name}</li>`).join('')}</ul></div>`;
  }

  function renderSettings() {
    const settings = currentSettings();
    return `<div class="panel"><h3>Settings / Data</h3><form id="bufferForm" class="grid-form"><input type="number" step="1" name="bufferAmount" value="${settings.bufferAmount}" /><button>Save Buffer</button></form><div class="buttons"><button data-action="export-json">Export JSON</button><input type="file" id="importJsonFile" accept="application/json" /><button data-action="import-json">Import JSON</button><button data-action="reset-demo">Reset Demo Data</button></div>${accountsCategoriesForms()}</div>`;
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

    if (target.dataset.action === 'quick-add-tx') {
      state.page = 'transactions';
      render();
      return;
    }
    if (target.dataset.action === 'quick-add-scheduled') {
      state.page = 'schedule';
      render();
      return;
    }
    if (target.dataset.action === 'quick-import') {
      state.page = 'transactions';
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
      if (!tx) return;
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
      const input = document.querySelector('#importJsonFile');
      const file = input && input.files ? input.files[0] : null;
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
      for (const s of STORES) {
        if (demo[s] && demo[s].length) await putMany(state.db, s, demo[s]);
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
      const fileInput = document.querySelector('#csvFile');
      const file = fileInput && fileInput.files ? fileInput.files[0] : null;
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
      render();
      return;
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
      return;
    }

    if (e.target.id === 'scenarioPicker') {
      await saveSettings({ selectedScenarioId: e.target.value });
      render();
    }
  }

  async function init() {
    try {
      state.db = await openDb();
      await ensureSeed();
      document.addEventListener('click', onClick);
      document.addEventListener('submit', onSubmit);
      document.addEventListener('change', onChange);
      render();
    } catch (err) {
      const app = document.querySelector('#app');
      if (app) app.innerHTML = `<div class="panel"><h2>Failed to initialize app</h2><p>${String(err && err.message ? err.message : err)}</p></div>`;
      console.error(err);
    }
  }

  init();
}());
