// Place suggestions, backed by OpenStreetMap.
//
// Two free, keyless services are used together:
//   Nominatim  turns "Sydney" into a coordinate.
//   Overpass   lists tourist attractions around that coordinate.
//
// Neither needs an account, a card, or a prepayment, which is why they are used
// here in preference to a commercial places API. Both are donated infrastructure
// under a fair-use policy, so this module identifies itself with a User-Agent,
// asks for a bounded number of results, and caches aggressively — repeat views
// of the same trip must not mean repeat queries.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// The main Overpass instance returns 504 whenever it is busy, which is often.
// Mirrors run the same API over the same data, so a failure is retried against
// the next one before giving up.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Required by the Nominatim usage policy: requests must identify the app.
const USER_AGENT = 'itinerary-planner (https://github.com/prbndulal/itineraryplanner)';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // a day; attractions do not move
const MAX_CACHE_ENTRIES = 200;
const GEOCODE_TIMEOUT_MS = 8000;
// Per mirror, not overall: three mirrors are tried in turn, so this bounds the
// worst case at roughly 45s rather than letting a bad day stack up past a
// minute. Overpass is genuinely slow under load, so it cannot be much lower.
const OVERPASS_TIMEOUT_MS = 15000;
const SEARCH_RADIUS_M = 12000;

// Fetched, ranked, then trimmed to the handful actually shown. Set high enough
// to cover a dense city's whole match set — see the note in attractionsNear.
const OVERPASS_ELEMENT_CAP = 1500;

// The tourism tags worth suggesting. Deliberately narrow: without this filter
// Overpass returns every picnic table and information board in the city.
const TOURISM_KINDS = 'attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork';

const cache = new Map();

// Kept for the API response shape. There is no key to configure any more, so
// suggestions are always available.
export function isConfigured() {
  return true;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  // Plain FIFO eviction. The map is small and insertion-ordered, so the oldest
  // key is simply the first one.
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

async function getJson(url, options, timeoutMs) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options?.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    throw err;
  }
  return res.json();
}

// "Sydney" -> a coordinate to search around.
async function geocode(place) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(place)}&format=jsonv2&limit=1`;
  const results = await getJson(url, {}, GEOCODE_TIMEOUT_MS);
  if (!Array.isArray(results) || !results.length) return null;
  const hit = results[0];
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: hit.display_name || place };
}

function addressOf(tags) {
  const full = tags['addr:full'];
  if (full) return full;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return [street, tags['addr:suburb'] || tags['addr:city']].filter(Boolean).join(', ');
}

function toSuggestion(element) {
  const tags = element.tags || {};
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!tags.name || lat === undefined || lon === undefined) return null;

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name,
    address: addressOf(tags),
    // A plain maps link, not an API call — nothing here is billed.
    mapUrl: `https://www.google.com/maps/search/?api=1&query=${lat}%2C${lon}`,
    // OSM has no ratings. The UI treats null as "no rating to show" rather than
    // inventing a score.
    rating: null,
    ratingCount: null,
    kind: (tags.tourism || tags.historic || '').replace(/_/g, ' '),
    summary: tags.description || '',
    // Not rendered; used only for ranking below.
    score: notability(tags),
  };
}

// OpenStreetMap has no ratings or popularity data, so notability is inferred
// from how the place is mapped. A Wikipedia article is the strongest signal a
// place is worth visiting; heritage listing and a rich tag set (opening hours,
// website, phone, fee) are weaker ones. Without this, alphabetical order puts a
// Coca-Cola billboard above Darling Harbour.
function notability(tags) {
  let score = 0;
  if (tags.wikipedia) score += 80;
  if (tags.wikidata) score += 30;
  if (tags.heritage || tags['heritage:operator']) score += 30;
  if (tags.website || tags['contact:website']) score += 8;
  if (tags.opening_hours) score += 6;
  if (tags.description) score += 5;
  // Somewhere you would set out to visit, rather than something you pass.
  if (tags.tourism === 'attraction') score += 8;
  if (tags.tourism === 'museum' || tags.tourism === 'gallery') score += 5;
  if (tags.tourism === 'artwork') score -= 20;
  // A well-mapped place carries more tags than a drive-by one, but this is the
  // weakest signal of the lot — capped low so it breaks ties rather than
  // deciding the order and burying a landmark under a thoroughly tagged café.
  score += Math.min(Object.keys(tags).length, 10);
  return score;
}

// Runs an Overpass query, falling through the mirrors on failure. Only the last
// error survives; if every mirror is down the caller turns it into a message.
async function overpassQuery(query) {
  let lastError;
  for (const url of OVERPASS_MIRRORS) {
    try {
      return await getJson(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        },
        OVERPASS_TIMEOUT_MS
      );
    } catch (err) {
      console.error(`Overpass mirror ${url} failed:`, err.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function attractionsNear({ lat, lon }, limit) {
  // `nwr` covers nodes, ways and relations in one go. All three are needed: the
  // Sydney Opera House and Harbour Bridge are relations, Taronga Zoo is a way,
  // and smaller sights are nodes.
  //
  // The output cap has to sit above the total number of matches, not near the
  // number we intend to show. Overpass emits elements in id order — every node,
  // then every way, then every relation — so a low cap silently truncates the
  // relations, which is exactly where the landmarks live. Sydney alone has ~740
  // named tourism elements within this radius.
  const query = `[out:json][timeout:25];
    nwr["tourism"~"${TOURISM_KINDS}"]["name"](around:${SEARCH_RADIUS_M},${lat},${lon});
    out center ${OVERPASS_ELEMENT_CAP};`;

  const data = await overpassQuery(query);

  const seen = new Set();
  const places = [];
  for (const element of data.elements || []) {
    const place = toSuggestion(element);
    if (!place) continue;
    // Large attractions are often mapped as both a node and a way.
    const key = place.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place);
  }

  places.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return places.slice(0, limit).map(({ score, ...place }) => place);
}

/**
 * Suggests places to visit near a destination such as "Sydney".
 *
 * Returns { configured, places, error }. A failure here is never fatal: the trip
 * page has to keep working when OpenStreetMap is slow, rate-limiting, or
 * unreachable, so problems come back as a message rather than a throw.
 */
export async function search(query, { limit = 12 } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { configured: true, places: [], error: '' };

  const cacheKey = `${trimmed.toLowerCase()}|${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { configured: true, places: cached, error: '', cached: true };

  let point;
  try {
    point = await geocode(trimmed);
  } catch (err) {
    console.error('Geocoding failed:', err.message, err.body || '');
    return { configured: true, places: [], error: 'Could not look that place up. Try again shortly.' };
  }

  if (!point) {
    return { configured: true, places: [], error: `Could not find anywhere called “${trimmed}”.` };
  }

  let places;
  try {
    places = await attractionsNear(point, limit);
  } catch (err) {
    console.error('Overpass lookup failed:', err.message, err.body || '');
    const error =
      err.status === 429 || err.status === 504
        ? 'The map service is busy right now. Try again in a minute.'
        : 'Could not fetch places just now. Try again shortly.';
    return { configured: true, places: [], error };
  }

  cacheSet(cacheKey, places);
  return { configured: true, places, error: '', near: point.label };
}

// Exposed for tests, which must not inherit a cache warmed by another case.
export function clearCache() {
  cache.clear();
}
