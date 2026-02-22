import { monthRange, parseYearMonth, toYearMonth, sortByDate } from './utils.js';

function getOverrideMap(overrides = []) {
  const map = new Map();
  for (const ov of overrides) {
    map.set(`${ov.scheduledItemId}:${ov.yearMonth}`, ov.amountOverride);
  }
  return map;
}

function buildDate(yearMonth, dueDay, explicitDate) {
  if (explicitDate) return explicitDate;
  const { year, month } = parseYearMonth(yearMonth);
  const day = Math.max(1, Math.min(28, Number(dueDay) || 1));
  return `${year}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`;
}

export function expandScheduledItemsToOccurrences(items, overrides, range) {
  const months = monthRange(range.startYm, range.endYm);
  const overrideMap = getOverrideMap(overrides);
  const occurrences = [];

  for (const item of items) {
    for (const ym of months) {
      const { month } = parseYearMonth(ym);
      let include = false;

      if (item.recurrence === 'monthly') include = true;
      if (item.recurrence === 'annual' && Number(item.dueMonth) === month) include = true;
      if (item.recurrence === 'custom' && Array.isArray(item.customMonths) && item.customMonths.includes(month)) include = true;
      if (!include) continue;

      const overrideKey = `${item.id}:${ym}`;
      const amount = Number(overrideMap.get(overrideKey) ?? item.amount ?? 0);
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

  return sortByDate(occurrences);
}

export function calcMonthlyPlan(occurrences) {
  const byMonth = {};
  const byLine = {};
  for (const occ of occurrences) {
    byMonth[occ.yearMonth] = (byMonth[occ.yearMonth] || 0) + occ.amount;
    const key = `${occ.scheduledItemId}:${occ.yearMonth}`;
    byLine[key] = occ.amount;
  }
  const annualTotal = Object.values(byMonth).reduce((sum, v) => sum + v, 0);
  return { byMonth, byLine, annualTotal };
}

export function calcActuals(transactions, monthRangeFilter = null) {
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

export function calcRemaining(plan, actual, month, buffer = 800) {
  const planned = plan.byMonth[month] || 0;
  const spent = actual.byMonth[month] || 0;
  const remaining = planned - spent;
  const disposableAfterBuffer = remaining - buffer;
  return {
    planned,
    spent,
    remaining,
    disposableAfterBuffer,
  };
}

export function calcProjectedBalance(startBalance, occurrences, paydays, knownTransactions, dateRange) {
  const all = [];
  for (const o of occurrences) {
    if (o.date >= dateRange.start && o.date <= dateRange.end) all.push({ date: o.date, amount: -Math.abs(o.amount), kind: 'planned', label: o.name });
  }
  for (const p of paydays) {
    if (p.date >= dateRange.start && p.date <= dateRange.end) all.push({ date: p.date, amount: Math.abs(p.amount), kind: 'payday', label: p.name || 'Payday' });
  }
  for (const tx of knownTransactions) {
    if (tx.date >= dateRange.start && tx.date <= dateRange.end) all.push({ date: tx.date, amount: tx.amount, kind: 'actual', label: tx.description });
  }

  const ordered = all.sort((a, b) => {
    if (a.date === b.date) return a.kind.localeCompare(b.kind);
    return new Date(a.date) - new Date(b.date);
  });

  let running = startBalance;
  return ordered.map((item) => {
    running += item.amount;
    return { ...item, runningBalance: running };
  });
}
