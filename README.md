# Itinerary Planner

Plan a trip, track what it costs, and share it with everyone coming along.

- **Route** — stays drawn as a journey: each stop in date order, nights, per-night
  rate, and a marker on any stretch of the trip with nowhere booked
- **Itinerary** — activities with date, time, location, cost
- **Expenses** — everything else: meals, taxis, tickets, by category and date
- **Travellers** — who is coming, who paid for what
- **Costs** — running total, category breakdown, and who owes whom
- **Settling up** — turns the balances into "X pays Y" so the group can square up
- **Reports** — a printable per-person statement of what they owe or are owed
- **Splitting** — each cost can be shared by the whole group or just the people it was for
- **Places to go** — attraction suggestions near the destination, from OpenStreetMap
- **Sharing** — every trip has a read-only link and an edit link; no accounts needed

Everything is editable in place; amounts default to AUD and can be changed per trip.

## Running locally

```bash
npm install
cp .env.example .env      # then paste your DATABASE_URL
npm run dev
```

Open http://localhost:3000. Set `PORT` to use a different port.

```bash
npm test
```

Tests run against the database in `.env` and clean up after themselves.

## How sharing works

Creating a trip mints two unguessable tokens (144 bits each):

| Link | Who gets it | Can do |
|---|---|---|
| `/t/<viewToken>` | The group | Read the itinerary and costs |
| `/t/<editToken>` | You | Everything, including deleting the trip |

The view link's API response omits the edit token entirely, so forwarding a
read-only link cannot leak write access.

Anyone holding a link can open it — treat the edit link like a password. There
are no accounts, so a leaked edit link cannot be revoked without recreating the
trip.

## Deploying to Render

1. Push this repo to GitHub.
2. In Render, **New → Web Service**, point it at the repo. `render.yaml` supplies
   the build and start commands.
3. Under **Environment**, add `DATABASE_URL`. Use your Postgres instance's
   **Internal Database URL** when the app and database are in the same region —
   it is faster and not exposed to the public internet.
4. Deploy. Tables are created automatically on first boot.

The free instance type sleeps after inactivity, so the first request after an
idle period takes a few seconds. Data lives in Postgres, so it survives deploys
and restarts.

## Layout

```
src/server.js       HTTP routes, access control, input validation
src/store.js        All database access; the only file that knows about Postgres
src/costs.js        Money math — integer cents, splits, settlement, unbooked nights
src/places.js       Place suggestions via OpenStreetMap (no key, no account)
public/trip.html    The trip page: route timeline, costs, editing
public/report.html  Per-person printable reports
public/trip-ui.js   Presentational helpers shared by both pages
public/app.js       DOM and fetch primitives
test/               Cost math and end-to-end API tests
```

### Notes on the design

**Money is stored and summed in integer cents.** Adding `0.1 + 0.2` in floating
point gives `0.30000000000000004`; across a trip's worth of line items that
drifts visibly. Amounts convert to cents at the boundary and divide only for
display.

**Splits preserve every cent.** $10.00 across 3 people is 334/333/333, never
three times 3.33 — the remainder is distributed rather than dropped. Each item
is split within itself, so a cost shared by two of three people still adds up to
exactly that cost.

**Not every cost is shared by everyone.** A room booked for one person should
not be divided across the whole group, so each stay, activity, and expense can
name who it is for. Naming nobody means everyone, which is also what happens to
anyone added to the trip later. Once any cost is restricted to a subset, the
single "each person pays X" figure stops being meaningful and is hidden in
favour of the per-person shares.

**Place suggestions use OpenStreetMap, not a paid API.** Nominatim geocodes the
destination and Overpass lists tourist attractions nearby — no key, no account,
no billing. It is donated infrastructure, so results are cached for a day, the
lookup only runs when asked for, and failures degrade to a message rather than
breaking the page. Overpass returns elements in id order rather than by
relevance, so the query has to fetch the whole match set before ranking: a low
cap silently drops the relations, and relations are where landmarks like the
Sydney Opera House live.

**A cost with no payer is money nobody is owed.** Balances only net to zero once
every cost records who paid for it. Until then the totals are short by whatever
is unattributed, and matching debtors against creditors would invent debts that
nobody actually owes. `settle()` caps the debt side at what is genuinely owed and
reports the remainder as `unpaidCents`, so the UI can ask who paid instead of
inventing an answer. Assigning a payer is a single tap on each cost for exactly
this reason.

**Settlement is greedy, not minimal.** Debtors are matched against creditors
largest-first, which settles any group in at most one transfer fewer than there
are people. Finding the true minimum set of transfers is NP-hard and the
difference never shows up at the size of a holiday.

**Reports are a static page that fetches the trip like any other client.** The
report route serves HTML with no token in it and reads its data from
`/api/trips/:token`, so it inherits that endpoint's access control rather than
adding a second copy of it. A read-only link opens a report; it still never
receives the edit token.

**Printing is the same DOM, not a second rendering path.** Choosing whose report
to read sets an attribute on `<body>`, and one CSS rule hides the others — so
what prints is exactly what is on screen. The print stylesheet also redeclares
the light palette, because the dark-mode media query still matches when printing
from a dark-mode machine and would otherwise produce a black page.

**Item writes are scoped by trip.** Update and delete queries match on
`trip_id` as well as item id, so a token for one trip cannot touch another
trip's rows even if an item id is guessed.

**A partial update leaves unsent fields alone.** Assigning a payer sends only
that one field, so an absent name means "unchanged" rather than "clear it".
Creating an item still requires a name.

**Map links are validated as http(s).** A `javascript:` URL stored and rendered
into an `href` would execute for anyone who clicked it.

**The frontend builds DOM nodes with `textContent`**, never `innerHTML`, so a
trip name containing markup renders as literal text.
