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

  const balances = trip.travellers.map((t) => {
    const paid = paidByTraveller.get(t.id) || 0;
    const owe = oweByTraveller.get(t.id) || 0;
    return {
      id: t.id,
      name: t.name,
      paidCents: paid,
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

// Nights between two ISO dates, used to show per-night hotel rates.
export function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}
