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

test('health check responds', async () => {
  const res = await call('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});
