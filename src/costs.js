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

export function formatCents(cents, currency = 'USD') {
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

export function summarise(trip) {
  const stayCents = trip.stays.reduce((sum, s) => sum + toCents(s.cost), 0);
  const activityCents = trip.activities.reduce((sum, a) => sum + toCents(a.cost), 0);
  const totalCents = stayCents + activityCents;

  const headcount = trip.travellers.length;
  const perPerson = headcount > 0 ? splitCents(totalCents, headcount)[0] : 0;

  // Who paid what, so the summary can show who is owed money.
  const paidByTraveller = new Map(trip.travellers.map((t) => [t.id, 0]));
  for (const item of [...trip.stays, ...trip.activities]) {
    if (item.paidBy && paidByTraveller.has(item.paidBy)) {
      paidByTraveller.set(item.paidBy, paidByTraveller.get(item.paidBy) + toCents(item.cost));
    }
  }

  const shares = headcount > 0 ? splitCents(totalCents, headcount) : [];
  const balances = trip.travellers.map((t, i) => {
    const paid = paidByTraveller.get(t.id) || 0;
    return {
      id: t.id,
      name: t.name,
      paidCents: paid,
      oweCents: shares[i],
      // Positive means the group owes them; negative means they owe the group.
      netCents: paid - shares[i],
    };
  });

  return { stayCents, activityCents, totalCents, headcount, perPersonCents: perPerson, balances };
}

// Nights between two ISO dates, used to show per-night hotel rates.
export function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}
