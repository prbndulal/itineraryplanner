import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, splitCents, summarise, nightsBetween, formatCents, sharersOf } from '../src/costs.js';

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

test('money formats as AUD by default', () => {
  assert.equal(formatCents(45000), 'A$450.00');
  assert.equal(formatCents(45000, 'USD'), '$450.00');
});

test('sharersOf falls back to everyone and ignores unknown ids', () => {
  const travellers = [{ id: 'a', name: 'Bharat' }, { id: 'b', name: 'Ashish' }];
  assert.deepEqual(sharersOf({}, travellers), ['a', 'b']);
  assert.deepEqual(sharersOf({ sharedBy: [] }, travellers), ['a', 'b']);
  assert.deepEqual(sharersOf({ sharedBy: ['b'] }, travellers), ['b']);
  // An id from another trip must not silently shrink the split.
  assert.deepEqual(sharersOf({ sharedBy: ['nope'] }, travellers), ['a', 'b']);
});

test('a stay is only owed by the travellers who slept in it', () => {
  // Bharat stays somewhere on his own; Ashish and Prabin share a different room.
  const trip = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Bharat' },
      { id: 'b', name: 'Ashish' },
      { id: 'c', name: 'Prabin' },
    ],
    stays: [
      { id: 's1', name: 'Single room', cost: '200.00', paidBy: 'a', sharedBy: ['a'] },
      { id: 's2', name: 'Twin room', cost: '300.00', paidBy: 'b', sharedBy: ['b', 'c'] },
    ],
    activities: [],
    expenses: [],
  };

  const s = summarise(trip);
  assert.equal(s.totalCents, 50000);
  assert.equal(s.splitEvenly, false, 'a subset split must flag the even-split figure as meaningless');

  const owed = Object.fromEntries(s.balances.map((b) => [b.name, b.oweCents]));
  assert.equal(owed.Bharat, 20000, 'his own room only');
  assert.equal(owed.Ashish, 15000, 'half the twin');
  assert.equal(owed.Prabin, 15000, 'half the twin');

  // Bharat paid for exactly what he owes, so he is square.
  assert.equal(s.balances.find((b) => b.name === 'Bharat').netCents, 0);
  // Ashish paid 300 and owes 150, so Prabin owes him 150.
  assert.equal(s.balances.find((b) => b.name === 'Ashish').netCents, 15000);
  assert.equal(s.balances.find((b) => b.name === 'Prabin').netCents, -15000);
  assert.equal(s.balances.reduce((sum, b) => sum + b.netCents, 0), 0);
});

test('a subset split still preserves every cent', () => {
  const trip = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Bharat' },
      { id: 'b', name: 'Ashish' },
      { id: 'c', name: 'Prabin' },
    ],
    stays: [],
    activities: [],
    // 10.00 across two of the three people: 500/500, and nothing on the third.
    expenses: [{ id: 'e1', name: 'Taxi', cost: '10.00', paidBy: 'a', sharedBy: ['a', 'b'] }],
  };

  const s = summarise(trip);
  const owed = s.balances.reduce((sum, b) => sum + b.oweCents, 0);
  assert.equal(owed, 1000, 'shares must add up to the cost exactly');
  assert.equal(s.balances.find((b) => b.name === 'Prabin').oweCents, 0);
});

test('expenses count toward the total and group by category', () => {
  const s = summarise({
    currency: 'AUD',
    travellers: [{ id: 'a', name: 'Bharat' }, { id: 'b', name: 'Ashish' }],
    stays: [{ cost: '100.00' }],
    activities: [{ cost: '50.00' }],
    expenses: [
      { name: 'Dinner', cost: '80.00', category: 'Food & drink', paidBy: 'a' },
      { name: 'Lunch', cost: '20.00', category: 'Food & drink', paidBy: 'b' },
      { name: 'Train', cost: '15.00', category: 'Transport', paidBy: 'a' },
      { name: 'Odds and ends', cost: '5.00', category: '' },
    ],
  });

  assert.equal(s.expenseCents, 12000);
  assert.equal(s.totalCents, 27000, 'stays + activities + expenses');
  assert.equal(s.byCategory['Food & drink'], 10000);
  assert.equal(s.byCategory.Transport, 1500);
  assert.equal(s.byCategory.Uncategorised, 500);
  assert.equal(s.splitEvenly, true, 'nothing was restricted to a subset');
});

test('summarise still works on a trip with no expenses array', () => {
  // Trips loaded before expenses existed must not crash the rollup.
  const s = summarise({
    currency: 'AUD',
    travellers: [{ id: 'a', name: 'Bharat' }],
    stays: [{ cost: '100' }],
    activities: [],
  });
  assert.equal(s.expenseCents, 0);
  assert.equal(s.totalCents, 10000);
  assert.deepEqual(s.byCategory, {});
});
