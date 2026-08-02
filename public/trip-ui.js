// Presentational helpers shared by the trip page and the report page.
//
// Everything here is pure: given data, return DOM or a string. The stateful
// editing machinery stays in trip.html, which is the only page that writes.

import { el, money } from '/app.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ISO dates are parsed as UTC and read back with UTC getters. Using the local
// timezone would shift a date like 2026-09-25 to the previous day for anyone
// west of UTC, which is exactly the sort of off-by-one nobody notices until a
// booking looks like it starts a day early.
function parts(iso) {
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return { day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear(), dow: d.getUTCDay() };
}

export function formatDay(iso, { weekday = false, year = false } = {}) {
  const p = parts(iso);
  if (!p) return '';
  const base = `${p.day} ${MONTHS[p.month]}`;
  return [weekday ? `${DAYS[p.dow]} ` : '', base, year ? ` ${p.year}` : ''].join('');
}

// "25 Sep → 9 Oct 2026", dropping the repeated year.
export function formatRange(from, to) {
  if (!from && !to) return '';
  if (!to) return formatDay(from, { year: true });
  if (!from) return formatDay(to, { year: true });
  const a = parts(from);
  const b = parts(to);
  const sameYear = a && b && a.year === b.year;
  return `${formatDay(from, { year: !sameYear })} → ${formatDay(to, { year: true })}`;
}

export function nightsLabel(n) {
  return `${n} night${n === 1 ? '' : 's'}`;
}

export function card(title, ...children) {
  return el('div', { class: 'card' }, el('h2', {}, title), ...children);
}

export function mapLink(url) {
  if (!url) return null;
  return el('a', { class: 'maplink', href: url, target: '_blank', rel: 'noopener noreferrer' },
    'Open map ↗');
}

// The trip header: name, where and when, and the numbers worth seeing first.
export function hero(trip, { tiles = [] } = {}) {
  const dates = formatRange(trip.startDate, trip.endDate);
  const sub = [trip.destination, dates].filter(Boolean).join(' · ');

  const tileRow = el('div', { class: 'hero-tiles' });
  for (const tile of tiles) {
    if (!tile) continue;
    tileRow.append(
      el('div', { class: tile.warn ? 'tile tile-warn' : 'tile' },
        el('div', { class: 'k' }, tile.label),
        el('div', { class: 'v' }, tile.value)
      )
    );
  }

  return el('div', { class: 'hero' },
    el('h1', {}, trip.name),
    sub ? el('div', { class: 'hero-sub' }, sub) : null,
    tiles.length ? tileRow : null
  );
}

// "Bharat pays Prabin A$975.22" — the whole point of the settlement.
export function settlementLines(settlement, currency) {
  const wrap = el('div', { class: 'settlement' });

  for (const t of settlement.transfers) {
    wrap.append(
      el('div', { class: 'settle-line' },
        el('span', { class: 'settle-who' }, t.fromName),
        el('span', { class: 'settle-arrow' }, 'pays'),
        el('span', { class: 'settle-who' }, t.toName),
        el('span', { class: 'amount', style: 'margin-left:auto' }, money(t.cents, currency))
      )
    );
  }

  if (settlement.unpaidCents > 0) {
    // Without a payer on a cost there is no one to pay back, so saying "X owes
    // Y" here would invent a debt. Prompt for the missing information instead.
    wrap.append(
      el('div', { class: 'notice', role: 'status' },
        el('strong', {}, `${money(settlement.unpaidCents, currency)} has no payer recorded yet.`),
        el('p', {},
          'Set who paid for each cost and this becomes a list of who pays whom.')
      )
    );
  } else if (!settlement.transfers.length) {
    wrap.append(el('p', { class: 'empty' }, 'Everyone is square — nothing to settle.'));
  }

  return wrap;
}

// Tabs for picking whose report to read. Selecting one also decides what prints.
export function personTabs(travellers, selected, onSelect) {
  const tabs = el('div', { class: 'person-tabs' });

  const add = (id, label) => {
    const button = el('button', {
      type: 'button',
      class: 'chip',
      // The id lives on the element rather than being matched by label, so a
      // traveller named "Everyone" can't collide with the all-people tab.
      'data-person': id,
      'aria-pressed': String(id === selected),
    }, label);
    button.addEventListener('click', () => onSelect(id));
    tabs.append(button);
  };

  add('all', 'Everyone');
  for (const t of travellers) add(t.id, t.name);
  return tabs;
}
