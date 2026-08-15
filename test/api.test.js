import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import * as store from '../src/store.js';

// Exercises the real HTTP surface against the configured database, then removes
// everything it created.
const created = [];
let base;

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
base = `http://127.0.0.1:${server.address().port}`;
await store.load();

after(async () => {
  for (const tripId of created) await store.deleteTrip(tripId);
  server.close();
  await store.close();
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function makeTrip(name = 'Test Trip') {
  const res = await call('POST', '/api/trips', { name, destination: 'Kathmandu' });
  created.push(res.body.id);
  return res.body;
}

test('creating a trip returns both tokens to the owner', async () => {
  const trip = await makeTrip('Nepal October');
  assert.equal(trip.name, 'Nepal October');
  assert.ok(trip.viewToken);
  assert.ok(trip.editToken);
  assert.notEqual(trip.viewToken, trip.editToken);
  assert.equal(trip.canEdit, true);
});

test('a trip name is required', async () => {
  const res = await call('POST', '/api/trips', { name: '   ' });
  assert.equal(res.status, 400);
});

test('the view token never exposes the edit token', async () => {
  const trip = await makeTrip();
  const res = await call('GET', `/api/trips/${trip.viewToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.canEdit, false);
  assert.equal(res.body.editToken, undefined, 'forwarding a view link would leak edit access');
  assert.ok(res.body.viewToken);
});

test('the view token cannot write', async () => {
  const trip = await makeTrip();
  const add = await call('POST', `/api/trips/${trip.viewToken}/stays`, { name: 'Sneaky Hotel' });
  assert.equal(add.status, 403);

  const del = await call('DELETE', `/api/trips/${trip.viewToken}`);
  assert.equal(del.status, 403);

  const patch = await call('PATCH', `/api/trips/${trip.viewToken}`, { name: 'Renamed' });
  assert.equal(patch.status, 403);

  // Confirm nothing actually changed.
  const after = await call('GET', `/api/trips/${trip.editToken}`);
  assert.equal(after.body.stays.length, 0);
});

test('an unknown token is a 404', async () => {
  const res = await call('GET', '/api/trips/not-a-real-token');
  assert.equal(res.status, 404);
});

test('stays persist with cost and computed nights', async () => {
  const trip = await makeTrip();
  const res = await call('POST', `/api/trips/${trip.editToken}/stays`, {
    name: 'Hotel Yak & Yeti',
    address: 'Durbar Marg',
    checkIn: '2026-10-01',
    checkOut: '2026-10-04',
    cost: '450.00',
    mapUrl: 'https://maps.google.com/?q=hotel',
  });

  assert.equal(res.status, 201);
  const stay = res.body.stays[0];
  assert.equal(stay.name, 'Hotel Yak & Yeti');
  assert.equal(stay.nights, 3);
  assert.equal(stay.mapUrl, 'https://maps.google.com/?q=hotel');
  assert.equal(res.body.summary.stayCents, 45000);
});

test('a javascript: map link is rejected', async () => {
  const trip = await makeTrip();
  const res = await call('POST', `/api/trips/${trip.editToken}/stays`, {
    name: 'Bad Link Hotel',
    mapUrl: 'javascript:alert(document.cookie)',
  });
  assert.equal(res.status, 400);
});

test('an unknown collection is rejected', async () => {
  const trip = await makeTrip();
  const res = await call('POST', `/api/trips/${trip.editToken}/passwords`, { name: 'x' });
  assert.equal(res.status, 400);
});

test('travellers split costs and balances net to zero', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const withB = await call('POST', `/api/trips/${t}/travellers`, { name: 'Sam' });
  const prabinId = withA.body.travellers[0].id;
  assert.equal(withB.body.travellers.length, 2);

  const res = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Hotel',
    cost: '300.00',
    paidBy: prabinId,
  });

  const summary = res.body.summary;
  assert.equal(summary.headcount, 2);
  assert.equal(summary.perPersonCents, 15000);
  assert.equal(summary.balances.reduce((sum, b) => sum + b.netCents, 0), 0);

  const prabin = summary.balances.find((b) => b.name === 'Prabin');
  assert.equal(prabin.netCents, 15000, 'paid 300, owes 150, so is owed 150');
});

test('items can be removed', async () => {
  const trip = await makeTrip();
  const added = await call('POST', `/api/trips/${trip.editToken}/activities`, {
    name: 'Everest flight',
    cost: '220',
  });
  const itemId = added.body.activities[0].id;

  const removed = await call('DELETE', `/api/trips/${trip.editToken}/activities/${itemId}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.activities.length, 0);
  assert.equal(removed.body.summary.totalCents, 0);
});

test('editing an item updates it and recomputes costs', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const added = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Hotel Yak & Yeti',
    checkIn: '2026-10-01',
    checkOut: '2026-10-04',
    cost: '450.00',
  });
  const stayId = added.body.stays[0].id;

  const edited = await call('PATCH', `/api/trips/${t}/stays/${stayId}`, {
    name: 'Hotel Shanker',
    checkIn: '2026-10-01',
    checkOut: '2026-10-03',
    cost: '300.00',
  });

  assert.equal(edited.status, 200);
  const stay = edited.body.stays[0];
  assert.equal(edited.body.stays.length, 1, 'editing must not create a second row');
  assert.equal(stay.id, stayId);
  assert.equal(stay.name, 'Hotel Shanker');
  assert.equal(stay.nights, 2);
  assert.equal(edited.body.summary.stayCents, 30000);
});

test('editing can clear a field and reassign who paid', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const traveller = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabinId = traveller.body.travellers[0].id;

  const added = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Hotel',
    bookingRef: 'ABC123',
    cost: '100.00',
    paidBy: prabinId,
  });
  const stayId = added.body.stays[0].id;

  const edited = await call('PATCH', `/api/trips/${t}/stays/${stayId}`, {
    name: 'Hotel',
    bookingRef: '',
    paidBy: '',
  });

  assert.equal(edited.body.stays[0].bookingRef, '');
  assert.equal(edited.body.stays[0].paidBy, '');
  assert.equal(edited.body.summary.balances[0].paidCents, 0, 'the payer was cleared');
});

test('an edit is rejected when it would leave an item unnamed', async () => {
  const trip = await makeTrip();
  const added = await call('POST', `/api/trips/${trip.editToken}/activities`, { name: 'Everest flight' });
  const itemId = added.body.activities[0].id;

  const res = await call('PATCH', `/api/trips/${trip.editToken}/activities/${itemId}`, { name: '  ' });
  assert.equal(res.status, 400);

  const unchanged = await call('GET', `/api/trips/${trip.editToken}`);
  assert.equal(unchanged.body.activities[0].name, 'Everest flight');
});

test('editing an unknown item is a 404', async () => {
  const trip = await makeTrip();
  const res = await call('PATCH', `/api/trips/${trip.editToken}/stays/no-such-item`, { name: 'Ghost' });
  assert.equal(res.status, 404);
});

test('an item cannot be edited through a different trip token', async () => {
  const tripA = await makeTrip('Trip A');
  const tripB = await makeTrip('Trip B');

  const added = await call('POST', `/api/trips/${tripA.editToken}/stays`, { name: 'A Hotel' });
  const itemId = added.body.stays[0].id;

  const cross = await call('PATCH', `/api/trips/${tripB.editToken}/stays/${itemId}`, { name: 'Hijacked' });
  assert.equal(cross.status, 404, "trip B must not reach trip A's items");

  const unchanged = await call('GET', `/api/trips/${tripA.editToken}`);
  assert.equal(unchanged.body.stays[0].name, 'A Hotel');
});

test('trip details can be edited', async () => {
  const trip = await makeTrip('Draft');
  const res = await call('PATCH', `/api/trips/${trip.editToken}`, {
    name: 'Nepal, October',
    destination: 'Kathmandu & Pokhara',
    startDate: '2026-10-01',
    endDate: '2026-10-14',
    currency: 'NPR',
    notes: 'Bring a warm jacket.',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Nepal, October');
  assert.equal(res.body.destination, 'Kathmandu & Pokhara');
  assert.equal(res.body.startDate, '2026-10-01');
  assert.equal(res.body.currency, 'NPR');
  assert.equal(res.body.notes, 'Bring a warm jacket.');
});

test('a trip cannot be renamed to nothing', async () => {
  const trip = await makeTrip('Keeps Its Name');
  const res = await call('PATCH', `/api/trips/${trip.editToken}`, { name: '   ' });
  assert.equal(res.status, 400);

  const unchanged = await call('GET', `/api/trips/${trip.editToken}`);
  assert.equal(unchanged.body.name, 'Keeps Its Name');
});

test('an item cannot be deleted through a different trip token', async () => {
  const tripA = await makeTrip('Trip A');
  const tripB = await makeTrip('Trip B');

  const added = await call('POST', `/api/trips/${tripA.editToken}/stays`, { name: 'A Hotel' });
  const itemId = added.body.stays[0].id;

  const cross = await call('DELETE', `/api/trips/${tripB.editToken}/stays/${itemId}`);
  assert.equal(cross.status, 404, "trip B must not reach trip A's items");

  const stillThere = await call('GET', `/api/trips/${tripA.editToken}`);
  assert.equal(stillThere.body.stays.length, 1);
});

test('deleting a trip removes its items too', async () => {
  const trip = await makeTrip();
  await call('POST', `/api/trips/${trip.editToken}/stays`, { name: 'Doomed Hotel' });

  const del = await call('DELETE', `/api/trips/${trip.editToken}`);
  assert.equal(del.status, 200);

  const gone = await call('GET', `/api/trips/${trip.editToken}`);
  assert.equal(gone.status, 404);
});

test('new trips default to AUD', async () => {
  const trip = await makeTrip();
  assert.equal(trip.currency, 'AUD');
});

test('expenses are stored, totalled and broken down by category', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/expenses`, {
    name: 'Dinner at Circular Quay',
    category: 'Food & drink',
    date: '2026-10-02',
    location: 'Sydney CBD',
    cost: '64.50',
  });
  const res = await call('POST', `/api/trips/${t}/expenses`, {
    name: 'Airport train',
    category: 'Transport',
    cost: '20.00',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.expenses.length, 2);
  assert.equal(res.body.summary.expenseCents, 8450);
  assert.equal(res.body.summary.totalCents, 8450);
  assert.equal(res.body.summary.byCategory['Food & drink'], 6450);
  assert.equal(res.body.summary.byCategory.Transport, 2000);

  const dinner = res.body.expenses.find((e) => e.name === 'Dinner at Circular Quay');
  assert.equal(dinner.category, 'Food & drink');
  assert.equal(dinner.date, '2026-10-02');
});

test('a stay split between some travellers is only owed by them', async () => {
  const trip = await makeTrip('Sydney');
  const t = trip.editToken;

  const one = await call('POST', `/api/trips/${t}/travellers`, { name: 'Bharat' });
  const two = await call('POST', `/api/trips/${t}/travellers`, { name: 'Ashish' });
  const three = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const id = (body, name) => body.travellers.find((x) => x.name === name).id;
  const bharat = id(three.body, 'Bharat');
  const ashish = id(three.body, 'Ashish');
  const prabin = id(three.body, 'Prabin');
  assert.ok(one.body && two.body);

  await call('POST', `/api/trips/${t}/stays`, {
    name: 'Single room',
    cost: '200.00',
    paidBy: bharat,
    sharedBy: [bharat],
  });
  const res = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Twin room',
    cost: '300.00',
    paidBy: ashish,
    sharedBy: [ashish, prabin],
  });

  assert.equal(res.status, 201);
  const owed = Object.fromEntries(res.body.summary.balances.map((b) => [b.name, b.oweCents]));
  assert.equal(owed.Bharat, 20000);
  assert.equal(owed.Ashish, 15000);
  assert.equal(owed.Prabin, 15000);
  assert.equal(res.body.summary.splitEvenly, false);

  const twin = res.body.stays.find((s) => s.name === 'Twin room');
  assert.deepEqual([...twin.sharedBy].sort(), [ashish, prabin].sort());
});

test('sharedBy ignores ids that are not travellers on this trip', async () => {
  const tripA = await makeTrip('Trip A');
  const tripB = await makeTrip('Trip B');

  const mine = await call('POST', `/api/trips/${tripA.editToken}/travellers`, { name: 'Bharat' });
  const theirs = await call('POST', `/api/trips/${tripB.editToken}/travellers`, { name: 'Outsider' });
  const outsiderId = theirs.body.travellers[0].id;
  assert.ok(mine.body.travellers[0].id);

  const res = await call('POST', `/api/trips/${tripA.editToken}/stays`, {
    name: 'Room',
    cost: '100.00',
    sharedBy: [outsiderId],
  });

  assert.deepEqual(res.body.stays[0].sharedBy, [], "another trip's traveller must be dropped");
  // Falls back to everyone, so the one real traveller owes the whole amount.
  assert.equal(res.body.summary.balances[0].oweCents, 10000);
});

test('removing a traveller clears them from payers and splits', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const added = await call('POST', `/api/trips/${t}/travellers`, { name: 'Bharat' });
  const second = await call('POST', `/api/trips/${t}/travellers`, { name: 'Ashish' });
  const bharat = second.body.travellers.find((x) => x.name === 'Bharat').id;
  const ashish = second.body.travellers.find((x) => x.name === 'Ashish').id;
  assert.ok(added.body);

  await call('POST', `/api/trips/${t}/stays`, {
    name: 'Room',
    cost: '100.00',
    paidBy: bharat,
    sharedBy: [bharat, ashish],
  });

  const after = await call('DELETE', `/api/trips/${t}/travellers/${bharat}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.stays[0].paidBy, '', 'a deleted traveller must not stay listed as payer');
  assert.deepEqual(after.body.stays[0].sharedBy, [ashish]);
  assert.equal(after.body.summary.balances.length, 1);
  assert.equal(after.body.summary.balances[0].oweCents, 10000, 'Ashish now carries the whole room');
});

// These deliberately use a trip with no destination. That path returns before
// any network call, so the suite stays fast and does not fail when
// OpenStreetMap is busy. The live lookup is exercised by hand, not here.
test('suggestions ask for a destination instead of guessing', async () => {
  const trip = await makeTrip();
  await call('PATCH', `/api/trips/${trip.editToken}`, { destination: '' });

  const res = await call('GET', `/api/trips/${trip.editToken}/suggestions`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.places, []);
  assert.match(res.body.error, /destination/i);
});

test('a view token can read suggestions but still cannot write', async () => {
  const trip = await makeTrip();
  await call('PATCH', `/api/trips/${trip.editToken}`, { destination: '' });

  const res = await call('GET', `/api/trips/${trip.viewToken}/suggestions`);
  assert.equal(res.status, 200, 'everyone on the trip should see ideas');
  assert.ok(Array.isArray(res.body.places));

  const write = await call('POST', `/api/trips/${trip.viewToken}/expenses`, { name: 'Sneaky' });
  assert.equal(write.status, 403);
});

test('an unknown token cannot reach the places lookup', async () => {
  // Otherwise the endpoint would be an open proxy to OpenStreetMap for anyone
  // who guessed the URL shape.
  const res = await call('GET', '/api/trips/not-a-real-token/suggestions?q=Sydney');
  assert.equal(res.status, 404);
});

test('health check responds', async () => {
  const res = await call('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// --- reports and settlement -------------------------------------------------

test('the report page is served for both link types', async () => {
  const trip = await makeTrip();

  for (const token of [trip.editToken, trip.viewToken]) {
    const res = await fetch(`${base}/t/${token}/report`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
});

test('the report page never carries a token in its HTML', async () => {
  // The page is a static shell that fetches its data client-side. If it ever
  // becomes server-rendered, this catches an edit token being baked into it.
  const trip = await makeTrip();
  const res = await fetch(`${base}/t/${trip.viewToken}/report`);
  const html = await res.text();

  assert.ok(!html.includes(trip.editToken), 'an edit token must never reach the report HTML');
  assert.ok(!html.includes(trip.viewToken), 'the view token should not be baked in either');
});

test('a view token gets the settlement but still no edit token', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabinId = withA.body.travellers[0].id;
  await call('POST', `/api/trips/${t}/travellers`, { name: 'Sam' });
  await call('POST', `/api/trips/${t}/stays`, { name: 'Hotel', cost: '300.00', paidBy: prabinId });

  const shared = await call('GET', `/api/trips/${trip.viewToken}`);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.editToken, undefined, 'the settlement must not come with edit access');

  const settlement = shared.body.summary.settlement;
  assert.equal(settlement.transfers.length, 1);
  assert.equal(settlement.transfers[0].toName, 'Prabin');
  assert.equal(settlement.transfers[0].cents, 15000);
  assert.equal(settlement.unpaidCents, 0);
});

test('costs with no payer are reported as unattributed, not as debts', async () => {
  // This is the state the real trip is in: costs recorded, nobody marked as
  // having paid. The API must not hand back invented transfers.
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/travellers`, { name: 'Bharat' });
  await call('POST', `/api/trips/${t}/travellers`, { name: 'Ashish' });
  await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const res = await call('POST', `/api/trips/${t}/stays`, { name: 'Cairns', cost: '1591.99' });

  const { settlement, totalCents } = res.body.summary;
  assert.deepEqual(settlement.transfers, []);
  assert.equal(settlement.unpaidCents, totalCents);
  assert.equal(settlement.settled, false);
});

test('assigning a payer takes one field and keeps the rest intact', async () => {
  // The payer chips PATCH nothing but paidBy. If the name were required here,
  // every tap would fail with a 400.
  const trip = await makeTrip();
  const t = trip.editToken;

  const withTraveller = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabinId = withTraveller.body.travellers[0].id;
  const added = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Ballina Palms',
    address: 'Ballina',
    cost: '344.70',
  });
  const stayId = added.body.stays[0].id;

  const patched = await call('PATCH', `/api/trips/${t}/stays/${stayId}`, { paidBy: prabinId });
  assert.equal(patched.status, 200);

  const stay = patched.body.stays[0];
  assert.equal(stay.paidBy, prabinId);
  assert.equal(stay.name, 'Ballina Palms', 'the name must survive a payer-only update');
  assert.equal(stay.address, 'Ballina');
  assert.equal(stay.cost, '344.70');

  // Tapping the same chip again clears the payer.
  const cleared = await call('PATCH', `/api/trips/${t}/stays/${stayId}`, { paidBy: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.stays[0].paidBy, '');
  assert.equal(cleared.body.stays[0].name, 'Ballina Palms');
});

test('an empty name is still rejected when one is sent', async () => {
  const trip = await makeTrip();
  const added = await call('POST', `/api/trips/${trip.editToken}/stays`, { name: 'Hotel' });
  const stayId = added.body.stays[0].id;

  const res = await call('PATCH', `/api/trips/${trip.editToken}/stays/${stayId}`, { name: '  ' });
  assert.equal(res.status, 400);
});

test('unbooked nights are reported with the trip', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('PATCH', `/api/trips/${t}`, { startDate: '2026-09-25', endDate: '2026-10-09' });
  const res = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Cairns',
    checkIn: '2026-09-25',
    checkOut: '2026-10-04',
    cost: '1591.99',
  });

  assert.deepEqual(res.body.summary.gaps, [
    { from: '2026-10-04', to: '2026-10-09', nights: 5 },
  ]);
});

// --- packing list and recorded payments -------------------------------------

test('a read-only link cannot touch the new sections either', async () => {
  const trip = await makeTrip();

  const pack = await call('POST', `/api/trips/${trip.viewToken}/packing`, { name: 'Sunscreen' });
  assert.equal(pack.status, 403);

  const pay = await call('POST', `/api/trips/${trip.viewToken}/payments`, { name: 'Sneaky' });
  assert.equal(pay.status, 403);
});

test('a packing item stores done as a real boolean', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const added = await call('POST', `/api/trips/${t}/packing`, { name: 'Sunscreen' });
  assert.equal(added.status, 201);
  assert.equal(added.body.packing[0].done, false, 'a new item starts unpacked');

  const itemId = added.body.packing[0].id;
  const ticked = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { done: true });
  assert.equal(ticked.status, 200);

  const item = ticked.body.packing[0];
  // The column is TEXT, so this is what proves the encoding boundary works
  // rather than leaking '1' through to the client.
  assert.equal(item.done, true);
  assert.equal(typeof item.done, 'boolean');
  assert.equal(item.name, 'Sunscreen', 'ticking must not disturb the name');

  const unticked = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { done: false });
  assert.equal(unticked.body.packing[0].done, false);
});

test('an unrecognised done value counts as not packed', async () => {
  const trip = await makeTrip();
  const added = await call('POST', `/api/trips/${trip.editToken}/packing`, { name: 'Towel' });
  const itemId = added.body.packing[0].id;

  const res = await call('PATCH', `/api/trips/${trip.editToken}/packing/${itemId}`, { done: 'yes' });
  assert.equal(res.status, 200, 'a strange value must not crash the request');
  assert.equal(res.body.packing[0].done, false);
});

test('a packing list never affects the money', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  await call('POST', `/api/trips/${t}/packing`, { name: 'Tent' });
  const res = await call('POST', `/api/trips/${t}/packing`, { name: 'Boots' });

  assert.equal(res.body.summary.totalCents, 0);
  assert.equal(res.body.summary.balances[0].netCents, 0);
});

test('a recorded payment settles a debt without changing the total', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabinId = withA.body.travellers[0].id;
  const withB = await call('POST', `/api/trips/${t}/travellers`, { name: 'Sam' });
  const samId = withB.body.travellers.find((x) => x.name === 'Sam').id;

  const stay = await call('POST', `/api/trips/${t}/stays`, {
    name: 'Hotel',
    cost: '300.00',
    paidBy: prabinId,
  });
  assert.equal(stay.body.summary.settlement.transfers.length, 1);

  const paid = await call('POST', `/api/trips/${t}/payments`, {
    name: 'Bank transfer',
    cost: '150.00',
    paidBy: samId,
    paidTo: prabinId,
    date: '2026-10-10',
  });

  assert.equal(paid.status, 201);
  const summary = paid.body.summary;
  assert.equal(summary.totalCents, 30000, 'a repayment is not a trip cost');
  assert.equal(summary.stayCents, 30000);
  assert.deepEqual(summary.byCategory, {});
  assert.deepEqual(summary.settlement.transfers, [], 'the debt is settled');
  assert.equal(summary.settlement.settled, true);

  // Everyone's share of the costs is untouched by settling up.
  for (const b of summary.balances) assert.equal(b.oweCents, 15000);
});

test('a payment needs two different, known people and an amount', async () => {
  const trip = await makeTrip();
  const other = await makeTrip('Somewhere else');
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabinId = withA.body.travellers[0].id;
  await call('POST', `/api/trips/${t}/travellers`, { name: 'Sam' });

  const stranger = await call('POST', `/api/trips/${other.editToken}/travellers`, { name: 'Nobody' });
  const strangerId = stranger.body.travellers[0].id;

  const cases = [
    [{ name: 'No recipient', cost: '10', paidBy: prabinId }, 'missing recipient'],
    [{ name: 'No payer', cost: '10', paidTo: prabinId }, 'missing payer'],
    [{ name: 'To themselves', cost: '10', paidBy: prabinId, paidTo: prabinId }, 'same person'],
    [{ name: 'Zero', cost: '0', paidBy: prabinId, paidTo: strangerId }, 'nothing to pay'],
    [{ name: 'Outsider', cost: '10', paidBy: prabinId, paidTo: strangerId }, 'another trip'],
  ];

  for (const [body, why] of cases) {
    const res = await call('POST', `/api/trips/${t}/payments`, body);
    assert.equal(res.status, 400, `rejected: ${why}`);
  }
});

test('removing a traveller removes the payments they were part of', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabinId = withA.body.travellers[0].id;
  const withB = await call('POST', `/api/trips/${t}/travellers`, { name: 'Sam' });
  const samId = withB.body.travellers.find((x) => x.name === 'Sam').id;

  await call('POST', `/api/trips/${t}/stays`, { name: 'Hotel', cost: '300.00', paidBy: prabinId });
  await call('POST', `/api/trips/${t}/payments`, {
    name: 'Transfer', cost: '150.00', paidBy: samId, paidTo: prabinId,
  });

  const after = await call('DELETE', `/api/trips/${t}/travellers/${samId}`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.payments, [], 'a payment with a missing party is meaningless');
  assert.equal(after.body.summary.balances.reduce((sum, b) => sum + b.netCents, 0), 0);
});

test('the day plan reaches a read-only link without the edit token', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('PATCH', `/api/trips/${t}`, { startDate: '2026-09-25', endDate: '2026-09-29' });
  await call('POST', `/api/trips/${t}/stays`, {
    name: 'Cairns', checkIn: '2026-09-25', checkOut: '2026-09-28', cost: '300.00',
  });

  const shared = await call('GET', `/api/trips/${trip.viewToken}`);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.editToken, undefined);

  const days = shared.body.summary.days;
  assert.equal(days.length, 5, '25 to 29 September inclusive');
  assert.equal(days.filter((d) => d.stay).length, 3, 'three nights booked');
  assert.equal(days[0].arriving[0].name, 'Cairns');
  assert.equal(days.find((d) => d.date === '2026-09-28').stay, null, 'checkout day is not a night');
});

// --- reordering and meals ---------------------------------------------------

async function addPacking(token, ...names) {
  let last;
  for (const name of names) last = await call('POST', `/api/trips/${token}/packing`, { name });
  return last.body.packing;
}

test('an item can be moved and the new order sticks', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;
  const items = await addPacking(t, 'Rice', 'Khursani', 'Pressure Cooker', 'Eggs');
  assert.deepEqual(items.map((i) => i.name), ['Rice', 'Khursani', 'Pressure Cooker', 'Eggs']);

  // Last to first.
  const moved = await call('PATCH', `/api/trips/${t}/packing/${items[3].id}/move`, { toIndex: 0 });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.packing.map((i) => i.name),
    ['Eggs', 'Rice', 'Khursani', 'Pressure Cooker']);

  // And it survives a fresh read rather than only looking right in the response.
  const reread = await call('GET', `/api/trips/${t}`);
  assert.deepEqual(reread.body.packing.map((i) => i.name),
    ['Eggs', 'Rice', 'Khursani', 'Pressure Cooker']);
});

test('moving into the middle keeps every item exactly once', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;
  const items = await addPacking(t, 'A', 'B', 'C', 'D', 'E');

  const moved = await call('PATCH', `/api/trips/${t}/packing/${items[0].id}/move`, { toIndex: 2 });
  assert.deepEqual(moved.body.packing.map((i) => i.name), ['B', 'C', 'A', 'D', 'E']);
  assert.equal(new Set(moved.body.packing.map((i) => i.id)).size, 5, 'nothing duplicated or lost');
});

test('an index past the end just means last', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;
  const items = await addPacking(t, 'A', 'B', 'C');

  const moved = await call('PATCH', `/api/trips/${t}/packing/${items[0].id}/move`, { toIndex: 99 });
  assert.deepEqual(moved.body.packing.map((i) => i.name), ['B', 'C', 'A']);

  const back = await call('PATCH', `/api/trips/${t}/packing/${items[0].id}/move`, { toIndex: -5 });
  assert.deepEqual(back.body.packing.map((i) => i.name), ['A', 'B', 'C']);
});

test('reordering one list leaves the others alone', async () => {
  // Every kind shares the trip_items table, so a careless renumber would
  // scramble the stays while sorting the packing list.
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/stays`, { name: 'First stop', cost: '100' });
  await call('POST', `/api/trips/${t}/stays`, { name: 'Second stop', cost: '200' });
  const items = await addPacking(t, 'Rice', 'Eggs');

  const moved = await call('PATCH', `/api/trips/${t}/packing/${items[1].id}/move`, { toIndex: 0 });
  assert.deepEqual(moved.body.packing.map((i) => i.name), ['Eggs', 'Rice']);
  assert.deepEqual(moved.body.stays.map((i) => i.name), ['First stop', 'Second stop']);
});

test('a move is rejected without an edit link, a real item, or an index', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;
  const items = await addPacking(t, 'Rice', 'Eggs');

  const readOnly = await call('PATCH', `/api/trips/${trip.viewToken}/packing/${items[0].id}/move`,
    { toIndex: 1 });
  assert.equal(readOnly.status, 403);

  const missing = await call('PATCH', `/api/trips/${t}/packing/nope/move`, { toIndex: 0 });
  assert.equal(missing.status, 404);

  const noIndex = await call('PATCH', `/api/trips/${t}/packing/${items[0].id}/move`, {});
  assert.equal(noIndex.status, 400);

  const notANumber = await call('PATCH', `/api/trips/${t}/packing/${items[0].id}/move`,
    { toIndex: 'first' });
  assert.equal(notANumber.status, 400);
});

test("an item cannot be moved through another trip's link", async () => {
  const tripA = await makeTrip('Trip A');
  const tripB = await makeTrip('Trip B');
  const items = await addPacking(tripA.editToken, 'Rice', 'Eggs');

  const cross = await call('PATCH', `/api/trips/${tripB.editToken}/packing/${items[0].id}/move`,
    { toIndex: 1 });
  assert.equal(cross.status, 404);

  const untouched = await call('GET', `/api/trips/${tripA.editToken}`);
  assert.deepEqual(untouched.body.packing.map((i) => i.name), ['Rice', 'Eggs']);
});

test('meals are planned per day and cost nothing', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const added = await call('POST', `/api/trips/${t}/meals`, {
    name: 'Dal bhat',
    date: '2026-09-29',
    slot: 'Dinner',
    location: 'Cairns Airbnb',
  });

  assert.equal(added.status, 201);
  const meal = added.body.meals[0];
  assert.equal(meal.name, 'Dal bhat');
  assert.equal(meal.slot, 'Dinner');
  assert.equal(meal.date, '2026-09-29');
  assert.equal(meal.location, 'Cairns Airbnb');

  // A plan of what to eat is not money spent on food.
  assert.equal(added.body.summary.totalCents, 0);
  assert.equal(added.body.summary.balances[0].netCents, 0);
  assert.deepEqual(added.body.summary.byCategory, {});
});

test('a meal shows up on its day in the day plan', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('PATCH', `/api/trips/${t}`, { startDate: '2026-09-25', endDate: '2026-09-27' });
  await call('POST', `/api/trips/${t}/meals`, { name: 'Porridge', date: '2026-09-26', slot: 'Breakfast' });
  const res = await call('POST', `/api/trips/${t}/meals`, { name: 'Noodles', date: '2026-09-26', slot: 'Lunch' });

  const day = res.body.summary.days.find((d) => d.date === '2026-09-26');
  assert.deepEqual(day.meals.map((m) => m.name), ['Porridge', 'Noodles']);
  assert.equal(day.costCents, 0, 'meals carry no cost');

  const quiet = res.body.summary.days.find((d) => d.date === '2026-09-25');
  assert.deepEqual(quiet.meals, []);
});

test('a meal can be dated later and still widens the day plan', async () => {
  // A meal on a day outside the stays should still get a row rather than vanish.
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/stays`, {
    name: 'Cairns', checkIn: '2026-09-25', checkOut: '2026-09-26', cost: '100',
  });
  const res = await call('POST', `/api/trips/${t}/meals`, { name: 'Farewell dinner', date: '2026-09-28' });

  const days = res.body.summary.days;
  assert.equal(days.at(-1).date, '2026-09-28');
  assert.equal(days.at(-1).meals[0].name, 'Farewell dinner');
});

test('a read-only link cannot add a meal', async () => {
  const trip = await makeTrip();
  const res = await call('POST', `/api/trips/${trip.viewToken}/meals`, { name: 'Sneaky supper' });
  assert.equal(res.status, 403);
});

// --- who is bringing what ---------------------------------------------------

test('a packing item can be assigned to someone and reassigned', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Bharat' });
  const bharat = withA.body.travellers[0].id;
  const withB = await call('POST', `/api/trips/${t}/travellers`, { name: 'Ashish' });
  const ashish = withB.body.travellers.find((x) => x.name === 'Ashish').id;

  const added = await call('POST', `/api/trips/${t}/packing`, { name: 'Pressure Cooker' });
  const itemId = added.body.packing[0].id;
  assert.equal(added.body.packing[0].assignedTo, '', 'nobody is bringing it yet');

  const assigned = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { assignedTo: bharat });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.packing[0].assignedTo, bharat);
  assert.equal(assigned.body.packing[0].name, 'Pressure Cooker', 'the name survives');

  const moved = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { assignedTo: ashish });
  assert.equal(moved.body.packing[0].assignedTo, ashish);

  // Tapping the selected chip again sends an empty string.
  const cleared = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { assignedTo: '' });
  assert.equal(cleared.body.packing[0].assignedTo, '');
});

test('assigning an item leaves its packed state alone', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabin = withA.body.travellers[0].id;

  const added = await call('POST', `/api/trips/${t}/packing`, { name: 'Rice Cooker' });
  const itemId = added.body.packing[0].id;
  await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { done: true });

  // done and assignedTo share nothing, but both are single-field patches on the
  // same row, so it is worth pinning that one cannot clobber the other.
  const assigned = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { assignedTo: prabin });
  assert.equal(assigned.body.packing[0].done, true, 'still packed');
  assert.equal(assigned.body.packing[0].assignedTo, prabin);

  const ticked = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { done: false });
  assert.equal(ticked.body.packing[0].assignedTo, prabin, 'still assigned');
  assert.equal(ticked.body.packing[0].done, false);
});

test('an item cannot be assigned to someone on another trip', async () => {
  const trip = await makeTrip();
  const other = await makeTrip('Somewhere else');

  const stranger = await call('POST', `/api/trips/${other.editToken}/travellers`, { name: 'Nobody' });
  const strangerId = stranger.body.travellers[0].id;

  const added = await call('POST', `/api/trips/${trip.editToken}/packing`, { name: 'Tent' });
  const itemId = added.body.packing[0].id;

  const res = await call('PATCH', `/api/trips/${trip.editToken}/packing/${itemId}`,
    { assignedTo: strangerId });

  // The id is stored but names nobody on this trip, so the UI shows it as
  // unassigned rather than attributing it to a stranger.
  const reread = await call('GET', `/api/trips/${trip.editToken}`);
  const names = new Set(reread.body.travellers.map((x) => x.id));
  assert.ok(!names.has(reread.body.packing[0].assignedTo),
    'an outsider must never read as one of the travellers');
  assert.equal(res.status, 200);
});

test('removing a traveller unassigns what they were bringing', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Bharat' });
  const bharat = withA.body.travellers[0].id;

  const added = await call('POST', `/api/trips/${t}/packing`, { name: 'Knife and Chopping Board' });
  const itemId = added.body.packing[0].id;
  await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { assignedTo: bharat });

  const after = await call('DELETE', `/api/trips/${t}/travellers/${bharat}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.packing.length, 1, 'the item itself stays on the list');
  assert.equal(after.body.packing[0].assignedTo, '', 'but nobody is bringing it now');
});

test('a read-only link cannot assign a packing item', async () => {
  const trip = await makeTrip();
  const withA = await call('POST', `/api/trips/${trip.editToken}/travellers`, { name: 'Prabin' });
  const prabin = withA.body.travellers[0].id;
  const added = await call('POST', `/api/trips/${trip.editToken}/packing`, { name: 'Towel' });

  const res = await call('PATCH', `/api/trips/${trip.viewToken}/packing/${added.body.packing[0].id}`,
    { assignedTo: prabin });
  assert.equal(res.status, 403);
});

// --- packing categories -----------------------------------------------------

test('a packing item carries a category', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  const added = await call('POST', `/api/trips/${t}/packing`, {
    name: 'Pressure Cooker',
    group: 'Cooking gear',
  });
  assert.equal(added.status, 201);
  assert.equal(added.body.packing[0].group, 'Cooking gear');

  const itemId = added.body.packing[0].id;
  const moved = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { group: 'Gear & other' });
  assert.equal(moved.body.packing[0].group, 'Gear & other');

  const cleared = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { group: '' });
  assert.equal(cleared.body.packing[0].group, '');
  assert.equal(cleared.body.packing[0].name, 'Pressure Cooker', 'the name survives');
});

test('category, packed state and assignment do not disturb each other', async () => {
  // All three are single-field patches on the same row, and two of them share a
  // column with something else, so it is worth pinning that they stay separate.
  const trip = await makeTrip();
  const t = trip.editToken;

  const withA = await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const prabin = withA.body.travellers[0].id;

  const added = await call('POST', `/api/trips/${t}/packing`, { name: 'Rice - 10 kg' });
  const itemId = added.body.packing[0].id;

  await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { group: 'Dry goods' });
  await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { assignedTo: prabin });
  const ticked = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { done: true });

  const item = ticked.body.packing[0];
  assert.equal(item.group, 'Dry goods');
  assert.equal(item.assignedTo, prabin);
  assert.equal(item.done, true);
  assert.equal(typeof item.done, 'boolean', 'done must not leak its stored form');

  // And changing the category leaves the other two alone.
  const regrouped = await call('PATCH', `/api/trips/${t}/packing/${itemId}`, { group: 'Fresh' });
  assert.equal(regrouped.body.packing[0].done, true);
  assert.equal(regrouped.body.packing[0].assignedTo, prabin);
  assert.equal(regrouped.body.packing[0].group, 'Fresh');
});

test('a category can be anything, not just the suggested ones', async () => {
  const trip = await makeTrip();
  const added = await call('POST', `/api/trips/${trip.editToken}/packing`, {
    name: 'Fishing rod',
    group: 'Fishing',
  });
  assert.equal(added.body.packing[0].group, 'Fishing');
});

test('categories never touch the money', async () => {
  const trip = await makeTrip();
  const t = trip.editToken;

  await call('POST', `/api/trips/${t}/travellers`, { name: 'Prabin' });
  const res = await call('POST', `/api/trips/${t}/packing`, {
    name: 'Karai',
    group: 'Cooking gear',
  });

  assert.equal(res.body.summary.totalCents, 0);
  assert.deepEqual(res.body.summary.byCategory, {}, 'a packing category is not an expense category');
});

test('a read-only link cannot recategorise an item', async () => {
  const trip = await makeTrip();
  const added = await call('POST', `/api/trips/${trip.editToken}/packing`, { name: 'Tent' });
  const res = await call('PATCH', `/api/trips/${trip.viewToken}/packing/${added.body.packing[0].id}`,
    { group: 'Gear & other' });
  assert.equal(res.status, 403);
});
