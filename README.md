# Itinerary Planner

Plan a trip, track what it costs, and share it with everyone coming along.

- **Stays** — hotel, address, check-in/out, nightly count, booking reference, cost, map link
- **Itinerary** — activities with date, time, location, cost
- **Travellers** — who is coming, who paid for what
- **Costs** — running total, per-person split, and who owes whom
- **Sharing** — every trip has a read-only link and an edit link; no accounts needed

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
src/server.js   HTTP routes, access control, input validation
src/store.js    All database access; the only file that knows about Postgres
src/costs.js    Money math — integer cents, remainder-preserving splits
public/         Frontend (vanilla ES modules, no build step)
test/           Cost math and end-to-end API tests
```

### Notes on the design

**Money is stored and summed in integer cents.** Adding `0.1 + 0.2` in floating
point gives `0.30000000000000004`; across a trip's worth of line items that
drifts visibly. Amounts convert to cents at the boundary and divide only for
display.

**Splits preserve every cent.** $10.00 across 3 people is 334/333/333, never
three times 3.33 — the remainder is distributed rather than dropped.

**Item writes are scoped by trip.** Update and delete queries match on
`trip_id` as well as item id, so a token for one trip cannot touch another
trip's rows even if an item id is guessed.

**Map links are validated as http(s).** A `javascript:` URL stored and rendered
into an `href` would execute for anyone who clicked it.

**The frontend builds DOM nodes with `textContent`**, never `innerHTML`, so a
trip name containing markup renders as literal text.
