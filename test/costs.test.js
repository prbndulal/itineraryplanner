import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, splitCents, summarise, nightsBetween } from '../src/costs.js';

test('toCents parses money without float drift', () => {
  assert.equal(toCents('45.10'), 4510);
  assert.equal(toCents(45.1), 4510);
  assert.equal(toCents('$1,200.99'), 120099);
  assert.equal(toCents(''), 0);
  assert.equal(toCents(undefined), 0);
  assert.equal(toCents('not a number'), 0);
});

test('summing prices avoids binary fraction error', () => {
  // 0.1 + 0.2 !== 0.3 in floating point; in cents it is exact.
  const total = toCents('0.1') + toCents('0.2');
  assert.equal(total, 30);
});

test('splitCents distributes every cent', () => {
  assert.deepEqual(splitCents(1000, 3), [334, 333, 333]);
  assert.equal(splitCents(1000, 3).reduce((a, b) => a + b, 0), 1000);
  assert.deepEqual(splitCents(100, 4), [25, 25, 25, 25]);
  assert.deepEqual(splitCents(0, 2), [0, 0]);
  assert.deepEqual(splitCents(500, 0), []);
});

test('nightsBetween counts nights, not days', () => {
  assert.equal(nightsBetween('2026-10-01', '2026-10-04'), 3);
  assert.equal(nightsBetween('2026-10-01', '2026-10-01'), 0);
  assert.equal(nightsBetween('2026-10-05', '2026-10-01'), 0); // reversed
  assert.equal(nightsBetween('', '2026-10-04'), 0);
});

test('summarise totals costs and balances who owes what', () => {
  const trip = {
    currency: 'USD',
    travellers: [
      { id: 'a', name: 'Prabin' },
      { id: 'b', name: 'Sam' },
    ],
    stays: [{ id: 's1', name: 'Hotel', cost: '300.00', paidBy: 'a' }],
    activities: [{ id: 'x1', name: 'Tour', cost: '100.00', paidBy: 'b' }],
  };

  const s = summarise(trip);
  assert.equal(s.stayCents, 30000);
  assert.equal(s.activityCents, 10000);
  assert.equal(s.totalCents, 40000);
  assert.equal(s.perPersonCents, 20000);

  // Prabin paid 300 but owes 200, so the group owes him 100.
  const prabin = s.balances.find((b) => b.name === 'Prabin');
  assert.equal(prabin.netCents, 10000);

  // Sam paid 100 and owes 200, so he owes 100.
  const sam = s.balances.find((b) => b.name === 'Sam');
  assert.equal(sam.netCents, -10000);

  // Balances always net to zero, otherwise money was invented or lost.
  assert.equal(s.balances.reduce((sum, b) => sum + b.netCents, 0), 0);
});

test('summarise handles a trip with no travellers', () => {
  const s = summarise({
    currency: 'USD',
    travellers: [],
    stays: [{ cost: '50' }],
    activities: [],
  });
  assert.equal(s.totalCents, 5000);
  assert.equal(s.perPersonCents, 0);
  assert.deepEqual(s.balances, []);
});

test('costs paid by nobody still count toward the total', () => {
  const s = summarise({
    currency: 'USD',
    travellers: [{ id: 'a', name: 'Prabin' }],
    stays: [{ cost: '100', paidBy: '' }],
    activities: [],
  });
  assert.equal(s.totalCents, 10000);
  assert.equal(s.balances[0].paidCents, 0);
  assert.equal(s.balances[0].netCents, -10000);
});
