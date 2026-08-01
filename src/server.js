import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as store from './store.js';
import { summarise, nightsBetween, formatCents } from './costs.js';

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
    summary,
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
};

function buildItem(collection, body) {
  const allowed = COLLECTION_FIELDS[collection];
  if (!allowed) return { error: 'Unknown section' };

  const item = {};
  for (const field of allowed) {
    if (field in body) item[field] = cleanText(body[field]);
  }

  if (!item.name) return { error: 'Name is required' };

  if ('mapUrl' in body) {
    const url = safeMapUrl(body.mapUrl);
    if (url === null) return { error: 'Map link must be a valid http(s) URL' };
    item.mapUrl = url;
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

app.patch('/api/trips/:token', resolve, requireEdit, async (req, res, next) => {
  try {
    const fields = {};
    for (const key of ['name', 'destination', 'startDate', 'endDate', 'notes', 'currency']) {
      if (key in req.body) fields[key] = cleanText(req.body[key], key === 'notes' ? 2000 : 120);
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
    const { item, error } = buildItem(collection, req.body || {});
    if (error) return res.status(400).json({ error });
    const created = await store.addItem(req.trip.id, collection, item);
    if (!created) return res.status(400).json({ error: 'Unknown section' });
    res.status(201).json(present(await reload(req), true));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/trips/:token/:collection/:itemId', resolve, requireEdit, async (req, res, next) => {
  try {
    const { collection, itemId } = req.params;
    const { item, error } = buildItem(collection, req.body || {});
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
