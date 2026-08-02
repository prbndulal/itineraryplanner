import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents,
  splitCents,
  summarise,
  nightsBetween,
  formatCents,
  sharersOf,
  settle,
  personLedger,
  accommodationGaps,
} from '../src/costs.js';

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

// --- settlement -------------------------------------------------------------

const balancesOf = (...entries) =>
  entries.map(([id, name, paidCents, oweCents]) => ({
    id,
    name,
    paidCents,
    oweCents,
    netCents: paidCents - oweCents,
  }));

test('settle turns balances into who pays whom', () => {
  const { transfers, unpaidCents, settled } = settle(
    balancesOf(['a', 'Prabin', 30000, 20000], ['b', 'Sam', 10000, 20000])
  );

  assert.equal(settled, false);
  assert.equal(unpaidCents, 0);
  assert.deepEqual(transfers, [
    { fromId: 'b', fromName: 'Sam', toId: 'a', toName: 'Prabin', cents: 10000 },
  ]);
});

test('settle reports nothing to do when everyone is square', () => {
  const result = settle(balancesOf(['a', 'Prabin', 10000, 10000], ['b', 'Sam', 5000, 5000]));
  assert.deepEqual(result.transfers, []);
  assert.equal(result.unpaidCents, 0);
  assert.equal(result.settled, true);
});

test('settle invents no transfers when nothing has a payer', () => {
  // The real trip's state: costs are recorded but nobody is marked as paying,
  // so the balances do not net to zero. Matching debtors against creditors here
  // would fabricate debts that nobody actually owes to anybody.
  const balances = balancesOf(
    ['a', 'Bharat', 0, 97522],
    ['b', 'Ashish', 0, 97520],
    ['c', 'Prabin', 0, 97520]
  );

  const { transfers, unpaidCents, settled } = settle(balances);
  assert.deepEqual(transfers, [], 'no transfer can be derived without a payer');
  assert.equal(unpaidCents, 292562);
  assert.equal(settled, false);
});

test('settle handles a lone traveller and an empty group', () => {
  const solo = settle(balancesOf(['a', 'Prabin', 0, 5000]));
  assert.deepEqual(solo.transfers, []);
  assert.equal(solo.unpaidCents, 5000);

  const nobody = settle([]);
  assert.deepEqual(nobody.transfers, []);
  assert.equal(nobody.unpaidCents, 0);
  assert.equal(nobody.settled, true);
});

test('settle points everyone at the person who paid for everything', () => {
  const { transfers } = settle(
    balancesOf(['a', 'Prabin', 292562, 97520], ['b', 'Bharat', 0, 97522], ['c', 'Ashish', 0, 97520])
  );

  assert.equal(transfers.length, 2);
  assert.ok(transfers.every((t) => t.toName === 'Prabin'));
  assert.equal(transfers.reduce((sum, t) => sum + t.cents, 0), 195042);
});

test('settle conserves cents and stays within n-1 transfers', () => {
  // Randomised paid/owe splits of a fixed pot: whatever the shape, the transfers
  // must move exactly what the creditors are owed and no more.
  let seed = 7;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };

  for (let round = 0; round < 200; round += 1) {
    const people = 2 + random(5);
    const total = 1000 + random(500000);
    const owes = splitCents(total, people);
    const paidShares = splitCents(total, people);

    // Shuffle who paid so paid and owed rarely line up.
    for (let i = paidShares.length - 1; i > 0; i -= 1) {
      const j = random(i + 1);
      [paidShares[i], paidShares[j]] = [paidShares[j], paidShares[i]];
    }

    const balances = owes.map((owe, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      paidCents: paidShares[i],
      oweCents: owe,
      netCents: paidShares[i] - owe,
    }));

    const { transfers, unpaidCents } = settle(balances);
    const credit = balances.reduce((sum, b) => sum + Math.max(0, b.netCents), 0);
    const moved = transfers.reduce((sum, t) => sum + t.cents, 0);

    assert.equal(unpaidCents, 0, 'a fully-paid trip has nothing unattributed');
    assert.equal(moved, credit, 'transfers move exactly what is owed');
    assert.ok(transfers.every((t) => t.cents > 0), 'no zero-value transfers');
    assert.ok(transfers.length <= people - 1, 'at most n-1 transfers');
  }
});

test('settle is deterministic', () => {
  // Ties are broken on id, so a report shows the same lines every time it is
  // opened or printed.
  const balances = balancesOf(
    ['c', 'Cal', 20000, 10000],
    ['a', 'Ana', 20000, 10000],
    ['b', 'Bo', 0, 20000]
  );
  assert.deepEqual(settle(balances), settle(balances));
});

test('settle works when a cost is shared by only some travellers', () => {
  const trip = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Prabin' },
      { id: 'b', name: 'Ashish' },
    ],
    stays: [{ id: 's1', name: 'Twin room', cost: '300.00', paidBy: 'a', sharedBy: ['a', 'b'] }],
    activities: [],
    expenses: [],
  };

  const { transfers } = settle(summarise(trip).balances);
  assert.deepEqual(transfers, [
    { fromId: 'b', fromName: 'Ashish', toId: 'a', toName: 'Prabin', cents: 15000 },
  ]);
});

// --- per-person ledger ------------------------------------------------------

test('a person ledger adds up to exactly their share', () => {
  // 1591.99 across 3 people does not divide evenly, so this catches any drift
  // between the ledger's per-item shares and the summary's total.
  const trip = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Bharat' },
      { id: 'b', name: 'Ashish' },
      { id: 'c', name: 'Prabin' },
    ],
    stays: [
      { id: 's1', name: 'Cairns', cost: '1591.99', checkIn: '2026-09-29' },
      { id: 's2', name: 'Townsville', cost: '482.91', checkIn: '2026-09-28' },
    ],
    activities: [],
    expenses: [],
  };

  const summary = summarise(trip);
  for (const traveller of trip.travellers) {
    const ledger = personLedger(trip, traveller.id);
    const summed = ledger.items.reduce((sum, i) => sum + i.shareCents, 0);
    const expected = summary.balances.find((b) => b.id === traveller.id).oweCents;
    assert.equal(summed, expected, `${traveller.name}'s line items must equal their share`);
  }
});

test('a person ledger lists what they paid for and who owes them', () => {
  const trip = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Prabin' },
      { id: 'b', name: 'Sam' },
    ],
    stays: [{ id: 's1', name: 'Hotel', cost: '300.00', paidBy: 'a' }],
    activities: [],
    expenses: [],
  };

  const ledger = personLedger(trip, 'a');
  assert.equal(ledger.paidCents, 30000);
  assert.equal(ledger.oweCents, 15000);
  assert.equal(ledger.netCents, 15000);
  assert.deepEqual(ledger.owes, []);
  assert.deepEqual(ledger.owedBy, [{ fromName: 'Sam', cents: 15000 }]);
  assert.equal(ledger.items[0].paidByMe, true);
  assert.equal(ledger.items[0].sharerCount, 2);

  const other = personLedger(trip, 'b');
  assert.deepEqual(other.owes, [{ toName: 'Prabin', cents: 15000 }]);
  assert.equal(other.items[0].paidByMe, false);
});

test('a person ledger keeps costs they paid but do not share', () => {
  const trip = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Prabin' },
      { id: 'b', name: 'Sam' },
    ],
    stays: [{ id: 's1', name: "Sam's room", cost: '200.00', paidBy: 'a', sharedBy: ['b'] }],
    activities: [],
    expenses: [],
  };

  const ledger = personLedger(trip, 'a');
  assert.equal(ledger.items.length, 1, 'the item they paid for is still listed');
  assert.equal(ledger.items[0].shareCents, 0, 'but none of it is their share');
  assert.equal(ledger.oweCents, 0);
  assert.equal(ledger.netCents, 20000);
});

test('personLedger returns null for someone not on the trip', () => {
  const trip = { currency: 'AUD', travellers: [], stays: [], activities: [], expenses: [] };
  assert.equal(personLedger(trip, 'nobody'), null);
});

// --- accommodation gaps -----------------------------------------------------

test('accommodationGaps finds nights with nowhere booked', () => {
  // The real trip: five contiguous stays, then five nights unbooked at the end.
  const trip = {
    startDate: '2026-09-25',
    endDate: '2026-10-09',
    stays: [
      { checkIn: '2026-09-25', checkOut: '2026-09-26' },
      { checkIn: '2026-09-26', checkOut: '2026-09-27' },
      { checkIn: '2026-09-27', checkOut: '2026-09-28' },
      { checkIn: '2026-09-28', checkOut: '2026-09-29' },
      { checkIn: '2026-09-29', checkOut: '2026-10-04' },
    ],
  };

  assert.deepEqual(accommodationGaps(trip), [
    { from: '2026-10-04', to: '2026-10-09', nights: 5 },
  ]);
});

test('accommodationGaps reports nothing when every night is covered', () => {
  assert.deepEqual(
    accommodationGaps({
      startDate: '2026-09-25',
      endDate: '2026-09-27',
      stays: [{ checkIn: '2026-09-25', checkOut: '2026-09-27' }],
    }),
    []
  );
});

test('accommodationGaps catches a gap before the first stay', () => {
  assert.deepEqual(
    accommodationGaps({
      startDate: '2026-09-25',
      endDate: '2026-09-30',
      stays: [{ checkIn: '2026-09-28', checkOut: '2026-09-30' }],
    }),
    [{ from: '2026-09-25', to: '2026-09-28', nights: 3 }]
  );
});

test('overlapping stays do not invent a gap', () => {
  assert.deepEqual(
    accommodationGaps({
      startDate: '2026-09-25',
      endDate: '2026-09-30',
      stays: [
        { checkIn: '2026-09-25', checkOut: '2026-09-30' },
        { checkIn: '2026-09-26', checkOut: '2026-09-27' },
      ],
    }),
    []
  );
});

test('accommodationGaps needs trip dates to say anything', () => {
  assert.deepEqual(accommodationGaps({ startDate: '', endDate: '', stays: [] }), []);
});
