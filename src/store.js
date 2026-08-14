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
  // Items live in one table with a `kind` discriminator rather than four
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
      currency     TEXT NOT NULL DEFAULT 'AUD',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trip_items (
      id          TEXT PRIMARY KEY,
      trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      -- Keep this list in step with the CHECK in the migration block below: this
      -- one only runs for a brand new database, that one fixes an existing one.
      kind        TEXT NOT NULL CHECK (kind IN ('stays', 'activities', 'travellers', 'expenses', 'payments', 'packing', 'meals')),
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
      shared_by   TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      map_url     TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS trip_items_trip_kind_idx
      ON trip_items (trip_id, kind, position);
  `);

  // Migrations for databases created before these columns existed. CREATE TABLE
  // IF NOT EXISTS silently does nothing on an existing table, so new columns and
  // a widened CHECK constraint have to be applied separately. Every statement
  // here is idempotent so boot stays safe to repeat.
  await pool.query(`
    ALTER TABLE trips ALTER COLUMN currency SET DEFAULT 'AUD';
    ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS shared_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE trip_items ADD COLUMN IF NOT EXISTS category  TEXT NOT NULL DEFAULT '';
    ALTER TABLE trip_items DROP CONSTRAINT IF EXISTS trip_items_kind_check;
    ALTER TABLE trip_items ADD CONSTRAINT trip_items_kind_check
      CHECK (kind IN ('stays', 'activities', 'travellers', 'expenses', 'payments', 'packing', 'meals'));
  `);
}

// Traveller ids sharing a cost are kept as one comma-separated column rather
// than a join table. Ids are base64url, so they never contain a comma.
function parseSharedBy(value) {
  return String(value || '').split(',').filter(Boolean);
}

export function serialiseSharedBy(ids) {
  return (Array.isArray(ids) ? ids : parseSharedBy(ids)).filter(Boolean).join(',');
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
      sharedBy: parseSharedBy(row.shared_by),
    });
  } else if (row.kind === 'activities') {
    Object.assign(item, {
      date: row.item_date,
      time: row.item_time,
      location: row.location,
      cost: row.cost,
      paidBy: row.paid_by,
      sharedBy: parseSharedBy(row.shared_by),
    });
  } else if (row.kind === 'expenses') {
    Object.assign(item, {
      date: row.item_date,
      category: row.category,
      location: row.location,
      cost: row.cost,
      paidBy: row.paid_by,
      sharedBy: parseSharedBy(row.shared_by),
    });
  } else if (row.kind === 'payments') {
    // A repayment between two people. `shared_by` holds a single traveller id
    // here rather than a list, so it is read raw: reusing that column means
    // forgetTraveller() already knows to clean it up.
    Object.assign(item, {
      date: row.item_date,
      cost: row.cost,
      paidBy: row.paid_by,
      paidTo: row.shared_by,
    });
  } else if (row.kind === 'packing') {
    // Done-state lives in `category` as '1' or ''. Every column in this table is
    // TEXT and cleanText() stringifies everything, so a real boolean column
    // would reject the empty string an unticked box sends. The conversion is
    // confined to this line and the matching one in buildItem().
    Object.assign(item, {
      done: row.category === '1',
      assignedTo: row.paid_by,
    });
  } else if (row.kind === 'meals') {
    // What you plan to eat and when. `category` holds the sitting — breakfast,
    // lunch, dinner or anything else typed in — and there is no cost: money
    // spent on food is an expense, which is a different thing from a plan.
    Object.assign(item, {
      date: row.item_date,
      slot: row.category,
      time: row.item_time,
      location: row.location,
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
  sharedBy: 'shared_by',
  category: 'category',
  // Several API fields deliberately share a column: paidTo/sharedBy both write
  // shared_by, and done/slot/category all write category. That is only safe
  // because COLLECTION_FIELDS in server.js never offers two of them to the same
  // kind. Adding `category` to packing or meals, or `sharedBy` to payments,
  // would silently overwrite the other field.
  paidTo: 'shared_by',
  done: 'category',
  slot: 'category',
  // Who is bringing a packing item. Shares paid_by with the payer of a cost,
  // which also means forgetTraveller() already clears it when someone leaves.
  assignedTo: 'paid_by',
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
    expenses: items.filter((i) => i.kind === 'expenses').map(rowToItem),
    payments: items.filter((i) => i.kind === 'payments').map(rowToItem),
    packing: items.filter((i) => i.kind === 'packing').map(rowToItem),
    meals: items.filter((i) => i.kind === 'meals').map(rowToItem),
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

const COLLECTIONS = new Set([
  'stays',
  'activities',
  'travellers',
  'expenses',
  'payments',
  'packing',
  'meals',
]);

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
  if (rowCount > 0 && collection === 'travellers') await forgetTraveller(tripId, itemId);
  return rowCount > 0;
}

// Puts `itemId` at `toIndex` within its own collection and renumbers the rest.
//
// `position` starts life as a BIGSERIAL, so values are unique but arbitrary and
// shared across every kind in the table. Rewriting the whole collection's
// positions as 0..n-1 is the simplest thing that stays correct: the lists are
// short, and it means the numbers can never drift or collide after repeated
// moves. It runs in a transaction so a failure halfway cannot leave the list
// half-renumbered.
export async function moveItem(tripId, collection, itemId, toIndex) {
  if (!COLLECTIONS.has(collection)) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Locked so a concurrent move can't read the same order and write a
    // conflicting one.
    const { rows } = await client.query(
      `SELECT id FROM trip_items
       WHERE trip_id = $1 AND kind = $2
       ORDER BY position
       FOR UPDATE`,
      [tripId, collection]
    );

    const order = rows.map((r) => r.id);
    const from = order.indexOf(itemId);
    if (from === -1) {
      await client.query('ROLLBACK');
      return false;
    }

    // Clamp rather than reject: an index past the end plainly means "put it
    // last", and that is what a drag to the bottom of the list sends.
    const to = Math.max(0, Math.min(order.length - 1, Math.trunc(toIndex)));
    order.splice(to, 0, ...order.splice(from, 1));

    for (const [index, id2] of order.entries()) {
      await client.query('UPDATE trip_items SET position = $1 WHERE id = $2', [index, id2]);
    }

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// A removed traveller must not stay referenced as a payer or as one of the
// people a cost is split between; the rollup filters unknown ids anyway, but
// leaving them in the rows means a re-added traveller would silently inherit
// the old one's costs.
async function forgetTraveller(tripId, travellerId) {
  // A repayment involving someone no longer on the trip has no meaning, and the
  // blanking below would otherwise leave it half-addressed. Drop those rows
  // before the generic cleanup gets to them.
  await pool.query(
    `DELETE FROM trip_items
     WHERE trip_id = $1 AND kind = 'payments' AND (paid_by = $2 OR shared_by = $2)`,
    [tripId, travellerId]
  );

  await pool.query(
    'UPDATE trip_items SET paid_by = $1 WHERE trip_id = $2 AND paid_by = $3',
    ['', tripId, travellerId]
  );
  const { rows } = await pool.query(
    'SELECT id, shared_by FROM trip_items WHERE trip_id = $1 AND shared_by <> $2',
    [tripId, '']
  );
  for (const row of rows) {
    const remaining = parseSharedBy(row.shared_by).filter((id) => id !== travellerId);
    if (remaining.length === parseSharedBy(row.shared_by).length) continue;
    await pool.query('UPDATE trip_items SET shared_by = $1 WHERE id = $2', [
      remaining.join(','),
      row.id,
    ]);
  }
}

export async function close() {
  await pool.end();
}
