import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as store from './store.js';
import * as places from './places.js';
import {
  summarise,
  nightsBetween,
  formatCents,
  settle,
  accommodationGaps,
  dayPlan,
  toCents,
} from './costs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '256kb' }));
app.use(express.static(join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Access control
//
// A trip is reached by one of two tokens. The edit token grants writes; the
// view token is read-only. Responses never include the edit token unless the
// caller presented it, otherwise forwarding a "view" link would hand over
// write access.
// ---------------------------------------------------------------------------

function present(trip, canEdit) {
  const summary = summarise(trip);
  const stays = trip.stays.map((s) => ({ ...s, nights: nightsBetween(s.checkIn, s.checkOut) }));
  return {
    ...trip,
    stays,
    editToken: canEdit ? trip.editToken : undefined,
    canEdit,
    // Settlement and gaps derive only from data a view token already receives,
    // so including them here exposes nothing new to a read-only link.
    summary: {
      ...summary,
      settlement: settle(summary.balances),
      gaps: accommodationGaps(trip),
      days: dayPlan(trip),
    },
  };
}

async function resolve(req, res, next) {
  try {
    const found = await store.findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Trip not found' });
    req.trip = found.trip;
    req.canEdit = found.canEdit;
    next();
  } catch (err) {
    next(err);
  }
}

function requireEdit(req, res, next) {
  if (!req.canEdit) return res.status(403).json({ error: 'This is a read-only link' });
  next();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Only http/https map links are accepted. A javascript: URL rendered into an
// href would execute when a trip member clicks it.
function safeMapUrl(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

function cleanText(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

const COLLECTION_FIELDS = {
  stays: ['name', 'address', 'checkIn', 'checkOut', 'cost', 'bookingRef', 'paidBy', 'notes'],
  activities: ['name', 'date', 'time', 'location', 'cost', 'paidBy', 'notes'],
  travellers: ['name', 'email', 'notes'],
  expenses: ['name', 'category', 'date', 'location', 'cost', 'paidBy', 'notes'],
  payments: ['name', 'date', 'cost', 'paidBy', 'paidTo', 'notes'],
  // `done` is missing on purpose: cleanText would turn a boolean into a string
  // and store "false" as a truthy value. It is handled explicitly below.
  packing: ['name', 'assignedTo', 'notes'],
  // Meals carry no cost: what you spend on food is an expense, which is a
  // separate thing from a plan of what you are going to eat.
  meals: ['name', 'date', 'slot', 'time', 'location', 'notes'],
};

// Collections whose items carry a cost that can be split across a subset of the
// group. Travellers are people, not costs, so they are not in this set.
//
// Payments must never be added here. `paidTo` and `sharedBy` share the
// shared_by column, so running cleanSharedBy over a payment would overwrite its
// recipient with an empty list, leaving an inert row and a settlement that
// quietly never shrinks.
const SPLITTABLE = new Set(['stays', 'activities', 'expenses']);

// The list of people a cost is split between arrives as an array of traveller
// ids (or a comma-separated string). Ids are checked against the trip's actual
// travellers so a request cannot attach a cost to an id from another trip.
function cleanSharedBy(value, travellers) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const known = new Set(travellers.map((t) => t.id));
  const seen = new Set();
  for (const entry of raw) {
    const id = String(entry ?? '').trim();
    if (id && known.has(id)) seen.add(id);
  }
  return [...seen];
}

// `requireName` is true when creating, where a name must be supplied, and false
// when patching, where an absent field means "leave it as it is".
function buildItem(collection, body, trip, { requireName = true } = {}) {
  const allowed = COLLECTION_FIELDS[collection];
  if (!allowed) return { error: 'Unknown section' };

  const item = {};
  for (const field of allowed) {
    if (field in body) item[field] = cleanText(body[field]);
  }

  // A PATCH may carry a single field — assigning a payer sends only `paidBy` —
  // so an absent name means "leave it alone", not "clear it". Sending an empty
  // name is still rejected either way.
  if ((requireName || 'name' in body) && !item.name) return { error: 'Name is required' };

  if ('mapUrl' in body) {
    const url = safeMapUrl(body.mapUrl);
    if (url === null) return { error: 'Map link must be a valid http(s) URL' };
    item.mapUrl = url;
  }

  if ('sharedBy' in body && SPLITTABLE.has(collection)) {
    // Stored as a comma-separated column; an empty value means "everyone", which
    // is how items behaved before per-item splitting existed.
    item.sharedBy = cleanSharedBy(body.sharedBy, trip.travellers).join(',');
  }

  if (collection === 'packing' && 'done' in body) {
    // The column is TEXT like every other one, so the boolean is encoded here
    // and decoded in rowToItem. Anything that isn't a recognised "yes" counts as
    // not done, so a stray value can never leave an item ambiguously ticked.
    const done = body.done;
    item.done = done === true || done === 'true' || done === '1' || done === 1 ? '1' : '';
  }

  if (collection === 'payments') {
    // A payment moves money between two people, so both ends have to be real and
    // distinct. Without this a typo would produce a row that silently does
    // nothing, since summarise ignores payments it cannot resolve.
    const known = new Set(trip.travellers.map((t) => t.id));

    if (requireName || 'paidBy' in body) {
      if (!item.paidBy || !known.has(item.paidBy)) return { error: 'Who paid?' };
    }
    if (requireName || 'paidTo' in body) {
      if (!item.paidTo || !known.has(item.paidTo)) return { error: 'Who were they paying?' };
    }
    if (item.paidBy && item.paidTo && item.paidBy === item.paidTo) {
      return { error: 'A payment needs two different people' };
    }
    if ((requireName || 'cost' in body) && toCents(item.cost) <= 0) {
      return { error: 'A payment needs an amount' };
    }
  }

  return { item };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// req.trip is the snapshot taken by resolve(). After a write it is stale, so
// mutation routes reload the trip before serializing the response.
async function reload(req) {
  const found = await store.findByToken(req.params.token);
  return found ? found.trip : req.trip;
}

app.get('/api/trips', async (req, res, next) => {
  // The index only exposes view links; edit tokens stay server-side until the
  // owner opens the trip with one.
  try {
    const trips = await store.listTrips();
    res.json(
      trips.map((t) => ({
        id: t.id,
        name: t.name,
        destination: t.destination,
        startDate: t.startDate,
        endDate: t.endDate,
        viewToken: t.viewToken,
        editToken: t.editToken,
        totalCents: summarise(t).totalCents,
        currency: t.currency,
      }))
    );
  } catch (err) {
    next(err);
  }
});

app.post('/api/trips', async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: 'Trip name is required' });
    const trip = await store.createTrip({
      name,
      destination: cleanText(req.body?.destination, 120),
      startDate: cleanText(req.body?.startDate, 20),
      endDate: cleanText(req.body?.endDate, 20),
      notes: cleanText(req.body?.notes, 2000),
    });
    res.status(201).json(present(trip, true));
  } catch (err) {
    next(err);
  }
});

app.get('/api/trips/:token', resolve, (req, res) => {
  res.json(present(req.trip, req.canEdit));
});

// Place suggestions near the trip's destination. Read-only, so a view token is
// enough — everyone on the trip should be able to browse ideas even if only the
// owner can add them. `q` overrides the destination, so you can look around a
// specific neighbourhood instead of the whole city.
app.get('/api/trips/:token/suggestions', resolve, async (req, res, next) => {
  try {
    const query = cleanText(req.query.q, 120) || cleanText(req.trip.destination, 120);
    if (!query) {
      return res.json({
        configured: places.isConfigured(),
        places: [],
        query: '',
        error: 'Set a destination on the trip, or search for a place.',
      });
    }
    const result = await places.search(query);
    res.json({ ...result, query });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/trips/:token', resolve, requireEdit, async (req, res, next) => {
  try {
    const fields = {};
    for (const key of ['name', 'destination', 'startDate', 'endDate', 'notes', 'currency']) {
      if (key in req.body) fields[key] = cleanText(req.body[key], key === 'notes' ? 2000 : 120);
    }
    // Every other field may be blanked, but a nameless trip has nothing to show
    // in the heading or the index, so an empty name is rejected rather than saved.
    if ('name' in fields && !fields.name) {
      return res.status(400).json({ error: 'Trip name is required' });
    }
    const trip = await store.updateTrip(req.trip.id, fields);
    res.json(present(trip, true));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/trips/:token', resolve, requireEdit, async (req, res, next) => {
  try {
    await store.deleteTrip(req.trip.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/trips/:token/:collection', resolve, requireEdit, async (req, res, next) => {
  try {
    const { collection } = req.params;
    const { item, error } = buildItem(collection, req.body || {}, req.trip);
    if (error) return res.status(400).json({ error });
    const created = await store.addItem(req.trip.id, collection, item);
    if (!created) return res.status(400).json({ error: 'Unknown section' });
    res.status(201).json(present(await reload(req), true));
  } catch (err) {
    next(err);
  }
});

// Reordering. Registered before the :itemId route below, otherwise "move" would
// be matched as an item id and the request would 404.
app.patch('/api/trips/:token/:collection/:itemId/move', resolve, requireEdit, async (req, res, next) => {
  try {
    const { collection, itemId } = req.params;
    const toIndex = Number(req.body?.toIndex);
    if (!Number.isFinite(toIndex)) return res.status(400).json({ error: 'Where should it go?' });

    const moved = await store.moveItem(req.trip.id, collection, itemId, toIndex);
    if (!moved) return res.status(404).json({ error: 'Item not found' });
    res.json(present(await reload(req), true));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/trips/:token/:collection/:itemId', resolve, requireEdit, async (req, res, next) => {
  try {
    const { collection, itemId } = req.params;
    const { item, error } = buildItem(collection, req.body || {}, req.trip, { requireName: false });
    if (error) return res.status(400).json({ error });
    const updated = await store.updateItem(req.trip.id, collection, itemId, item);
    if (!updated) return res.status(404).json({ error: 'Item not found' });
    res.json(present(await reload(req), true));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/trips/:token/:collection/:itemId', resolve, requireEdit, async (req, res, next) => {
  try {
    const { collection, itemId } = req.params;
    const ok = await store.removeItem(req.trip.id, collection, itemId);
    if (!ok) return res.status(404).json({ error: 'Item not found' });
    res.json(present(await reload(req), true));
  } catch (err) {
    next(err);
  }
});

// Render pings this to confirm the instance is alive.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Share links are client-rendered; serve the app shell for /t/<token>.
app.get('/t/:token', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'trip.html'));
});

// The report page fetches its data from /api/trips/:token like the trip page
// does, so it inherits that route's access control rather than adding its own.
// Serving a static shell here means no token is ever rendered into the HTML.
app.get('/t/:token/report', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'report.html'));
});

// Database errors surface here. The message is logged but never returned to the
// client, since driver errors can echo back SQL and connection details.
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.path} failed:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const port = process.env.PORT || 3000;

// Only auto-start when run directly (npm start). Tests import `app` and bind
// their own port, so importing this module must not open a listener.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Only start listening once the schema is in place; otherwise the first
  // request races the CREATE TABLE statements.
  store
    .load()
    .then(() => {
      app.listen(port, () => {
        console.log(`Itinerary planner listening on http://localhost:${port}`);
      });
    })
    .catch((err) => {
      console.error('Could not initialise the database:', err.message);
      process.exit(1);
    });
}

export { app, formatCents };
