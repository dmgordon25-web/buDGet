import test from 'node:test';
import assert from 'node:assert/strict';
import { expandScheduledItemsToOccurrences, calcMonthlyPlan, calcActuals, calcRemaining, calcProjectedBalance } from '../js/engine.js';
import { findMatchSuggestions, applyMatchSuggestions } from '../js/matching.js';
import { buildDemoData } from '../js/demoData.js';

const demo = buildDemoData();

function monthModel() {
  const occurrences = expandScheduledItemsToOccurrences(demo.scheduledItems, demo.scheduledOverrides, { startYm: '2026-01', endYm: '2026-12' });
  const plan = calcMonthlyPlan(occurrences);
  const actual = calcActuals(demo.transactions, ['2026-05']);
  return { occurrences, plan, actual };
}

test('monthly totals and annual total are deterministic', () => {
  const { plan } = monthModel();
  assert.equal(plan.byMonth['2026-11'], 11283);
  const sum = Object.values(plan.byMonth).reduce((a, b) => a + b, 0);
  assert.equal(plan.annualTotal, sum);
});

test('disposable after buffer changes with override and matched transaction', () => {
  const { occurrences, plan, actual } = monthModel();
  const before = calcRemaining(plan, actual, '2026-05', 800);
  assert.equal(before.disposableAfterBuffer, 5158.13);

  const suggestions = findMatchSuggestions(
    [{ id: 'x', date: '2026-05-01', description: 'Monthly Rent', amount: -1450, accountId: 'acct_checking' }],
    occurrences,
    demo.matchRules
  );
  const matched = applyMatchSuggestions([{ id: 'x', date: '2026-05-01', description: 'Monthly Rent', amount: -1450, accountId: 'acct_checking', status: 'Unmatched' }], suggestions);
  assert.equal(matched[0].status, 'Matched');

  const changedPlan = { ...plan, byMonth: { ...plan.byMonth, '2026-05': plan.byMonth['2026-05'] + 200 } };
  const after = calcRemaining(changedPlan, actual, '2026-05', 800);
  assert.equal(after.disposableAfterBuffer, before.disposableAfterBuffer + 200);
});

test('projected balance timeline stays ordered by date', () => {
  const timeline = calcProjectedBalance(
    1000,
    [{ date: '2026-05-12', amount: 200, name: 'Bill A' }, { date: '2026-05-02', amount: 100, name: 'Bill B' }],
    [{ date: '2026-05-01', amount: 900, name: 'Payday' }],
    [{ date: '2026-05-03', amount: -40, description: 'Coffee' }],
    { start: '2026-05-01', end: '2026-05-28' }
  );
  const orderedDates = timeline.map((t) => t.date);
  assert.deepEqual(orderedDates, ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-12']);
  assert.equal(timeline[timeline.length - 1].runningBalance, 1560);
});

test('export-import roundtrip preserves identical data payload', () => {
  const payload = { exportedAt: '2026-01-01T00:00:00.000Z', data: demo };
  const exported = JSON.stringify(payload);
  const imported = JSON.parse(exported);
  assert.deepEqual(imported.data.scheduledItems, demo.scheduledItems);
  assert.deepEqual(imported.data.transactions, demo.transactions);
});
