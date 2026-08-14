// Cost rollup for a trip.
//
// Money is handled in whole cents. Storing 45.10 as a float and summing it
// accumulates binary-fraction error, so every amount is parsed to an integer
// number of cents at the boundary and only divided for display.

export function toCents(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function formatCents(cents, currency = 'AUD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    // Intl throws on an unrecognised currency code; fall back to a plain number.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

// Splits an amount across n people without losing or inventing cents.
// 1000 cents across 3 people is 334/333/333, not 333.33 each.
export function splitCents(totalCents, people) {
  if (people <= 0) return [];
  const base = Math.floor(totalCents / people);
  let remainder = totalCents - base * people;
  const shares = new Array(people).fill(base);
  for (let i = 0; remainder > 0; i += 1, remainder -= 1) shares[i] += 1;
  return shares;
}

// Who actually shares a given cost. An item may name the travellers it applies
// to — one hotel room for Bharat and another for Ashish and Prabin should not
// be split three ways each. With nothing named, the cost belongs to everyone,
// which is what every item did before per-item splitting existed.
export function sharersOf(item, travellers) {
  const known = new Set(travellers.map((t) => t.id));
  const named = (item.sharedBy || []).filter((id) => known.has(id));
  return named.length ? named : travellers.map((t) => t.id);
}

export function summarise(trip) {
  const expenses = trip.expenses || [];
  const stayCents = trip.stays.reduce((sum, s) => sum + toCents(s.cost), 0);
  const activityCents = trip.activities.reduce((sum, a) => sum + toCents(a.cost), 0);
  const expenseCents = expenses.reduce((sum, e) => sum + toCents(e.cost), 0);
  const totalCents = stayCents + activityCents + expenseCents;

  const headcount = trip.travellers.length;
  const perPerson = headcount > 0 ? splitCents(totalCents, headcount)[0] : 0;

  const costItems = [...trip.stays, ...trip.activities, ...expenses];

  // Who paid what, so the summary can show who is owed money.
  const paidByTraveller = new Map(trip.travellers.map((t) => [t.id, 0]));
  // What each person owes, accumulated per item rather than from the trip total,
  // so an item shared by a subset only lands on those people.
  const oweByTraveller = new Map(trip.travellers.map((t) => [t.id, 0]));

  let splitEvenly = true;

  for (const item of costItems) {
    const cents = toCents(item.cost);
    if (item.paidBy && paidByTraveller.has(item.paidBy)) {
      paidByTraveller.set(item.paidBy, paidByTraveller.get(item.paidBy) + cents);
    }

    if (!headcount || cents === 0) continue;

    const sharers = sharersOf(item, trip.travellers);
    if (sharers.length !== headcount) splitEvenly = false;

    // Each item's remainder is distributed within that item, so the shares of a
    // single cost still add up to exactly the cost.
    const shares = splitCents(cents, sharers.length);
    sharers.forEach((id, i) => {
      oweByTraveller.set(id, (oweByTraveller.get(id) || 0) + shares[i]);
    });
  }

  // What each person paid toward the trip's costs, before any repayments between
  // them. The report shows this separately, otherwise "you paid" would be a
  // number that matches no list of items on the page.
  const paidCostByTraveller = new Map(paidByTraveller);

  // Repayments settle up between two people. A payment is not a trip cost: it
  // must never touch totalCents, perPersonCents or anyone's share. It moves the
  // same number of cents off one person's paid column and onto another's, so the
  // sum of all paid is unchanged, the sum of all net is unchanged, and settle()
  // therefore reports exactly the same unpaidCents as before.
  for (const payment of trip.payments || []) {
    const cents = toCents(payment.cost);
    const { paidBy: from, paidTo: to } = payment;
    if (cents <= 0 || !from || !to || from === to) continue;
    if (!paidByTraveller.has(from) || !paidByTraveller.has(to)) continue;

    paidByTraveller.set(from, paidByTraveller.get(from) + cents);
    paidByTraveller.set(to, paidByTraveller.get(to) - cents);
  }

  const balances = trip.travellers.map((t) => {
    const paid = paidByTraveller.get(t.id) || 0;
    const owe = oweByTraveller.get(t.id) || 0;
    return {
      id: t.id,
      name: t.name,
      paidCents: paid,
      paidCostCents: paidCostByTraveller.get(t.id) || 0,
      oweCents: owe,
      // Positive means the group owes them; negative means they owe the group.
      netCents: paid - owe,
    };
  });

  // Totals per category, so "track every expense" can be read at a glance.
  const byCategory = {};
  for (const e of expenses) {
    const key = e.category || 'Uncategorised';
    byCategory[key] = (byCategory[key] || 0) + toCents(e.cost);
  }

  return {
    stayCents,
    activityCents,
    expenseCents,
    totalCents,
    headcount,
    perPersonCents: perPerson,
    // False once any cost is shared by a subset, which makes a single
    // "each person pays X" figure misleading.
    splitEvenly,
    byCategory,
    balances,
  };
}

// Turns per-person balances into a concrete list of "X pays Y" transfers.
//
// The tricky part is that balances only net to zero when every cost has a payer
// recorded. A cost nobody is marked as paying still lands on everyone's `owe`
// side, so the totals come out negative overall: money left someone's pocket but
// the app doesn't know whose. Inventing transfers from that state would fabricate
// debts, so the unattributed amount is capped out of the matching and reported
// separately as `unpaidCents` for the UI to prompt about.
export function settle(balances) {
  const unpaidCents = -balances.reduce((sum, b) => sum + b.netCents, 0);

  // Sorted by amount, then id, so the same input always produces the same list.
  // The report must not reshuffle between viewing it and printing it.
  const byAmount = (a, b) => b.amount - a.amount || String(a.id).localeCompare(String(b.id));

  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ id: b.id, name: b.name, amount: b.netCents }))
    .sort(byAmount);

  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ id: b.id, name: b.name, amount: -b.netCents }))
    .sort(byAmount);

  // Debts can exceed credits by exactly `unpaidCents`. Scale the debt side down
  // to match what is actually owed to someone, largest debts absorbing the
  // reduction first. With no payers at all this zeroes every debt, which is the
  // correct answer: nobody can be told who to pay yet.
  const totalCredit = creditors.reduce((sum, c) => sum + c.amount, 0);
  let excess = debtors.reduce((sum, d) => sum + d.amount, 0) - totalCredit;
  for (const debtor of debtors) {
    if (excess <= 0) break;
    const cut = Math.min(debtor.amount, excess);
    debtor.amount -= cut;
    excess -= cut;
  }

  // Greedy two-pointer matching. Settles in at most n-1 transfers, which is
  // optimal for the shapes that come up in practice. (Finding the true minimum
  // in every case is NP-hard, so this deliberately doesn't claim to be minimal.)
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > 0) {
      transfers.push({
        fromId: debtor.id,
        fromName: debtor.name,
        toId: creditor.id,
        toName: creditor.name,
        cents: amount,
      });
      debtor.amount -= amount;
      creditor.amount -= amount;
    }

    if (debtor.amount === 0) i += 1;
    if (creditor.amount === 0) j += 1;
  }

  return {
    transfers,
    unpaidCents: Math.max(0, unpaidCents),
    settled: transfers.length === 0 && unpaidCents === 0,
  };
}

// Everything one person's report needs, so the page never redoes money math.
//
// Shares are accumulated with the same per-item ordering `summarise` uses, which
// is what keeps a person's line items adding up to exactly the `oweCents` shown
// on the summary. Recomputing an average here instead would drift by a cent on
// amounts that don't divide evenly.
export function personLedger(trip, travellerId) {
  const traveller = trip.travellers.find((t) => t.id === travellerId);
  if (!traveller) return null;

  const summary = summarise(trip);
  const settlement = settle(summary.balances);
  const balance = summary.balances.find((b) => b.id === travellerId);

  const collections = [
    ['stays', trip.stays],
    ['activities', trip.activities],
    ['expenses', trip.expenses || []],
  ];

  const nameOf = new Map(trip.travellers.map((t) => [t.id, t.name]));
  const items = [];

  for (const [collection, list] of collections) {
    for (const item of list) {
      const cents = toCents(item.cost);
      const sharers = sharersOf(item, trip.travellers);
      const index = sharers.indexOf(travellerId);
      const paidByMe = item.paidBy === travellerId;

      // Keep an item the person paid for even when they aren't sharing its cost,
      // otherwise their "what you paid for" list would silently lose entries.
      if (index === -1 && !paidByMe) continue;

      const shares = splitCents(cents, sharers.length);
      items.push({
        collection,
        name: item.name,
        date: item.checkIn || item.date || '',
        costCents: cents,
        shareCents: index === -1 ? 0 : shares[index],
        paidByMe,
        sharerCount: sharers.length,
        sharerNames: sharers.map((id) => nameOf.get(id)).filter(Boolean),
      });
    }
  }

  // Repayments are listed apart from `items` on purpose: a payment has no share
  // of a cost, so folding it in would break the rule that a person's line items
  // add up to exactly what they owe.
  const payments = (trip.payments || [])
    .filter((p) => p.paidBy === travellerId || p.paidTo === travellerId)
    .map((p) => ({
      name: p.name,
      date: p.date || '',
      cents: toCents(p.cost),
      direction: p.paidBy === travellerId ? 'out' : 'in',
      otherName: nameOf.get(p.paidBy === travellerId ? p.paidTo : p.paidBy) || '',
    }));

  return {
    traveller,
    items,
    payments,
    paidCents: balance.paidCents,
    paidCostCents: balance.paidCostCents,
    oweCents: balance.oweCents,
    netCents: balance.netCents,
    owes: settlement.transfers
      .filter((t) => t.fromId === travellerId)
      .map((t) => ({ toName: t.toName, cents: t.cents })),
    owedBy: settlement.transfers
      .filter((t) => t.toId === travellerId)
      .map((t) => ({ fromName: t.fromName, cents: t.cents })),
    unpaidCents: settlement.unpaidCents,
  };
}

// Dates are compared and stepped in UTC. Parsing them locally shifts every date
// back a day for anyone west of UTC, which would silently move a check-in.
const DAY_MS = 86400000;

function isIsoDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// A trip laid out one day at a time, merging stays, activities and expenses.
// Nothing here is stored: it is a view of data that already exists, so it never
// goes stale when a stay is edited.
const MAX_DAYS = 400;

export function dayPlan(trip) {
  const stays = trip.stays || [];
  const activities = trip.activities || [];
  const expenses = trip.expenses || [];
  const meals = trip.meals || [];

  const dates = [
    trip.startDate,
    trip.endDate,
    ...stays.flatMap((s) => [s.checkIn, s.checkOut]),
    ...activities.map((a) => a.date),
    ...expenses.map((e) => e.date),
    ...meals.map((m) => m.date),
  ].filter(isIsoDate);

  if (!dates.length) return [];

  const first = dates.reduce((a, b) => (a < b ? a : b));
  const last = dates.reduce((a, b) => (a > b ? a : b));

  // A mistyped year would otherwise walk thousands of days and lock up the page.
  const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS);
  if (span > MAX_DAYS) return [];

  const days = [];
  for (let i = 0; i <= span; i += 1) {
    const date = addDays(first, i);

    // Half-open, matching nightsBetween: you sleep somewhere on its check-in
    // date but not on its check-out date. Without this every day where one stay
    // ends and the next begins would match two stays — and on a road trip that
    // is nearly every day.
    const stay = stays.find((s) => s.checkIn && s.checkOut && s.checkIn <= date && date < s.checkOut)
      || null;

    const onThisDay = activities
      .filter((a) => a.date === date)
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const spentThisDay = expenses.filter((e) => e.date === date);

    // Ordered the way the meals list is, so breakfast stays above dinner if that
    // is how they were arranged there.
    const eatingThisDay = meals.filter((m) => m.date === date);

    days.push({
      date,
      index: i + 1,
      stay,
      arriving: stays.filter((s) => s.checkIn === date),
      departing: stays.filter((s) => s.checkOut === date),
      activities: onThisDay,
      expenses: spentThisDay,
      meals: eatingThisDay,
      // Only what happens on the day itself. A five-night booking is one cost on
      // its check-in date, not a fifth of a cost on each of five days.
      costCents: [...onThisDay, ...spentThisDay].reduce((sum, item) => sum + toCents(item.cost), 0),
    });
  }

  return days;
}

// Nights in the trip's date range that no stay covers, so unbooked stretches are
// visible rather than being silently absent from the itinerary.
export function accommodationGaps(trip) {
  if (!trip.startDate || !trip.endDate) return [];

  const stays = trip.stays
    .filter((s) => s.checkIn && s.checkOut && nightsBetween(s.checkIn, s.checkOut) > 0)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));

  const gaps = [];
  let cursor = trip.startDate;

  for (const stay of stays) {
    if (stay.checkIn > cursor) {
      gaps.push({ from: cursor, to: stay.checkIn, nights: nightsBetween(cursor, stay.checkIn) });
    }
    // Overlapping stays must not pull the cursor backwards, which would invent a
    // gap where the dates actually double up.
    if (stay.checkOut > cursor) cursor = stay.checkOut;
  }

  if (trip.endDate > cursor) {
    gaps.push({ from: cursor, to: trip.endDate, nights: nightsBetween(cursor, trip.endDate) });
  }

  return gaps;
}

// Nights between two ISO dates, used to show per-night hotel rates.
export function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}
