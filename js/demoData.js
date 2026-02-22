import { uid } from './utils.js';

export function buildDemoData() {
  const checking = { id: 'acct_checking', name: 'Checking', type: 'Checking', startingBalance: 3200 };
  const savings = { id: 'acct_savings', name: 'Savings', type: 'Savings', startingBalance: 12000 };
  const cash = { id: 'acct_cash', name: 'Cash', type: 'Cash', startingBalance: 200 };
  const capOne = { id: 'acct_capone', name: 'Cap One Card', type: 'Credit Card', startingBalance: -400 };

  const categories = ['Child', 'Housing', 'Auto', 'Subscriptions', 'Food', 'Dog', 'Medical', 'Fun', 'Annual/One-offs', 'Income', 'Transfers']
    .map((name) => ({ id: `cat_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name }));

  const cat = (name) => categories.find((c) => c.name === name).id;

  const scheduledItems = [
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
  ];

  const scheduledOverrides = [
    { id: uid('ovr'), scheduledItemId: 'sch_groceries', yearMonth: '2026-05', amountOverride: 1150 },
    { id: uid('ovr'), scheduledItemId: 'sch_groceries', yearMonth: '2026-11', amountOverride: 1100 },
  ];

  const transactions = [
    { id: uid('tx'), date: '2026-05-01', description: 'Payroll Deposit', amount: 2390, accountId: checking.id, categoryId: cat('Income'), status: 'Matched' },
    { id: uid('tx'), date: '2026-05-01', description: 'Monthly Rent', amount: -1450, accountId: checking.id, categoryId: cat('Housing'), status: 'Matched' },
    { id: uid('tx'), date: '2026-05-03', description: 'Walmart Grocery', amount: -260, accountId: checking.id, categoryId: cat('Food'), status: 'Unmatched' },
    { id: uid('tx'), date: '2026-05-12', description: 'Car Loan Payment', amount: -453, accountId: checking.id, categoryId: cat('Auto'), status: 'Matched' },
    { id: uid('tx'), date: '2026-05-15', description: 'Payroll Deposit', amount: 2390, accountId: checking.id, categoryId: cat('Income'), status: 'Matched' },
    { id: uid('tx'), date: '2026-05-17', description: 'Amazon Purchase', amount: -42.13, accountId: capOne.id, categoryId: null, status: 'Needs Review' },
  ];

  const matchRules = [
    { id: uid('rule'), pattern: 'payroll', categoryId: cat('Income'), accountId: checking.id, amountTolerance: 2, dateWindowDays: 3 },
    { id: uid('rule'), pattern: 'rent', categoryId: cat('Housing'), accountId: checking.id, amountTolerance: 3, dateWindowDays: 5 },
  ];

  const scenarios = [
    { id: 'scn_baseline', name: 'Baseline', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'scn_future_move', name: 'Future Move', baseScenarioId: 'scn_baseline', createdAt: '2026-01-02T00:00:00.000Z' },
  ];

  const scenarioOverrides = [
    { id: uid('sovr'), scenarioId: 'scn_future_move', targetType: 'scheduledItem', targetId: 'sch_rent', yearMonth: null, overrideData: { amount: 1750 } },
    { id: uid('sovr'), scenarioId: 'scn_future_move', targetType: 'scheduledItem', targetId: 'sch_paycheck_1', yearMonth: null, overrideData: { amount: 2500 } },
  ];

  const settings = [{ id: 'app_settings', bufferAmount: 800, selectedMonth: '2026-05', selectedScenarioId: 'scn_baseline' }];

  return {
    accounts: [checking, savings, cash, capOne],
    categories,
    scheduledItems,
    scheduledOverrides,
    transactions,
    matchRules,
    scenarios,
    scenarioOverrides,
    settings,
    auditLog: [],
  };
}
