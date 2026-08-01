import { randomBytes } from 'node:crypto';
import pg from 'pg';

// All persistence lives behind this module. The server imports these functions
// and knows nothing about the storage engine.

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill in the connection string.'
  );
}

// Render's managed Postgres presents a certificate signed by a root that is not
// in Node's bundled CA store, so verification is disabled for that host. The
// connection is still TLS-encrypted. A self-hosted Postgres with a normal
// public certificate should use ssl: true instead.
const needsRelaxedSsl = /\.render\.com/.test(connectionString);

const pool = new pg.Pool({
  connectionString,
  ssl: needsRelaxedSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// A pool error on an idle client (network blip, database restart) is emitted on
// the pool itself. Without a listener Node treats it as an unhandled 'error'
// event and kills the process.
pool.on('error', (err) => {
  console.error('Idle Postgres client error:', err.message);
});

// URL-safe token. 18 bytes ~ 144 bits, far past guessing range for a share link.
function token() {
  return randomBytes(18).toString('base64url');
}

function id() {
  return randomBytes(8).toString('base64url');
}

export async function load() {
  // Items live in one table with a `kind` discriminator rather than three
  // near-identical tables; the columns are largely shared and it keeps the
  // per-collection queries uniform.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id           TEXT PRIMARY KEY,
      view_token   TEXT UNIQUE NOT NULL,
      edit_token   TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      destination  TEXT NOT NULL DEFAULT '',
      start_date   TEXT NOT NULL DEFAULT '',
      end_date     TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      currency     TEXT NOT NULL DEFAULT 'USD',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trip_items (
      id          TEXT PRIMARY KEY,
      trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('stays', 'activities', 'travellers')),
      position    BIGSERIAL,
      name        TEXT NOT NULL DEFAULT '',
      address     TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      check_in    TEXT NOT NULL DEFAULT '',
      check_out   TEXT NOT NULL DEFAULT '',
      item_date   TEXT NOT NULL DEFAULT '',
      item_time   TEXT NOT NULL DEFAULT '',
      cost        TEXT NOT NULL DEFAULT '',
      booking_ref TEXT NOT NULL DEFAULT '',
      paid_by     TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      map_url     TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS trip_items_trip_kind_idx
      ON trip_items (trip_id, kind, position);
  `);
}

// Maps a trip_items row to the shape the API and frontend already expect.
function rowToItem(row) {
  const item = { id: row.id, name: row.name };
  if (row.kind === 'stays') {
    Object.assign(item, {
      address: row.address,
      checkIn: row.check_in,
      checkOut: row.check_out,
      cost: row.cost,
      bookingRef: row.booking_ref,
      paidBy: row.paid_by,
    });
  } else if (row.kind === 'activities') {
    Object.assign(item, {
      date: row.item_date,
      time: row.item_time,
      location: row.location,
      cost: row.cost,
      paidBy: row.paid_by,
    });
  } else {
    item.email = row.email;
  }
  if (row.map_url) item.mapUrl = row.map_url;
  if (row.notes) item.notes = row.notes;
  return item;
}

// Field name in the API -> column name. Anything not listed here is ignored,
// so a client cannot write to columns it was never meant to touch.
const COLUMNS = {
  name: 'name',
  address: 'address',
  location: 'location',
  checkIn: 'check_in',
  checkOut: 'check_out',
  date: 'item_date',
  time: 'item_time',
  cost: 'cost',
  bookingRef: 'booking_ref',
  paidBy: 'paid_by',
  email: 'email',
  mapUrl: 'map_url',
  notes: 'notes',
};

function rowToTrip(row, items) {
  return {
    id: row.id,
    viewToken: row.view_token,
    editToken: row.edit_token,
    name: row.name,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    notes: row.notes,
    currency: row.currency,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    stays: items.filter((i) => i.kind === 'stays').map(rowToItem),
    activities: items.filter((i) => i.kind === 'activities').map(rowToItem),
    travellers: items.filter((i) => i.kind === 'travellers').map(rowToItem),
  };
}

async function hydrate(tripRow) {
  const { rows } = await pool.query(
    'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY position',
    [tripRow.id]
  );
  return rowToTrip(tripRow, rows);
}

export async function createTrip({ name, destination, startDate, endDate, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO trips (id, view_token, edit_token, name, destination, start_date, end_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [id(), token(), token(), name, destination || '', startDate || '', endDate || '', notes || '']
  );
  return rowToTrip(rows[0], []);
}

// Share links carry a token, not the trip id. One indexed lookup covers both
// token types and tells us which access level was presented.
export async function findByToken(tok) {
  const { rows } = await pool.query(
    'SELECT * FROM trips WHERE view_token = $1 OR edit_token = $1',
    [tok]
  );
  if (!rows.length) return null;
  const trip = await hydrate(rows[0]);
  return { trip, canEdit: rows[0].edit_token === tok };
}

export async function listTrips() {
  const { rows } = await pool.query('SELECT * FROM trips ORDER BY created_at DESC');
  return Promise.all(rows.map(hydrate));
}

export async function updateTrip(tripId, fields) {
  const map = {
    name: 'name',
    destination: 'destination',
    startDate: 'start_date',
    endDate: 'end_date',
    notes: 'notes',
    currency: 'currency',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (key in fields) {
      values.push(fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) {
    const { rows } = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
    return rows.length ? hydrate(rows[0]) : null;
  }
  values.push(tripId);
  const { rows } = await pool.query(
    `UPDATE trips SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows.length ? hydrate(rows[0]) : null;
}

export async function deleteTrip(tripId) {
  // trip_items rows go with it via ON DELETE CASCADE.
  const { rowCount } = await pool.query('DELETE FROM trips WHERE id = $1', [tripId]);
  return rowCount > 0;
}

const COLLECTIONS = new Set(['stays', 'activities', 'travellers']);

export async function addItem(tripId, collection, item) {
  if (!COLLECTIONS.has(collection)) return null;

  const columns = ['id', 'trip_id', 'kind'];
  const values = [id(), tripId, collection];
  for (const [field, column] of Object.entries(COLUMNS)) {
    if (field in item && item[field] !== undefined) {
      columns.push(column);
      values.push(item[field]);
    }
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO trip_items (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return rowToItem(rows[0]);
}

export async function updateItem(tripId, collection, itemId, fields) {
  if (!COLLECTIONS.has(collection)) return null;

  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(COLUMNS)) {
    if (field in fields && fields[field] !== undefined) {
      values.push(fields[field]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (!sets.length) return null;

  // trip_id and kind are in the WHERE clause so an item id from one trip can
  // never be updated through another trip's token.
  values.push(itemId, tripId, collection);
  const { rows } = await pool.query(
    `UPDATE trip_items SET ${sets.join(', ')}
     WHERE id = $${values.length - 2} AND trip_id = $${values.length - 1} AND kind = $${values.length}
     RETURNING *`,
    values
  );
  return rows.length ? rowToItem(rows[0]) : null;
}

export async function removeItem(tripId, collection, itemId) {
  if (!COLLECTIONS.has(collection)) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM trip_items WHERE id = $1 AND trip_id = $2 AND kind = $3',
    [itemId, tripId, collection]
  );
  return rowCount > 0;
}

export async function close() {
  await pool.end();
}
