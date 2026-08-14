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
  dayPlan,
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

// --- day by day -------------------------------------------------------------

// The real trip's shape: contiguous stays where each check-out is the next
// check-in, which is what makes the half-open interval matter.
const roadTrip = () => ({
  startDate: '2026-09-25',
  endDate: '2026-10-09',
  stays: [
    { name: 'Ballina', checkIn: '2026-09-25', checkOut: '2026-09-26', cost: '344.70' },
    { name: 'Bundaberg', checkIn: '2026-09-26', checkOut: '2026-09-27', cost: '285.91' },
    { name: 'Cairns', checkIn: '2026-09-29', checkOut: '2026-10-04', cost: '1591.99' },
  ],
  activities: [],
  expenses: [],
});

test('dayPlan covers every day of the trip', () => {
  const days = dayPlan(roadTrip());
  assert.equal(days.length, 15, '25 Sep to 9 Oct inclusive');
  assert.equal(days[0].date, '2026-09-25');
  assert.equal(days.at(-1).date, '2026-10-09');
  assert.equal(days[0].index, 1);
});

test('a multi-night stay fills its nights but not its checkout day', () => {
  const days = dayPlan(roadTrip());
  const cairns = days.filter((d) => d.stay && d.stay.name === 'Cairns');
  assert.equal(cairns.length, 5, '29 Sep through 3 Oct');
  assert.deepEqual(cairns.map((d) => d.date), [
    '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
  ]);

  // You check out on the 4th, so you do not sleep there that night.
  const checkoutDay = days.find((d) => d.date === '2026-10-04');
  assert.equal(checkoutDay.stay, null);
  assert.equal(checkoutDay.departing[0].name, 'Cairns');
});

test('a handover day shows the departure and the arrival', () => {
  // Leave Ballina and sleep in Bundaberg, both on 26 Sep.
  const day = dayPlan(roadTrip()).find((d) => d.date === '2026-09-26');
  assert.equal(day.departing[0].name, 'Ballina');
  assert.equal(day.arriving[0].name, 'Bundaberg');
  assert.equal(day.stay.name, 'Bundaberg', 'the stay is where you end up');
});

test('days with nothing booked are still listed', () => {
  const days = dayPlan(roadTrip());
  const unbooked = days.filter((d) => !d.stay);
  assert.ok(unbooked.length > 0);
  assert.ok(unbooked.every((d) => d.costCents === 0));

  // Every unbooked *night* shows up as an unbooked day. There is one extra: the
  // final day of the trip, when you travel home rather than needing a bed.
  const gaps = accommodationGaps(roadTrip());
  const gapNights = gaps.reduce((sum, g) => sum + g.nights, 0);
  assert.equal(unbooked.length, gapNights + 1);
  assert.equal(unbooked.at(-1).date, '2026-10-09', 'the last day is a travel day, not a missing booking');

  const nightDates = new Set(unbooked.slice(0, -1).map((d) => d.date));
  for (const gap of gaps) {
    for (let d = gap.from; d < gap.to; ) {
      assert.ok(nightDates.has(d), `${d} should be an unbooked day`);
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    }
  }
});

test('activities and expenses land on their own day, earliest first', () => {
  const trip = roadTrip();
  trip.activities = [
    { name: 'Reef trip', date: '2026-09-30', time: '14:00', cost: '120.00' },
    { name: 'Breakfast tour', date: '2026-09-30', time: '07:30', cost: '30.00' },
    { name: 'Later trip', date: '2026-10-02', cost: '10.00' },
  ];
  trip.expenses = [{ name: 'Fuel', date: '2026-09-30', cost: '80.00' }];

  const day = dayPlan(trip).find((d) => d.date === '2026-09-30');
  assert.deepEqual(day.activities.map((a) => a.name), ['Breakfast tour', 'Reef trip']);
  assert.equal(day.expenses[0].name, 'Fuel');
  // 30 + 120 + 80, and nothing from the five-night stay it falls inside.
  assert.equal(day.costCents, 23000);
});

test('a stay costs nothing extra on the days after check-in', () => {
  // Otherwise day totals would stop adding up to the trip total.
  const days = dayPlan(roadTrip());
  assert.ok(days.every((d) => d.costCents === 0), 'no activities or expenses in this fixture');
});

test('dayPlan survives missing and malformed dates', () => {
  const days = dayPlan({
    startDate: '2026-09-25',
    endDate: '2026-09-27',
    stays: [
      { name: 'No dates', checkIn: '', checkOut: '' },
      { name: 'Nonsense', checkIn: 'not-a-date', checkOut: 'also-bad' },
      { name: 'Fine', checkIn: '2026-09-25', checkOut: '2026-09-26' },
    ],
    activities: [{ name: 'Undated', date: undefined }],
    expenses: [],
  });

  assert.equal(days.length, 3);
  assert.ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), 'no Invalid Date leaks out');
});

test('dayPlan refuses an implausible span rather than walking it', () => {
  // A mistyped year would otherwise build tens of thousands of entries.
  assert.deepEqual(
    dayPlan({
      startDate: '2026-09-25',
      endDate: '2026-10-09',
      stays: [{ name: 'Typo', checkIn: '2026-09-25', checkOut: '2062-10-04' }],
      activities: [],
      expenses: [],
    }),
    []
  );
});

test('dayPlan returns nothing when there are no dates at all', () => {
  assert.deepEqual(
    dayPlan({ startDate: '', endDate: '', stays: [], activities: [], expenses: [] }),
    []
  );
});

// --- recorded payments ------------------------------------------------------

const twoPeople = (payments = []) => ({
  currency: 'AUD',
  travellers: [
    { id: 'a', name: 'Prabin' },
    { id: 'b', name: 'Sam' },
  ],
  stays: [{ id: 's1', name: 'Hotel', cost: '300.00', paidBy: 'a' }],
  activities: [],
  expenses: [],
  payments,
});

test('a repayment is not a trip cost', () => {
  const before = summarise(twoPeople());
  const after = summarise(twoPeople([
    { id: 'p1', name: 'Bank transfer', cost: '50.00', paidBy: 'b', paidTo: 'a' },
  ]));

  // The trip did not get more expensive because someone settled up.
  assert.equal(after.totalCents, before.totalCents);
  assert.equal(after.stayCents, before.stayCents);
  assert.equal(after.activityCents, before.activityCents);
  assert.equal(after.expenseCents, before.expenseCents);
  assert.equal(after.perPersonCents, before.perPersonCents);
  assert.deepEqual(after.byCategory, before.byCategory);

  // And nobody's share of the costs changed either. This is the assertion that
  // catches a payment being applied to the wrong side of the balance: put it in
  // `owe` instead of `paid` and the totals still net to zero, so every other
  // test would still pass while the numbers were quietly wrong.
  for (const b of after.balances) {
    const was = before.balances.find((x) => x.id === b.id);
    assert.equal(b.oweCents, was.oweCents, `${b.name}'s share must not move`);
  }
});

test('a repayment moves money between two people and nowhere else', () => {
  const before = summarise(twoPeople());
  const after = summarise(twoPeople([
    { id: 'p1', name: 'Transfer', cost: '50.00', paidBy: 'b', paidTo: 'a' },
  ]));

  const sum = (s) => s.balances.reduce((total, b) => total + b.paidCents, 0);
  assert.equal(sum(after), sum(before), 'the total paid across the group is unchanged');
  assert.equal(after.balances.reduce((t, b) => t + b.netCents, 0), 0);

  const sam = after.balances.find((b) => b.name === 'Sam');
  assert.equal(sam.paidCents, 5000);
  assert.equal(sam.paidCostCents, 0, 'a repayment is not money spent on the trip');
});

test('a repayment cannot change what is unattributed', () => {
  // The real trip's state: costs recorded, nobody marked as paying. Recording a
  // repayment must not make the app think it now knows who paid for the trip.
  const noPayers = {
    currency: 'AUD',
    travellers: [
      { id: 'a', name: 'Bharat' },
      { id: 'b', name: 'Ashish' },
      { id: 'c', name: 'Prabin' },
    ],
    stays: [{ id: 's1', name: 'Cairns', cost: '1591.99' }],
    activities: [],
    expenses: [],
    payments: [],
  };

  const before = settle(summarise(noPayers).balances);
  const after = settle(summarise({
    ...noPayers,
    payments: [{ id: 'p1', name: 'Transfer', cost: '500.00', paidBy: 'b', paidTo: 'a' }],
  }).balances);

  assert.equal(after.unpaidCents, before.unpaidCents);
  assert.equal(after.unpaidCents, 159199);
});

test('a repayment cancels the transfer it settles', () => {
  const settled = settle(summarise(twoPeople([
    { id: 'p1', name: 'Transfer', cost: '150.00', paidBy: 'b', paidTo: 'a' },
  ])).balances);

  assert.deepEqual(settled.transfers, []);
  assert.equal(settled.settled, true);
});

test('overpaying reverses the debt rather than clamping at zero', () => {
  const settled = settle(summarise(twoPeople([
    { id: 'p1', name: 'Too much', cost: '200.00', paidBy: 'b', paidTo: 'a' },
  ])).balances);

  assert.equal(settled.transfers.length, 1);
  assert.equal(settled.transfers[0].fromName, 'Prabin', 'now Prabin owes Sam the difference');
  assert.equal(settled.transfers[0].cents, 5000);
});

test('unusable payments are ignored', () => {
  const before = summarise(twoPeople());
  const after = summarise(twoPeople([
    { id: 'p1', name: 'No recipient', cost: '50.00', paidBy: 'b', paidTo: '' },
    { id: 'p2', name: 'No payer', cost: '50.00', paidBy: '', paidTo: 'a' },
    { id: 'p3', name: 'Ghost', cost: '50.00', paidBy: 'b', paidTo: 'nobody' },
    { id: 'p4', name: 'To themselves', cost: '50.00', paidBy: 'b', paidTo: 'b' },
    { id: 'p5', name: 'Nothing', cost: '0', paidBy: 'b', paidTo: 'a' },
  ]));

  assert.deepEqual(
    after.balances.map((b) => b.netCents),
    before.balances.map((b) => b.netCents)
  );
  assert.equal(after.balances.reduce((t, b) => t + b.netCents, 0), 0);
});

test('settlement survives any mix of costs and repayments', () => {
  // The randomised check from before, now with repayments thrown in. Whatever
  // shape the balances take, the transfers must still move exactly what is owed.
  let seed = 11;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };

  for (let round = 0; round < 200; round += 1) {
    const people = 2 + random(4);
    const travellers = Array.from({ length: people }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const total = 1000 + random(500000);

    const stays = [{
      id: 's1',
      name: 'Stay',
      cost: (total / 100).toFixed(2),
      paidBy: `p${random(people)}`,
    }];

    const payments = Array.from({ length: random(4) }, (_, i) => {
      const from = random(people);
      let to = random(people);
      if (to === from) to = (to + 1) % people;
      return {
        id: `pay${i}`,
        name: 'Transfer',
        cost: (random(200000) / 100).toFixed(2),
        paidBy: `p${from}`,
        paidTo: `p${to}`,
      };
    });

    const trip = { currency: 'AUD', travellers, stays, activities: [], expenses: [], payments };
    const s = summarise(trip);
    const { transfers, unpaidCents } = settle(s.balances);

    assert.equal(s.totalCents, toCents(stays[0].cost), 'repayments never inflate the total');
    assert.equal(unpaidCents, 0, 'the one cost has a payer, so nothing is unattributed');
    assert.equal(s.balances.reduce((t, b) => t + b.netCents, 0), 0);

    const credit = s.balances.reduce((t, b) => t + Math.max(0, b.netCents), 0);
    assert.equal(transfers.reduce((t, x) => t + x.cents, 0), credit);
    assert.ok(transfers.every((x) => x.cents > 0));
    assert.ok(transfers.length <= people - 1);
  }
});

test('a person ledger keeps repayments out of their share', () => {
  const trip = twoPeople([
    { id: 'p1', name: 'Transfer', cost: '50.00', paidBy: 'b', paidTo: 'a' },
  ]);

  const summary = summarise(trip);
  for (const traveller of trip.travellers) {
    const ledger = personLedger(trip, traveller.id);
    const summed = ledger.items.reduce((total, i) => total + i.shareCents, 0);
    const expected = summary.balances.find((b) => b.id === traveller.id).oweCents;
    assert.equal(summed, expected, `${traveller.name}'s items must still equal their share`);
  }

  const sam = personLedger(trip, 'b');
  assert.equal(sam.payments.length, 1);
  assert.equal(sam.payments[0].direction, 'out');
  assert.equal(sam.payments[0].otherName, 'Prabin');
  assert.equal(sam.paidCostCents, 0);
  assert.equal(sam.paidCents, 5000);

  const prabin = personLedger(trip, 'a');
  assert.equal(prabin.payments[0].direction, 'in');
  assert.equal(prabin.paidCostCents, 30000, 'what he actually spent on the trip');
  assert.equal(prabin.paidCents, 25000, 'less the 50 he has been repaid');
});
