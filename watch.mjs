// Volo pickup watcher
// Asks Volo's public GraphQL API (the same one volosports.com/discover uses) for
// open SF volleyball pickups, diffs against the last run, and pushes to your phone
// via ntfy when a new session appears.
//
// If a plain request ever gets blocked (e.g. Cloudflare), it retries the same query
// from inside a real headless Chromium page.

import fs from 'node:fs/promises';

const API = 'https://www.volosports.com/hapi/v1/graphql';
const OPEN_URL =
  'https://www.volosports.com/discover/san-francisco?category=daily-sports&programType=pickup&sports=volleyball';
const SF_ORG = 'b4fff72c-7fba-453e-9f88-c3c4aa0a6cab'; // Volo San Francisco
const SPORTS = (process.env.SPORTS || 'volleyball').split(',').map((s) => s.trim());

const TOPIC = process.env.NTFY_TOPIC;
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const DRY_RUN = process.env.DRY_RUN === '1';
const FAIL_ALERT_AFTER = 12; // consecutive failed runs (~3h at 15 min) before a heads-up

const QUERY = `
query VoloPickups($where: discover_daily_bool_exp!) {
  discover_daily(where: $where, limit: 200, order_by: {event_start_date: asc}) {
    _id
    event_start_date
    league { _id name }
  }
}`;

const WHERE = {
  _and: [
    { organization_id: { _eq: SF_ORG } },
    { program_type: { _in: ['PICKUP'] } },
    {
      game_id: { _is_null: true },
      league_id: { _is_null: false },
      league: {
        _and: [
          {
            organizationByOrganization: { _id: { _eq: SF_ORG } },
            archived: { _eq: false },
            private: { _eq: false },
            status: { _eq: 'registration_open' },
            program_type: { _in: ['PICKUP'] },
          },
          { sportBySport: { slug: { _in: SPORTS } } },
        ],
      },
    },
  ],
};

const BODY = JSON.stringify({ operationName: 'VoloPickups', query: QUERY, variables: { where: WHERE } });

// ---------- fetching ----------

function parse(json) {
  if (json?.errors?.length) throw new Error('GraphQL: ' + json.errors.map((e) => e.message).join('; '));
  const rows = json?.data?.discover_daily;
  if (!Array.isArray(rows)) throw new Error('Unexpected response shape');
  return rows.map((r) => ({ id: r._id, start: r.event_start_date, name: r.league?.name ?? 'Volleyball pickup' }));
}

async function fetchDirect() {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: 'https://www.volosports.com',
      referer: OPEN_URL,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
    body: BODY,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parse(await res.json());
}

async function fetchViaBrowser() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('https://www.volosports.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const json = await page.evaluate(
      async ({ api, body }) => {
        const r = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        return r.json();
      },
      { api: API, body: BODY }
    );
    return parse(json);
  } finally {
    await browser.close();
  }
}

async function getSessions() {
  try {
    return await fetchDirect();
  } catch (e) {
    console.warn(`Direct request failed (${e.message}); trying headless browser…`);
    return await fetchViaBrowser();
  }
}

// ---------- notify / state ----------

async function notify(title, message, { priority = 'high', tags = 'volleyball' } = {}) {
  console.log(`NOTIFY → ${title}\n${message}`);
  if (DRY_RUN || !TOPIC) return;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}`, {
    method: 'POST',
    body: message,
    headers: { Title: title, Priority: priority, Tags: tags, Click: OPEN_URL },
  });
  if (!res.ok) console.error(`ntfy failed: ${res.status}`);
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---------- main ----------

const prev = await loadState();

let sessions;
try {
  sessions = await getSessions();
} catch (e) {
  const fails = (prev?.fails ?? 0) + 1;
  console.error(`Couldn't fetch sessions (fail #${fails}): ${e.message}`);
  if (fails === FAIL_ALERT_AFTER) {
    await notify('Volo watcher needs a look', 'Couldn’t reach Volo for ~3 hours. Check the GitHub Actions logs.', {
      priority: 'default',
      tags: 'warning',
    });
  }
  await fs.writeFile(STATE_FILE, JSON.stringify({ ...(prev || {}), fails }, null, 2));
  process.exit(0);
}

console.log(`${sessions.length} open pickup(s):`);
for (const s of sessions) console.log(`  - ${s.name}`);

// Remember every ID ever seen (trimmed), so a session that briefly disappears
// and comes back doesn't re-alert.
const seen = new Set(prev?.seen ?? []);
const added = sessions.filter((s) => !seen.has(s.id));

if (!prev?.seen) {
  await notify(
    'Volo watcher is live 🏐',
    `Tracking ${sessions.length} open SF volleyball pickup(s). You’ll get pinged when new ones drop.`,
    { priority: 'default' }
  );
} else if (added.length) {
  const lines = added.map((s) => `• ${s.name}`).join('\n');
  await notify(
    added.length === 1 ? 'New Volo volleyball pickup 🏐' : `${added.length} new Volo volleyball pickups 🏐`,
    lines
  );
} else {
  console.log('No new sessions.');
}

for (const s of sessions) seen.add(s.id);
const next = { seen: [...seen].slice(-500), current: sessions, fails: 0 }; // no timestamp, so the repo only gets a commit when something changes
await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2));
