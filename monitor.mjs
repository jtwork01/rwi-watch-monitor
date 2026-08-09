import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ORIGIN = 'https://forum.replica-watch.info';
const NEWS_FEED_URL = `${ORIGIN}/whats-new/news-feed`;
const MARKETPLACE_URL = `${ORIGIN}/forums/replica-genuine-watch-sales.9951900/`;
const SELLER = (process.env.SELLER_USERNAME || 'soyla355').trim();
const ENABLE_MARKETPLACE = String(process.env.ENABLE_MARKETPLACE_TEST ?? 'true').toLowerCase() !== 'false';
const RWI_USERNAME = process.env.RWI_USERNAME || '';
const RWI_PASSWORD = process.env.RWI_PASSWORD || '';
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

const STATE_FILE = path.resolve('state.json');
const AUTH_FILE = path.resolve('.private/auth.json');
const AUTH_UPDATED_MARKER = path.resolve('.runtime/auth-updated');
const MAX_SEEN = 120;

fs.mkdirSync('.runtime', { recursive: true });
fs.mkdirSync('.private', { recursive: true });

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    parsed.marketplace ??= { initialized: false, seenIds: [] };
    parsed.seller ??= { initialized: false, seenIds: [] };
    parsed.errors ??= {};
    return parsed;
  } catch {
    return {
      version: 1,
      marketplace: { initialized: false, seenIds: [] },
      seller: { initialized: false, seenIds: [] },
      errors: {}
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function normalizeUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href, ORIGIN);
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function trimText(value, max = 220) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('Google Chrome/Chromium was not found on the GitHub runner.');
}

async function notify({ title, message, url, tags = ['watch'] }) {
  if (!NTFY_TOPIC) throw new Error('NTFY_TOPIC secret is missing.');

  const response = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message: trimText(message, 1000),
      tags,
      priority: 4,
      click: url || undefined
    })
  });

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function sendTestNotification() {
  await notify({
    title: 'RWI monitor test',
    message: 'Notifications are working. The marketplace test and soyla355 monitor can now alert this phone.',
    url: MARKETPLACE_URL,
    tags: ['white_check_mark', 'watch']
  });

  console.log('Sent manual ntfy test notification.');
}

async function challengeDetected(page) {
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

  return [
    'verify you are human',
    'checking your browser',
    'just a moment',
    'attention required',
    'cloudflare ray id'
  ].some(text => body.includes(text));
}

async function loginFormVisible(page) {
  const login = page.locator(
    'input[name="login"], input[name="username"], input[autocomplete="username"]'
  ).first();

  const password = page.locator(
    'input[name="password"], input[autocomplete="current-password"]'
  ).first();

  return (await login.count()) > 0 &&
    (await password.count()) > 0 &&
    await login.isVisible().catch(() => false);
}

async function ensureLoggedIn(page, context) {
  await page.goto(NEWS_FEED_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  if (await challengeDetected(page)) {
    throw new Error('RWI/Cloudflare presented a browser verification challenge to the GitHub runner.');
  }

  if (!(await loginFormVisible(page)) && !/\/login\/?(?:\?|$)/i.test(page.url())) {
    console.log('Existing RWI session is valid.');
    return;
  }

  if (!RWI_USERNAME || !RWI_PASSWORD) {
    throw new Error('RWI_USERNAME or RWI_PASSWORD secret is missing, and the saved RWI session is not valid.');
  }

  console.log('Saved RWI session is absent/expired; logging in.');

  await page.goto(`${ORIGIN}/login/`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  if (await challengeDetected(page)) {
    throw new Error('RWI/Cloudflare presented a browser verification challenge on the login page.');
  }

  const login = page.locator(
    'input[name="login"], input[name="username"], input[autocomplete="username"]'
  ).first();

  const password = page.locator(
    'input[name="password"], input[autocomplete="current-password"]'
  ).first();

  if (!(await login.count()) || !(await password.count())) {
    throw new Error('Could not find the RWI login fields. The forum login markup may have changed.');
  }

  await login.fill(RWI_USERNAME);
  await password.fill(RWI_PASSWORD);

  const submit = page.locator(
    'form[action*="login"] button[type="submit"], form[action*="login"] input[type="submit"], button[type="submit"]'
  ).first();

  if (!(await submit.count())) {
    throw new Error('Could not find the RWI login button.');
  }

  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
    submit.click()
  ]);

  await page.waitForTimeout(1500);

  if (await challengeDetected(page)) {
    throw new Error('RWI/Cloudflare challenged the login attempt.');
  }

  if (await loginFormVisible(page) || /\/login\/?(?:\?|$)/i.test(page.url())) {
    const body = await page.locator('body').innerText().catch(() => '');

    if (/two[- ]?step|verification code|two[- ]?factor|2fa/i.test(body)) {
      throw new Error('RWI is asking for two-factor authentication. This package needs a saved authenticated session for 2FA accounts.');
    }

    throw new Error('RWI login did not succeed. Check the username/password secrets or RWI security challenge.');
  }

  await context.storageState({ path: AUTH_FILE });
  fs.writeFileSync(AUTH_UPDATED_MARKER, 'updated\n');

  console.log('RWI login succeeded and browser session was refreshed.');
}

async function extractMarketplaceThreads(page) {
  await page.goto(MARKETPLACE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  if (await challengeDetected(page)) {
    throw new Error('Cloudflare challenge appeared on the marketplace page.');
  }

  if (await loginFormVisible(page)) {
    throw new Error('Marketplace page redirected to login unexpectedly.');
  }

  await page.waitForTimeout(1000);

  const debug = await page.evaluate(() => ({
    title: document.title,
    threadAnchors: document.querySelectorAll('a[href*="/threads/"]').length,
    structThreads: document.querySelectorAll('.structItem--thread').length,
    discussionItems: document.querySelectorAll('.discussionListItem').length,
    contentRows: document.querySelectorAll('.contentRow').length,
    blockRows: document.querySelectorAll('.block-row').length
  }));

  console.log(
    `Marketplace page: ${debug.title} | thread links=${debug.threadAnchors}, struct=${debug.structThreads}, discussion=${debug.discussionItems}, contentRow=${debug.contentRows}, blockRow=${debug.blockRows}`
  );

  const threads = await page.evaluate((origin) => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/threads/"]'));
    const byThread = new Map();

    for (const anchor of anchors) {
      if (anchor.closest('nav, footer, .p-breadcrumbs, .breadcrumbs, .menu, .tabs')) continue;

      let url;

      try {
        url = new URL(anchor.getAttribute('href'), origin);
      } catch {
        continue;
      }

      const match =
        url.pathname.match(/\/threads\/[^/?#]*\.(\d+)(?:\/|$)/i) ||
        url.pathname.match(/\/threads\/(\d+)(?:\/|$)/i);

      if (!match) continue;

      const threadId = match[1];

      const canonicalPathMatch =
        url.pathname.match(/^(\/threads\/[^/]+\.\d+|\/threads\/\d+)/i);

      const canonicalUrl =
        new URL(canonicalPathMatch?.[1] || url.pathname, origin).href;

      const title = (anchor.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!title || /^(last|latest|go to|\d+|new)$/i.test(title)) continue;

      const row =
        anchor.closest(
          '.structItem--thread, .discussionListItem, article, li, .contentRow, .block-row, tr'
        ) || anchor.parentElement;

      const rowText = (row?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      const rowClass = row?.getAttribute?.('class') || '';

      const sticky =
        /\bsticky\b/i.test(rowClass) ||
        /^sticky\b/i.test(rowText) ||
        /\bsticky thread\b/i.test(rowText);

      const author =
        row?.querySelector?.('a.username, [data-user-id]')?.textContent?.trim() || '';

      const time =
        row?.querySelector?.('time[data-time]')?.getAttribute('data-time') || '';

      const candidate = {
        threadId,
        href: canonicalUrl,
        title,
        author,
        time,
        sticky
      };

      const existing = byThread.get(threadId);

      if (!existing || candidate.title.length > existing.title.length) {
        byThread.set(threadId, candidate);
      }
    }

    return Array.from(byThread.values());
  }, ORIGIN);

  return threads
    .filter(t => !t.sticky)
    .map(t => ({
      id: `thread:${sha256(t.threadId || t.href)}`,
      url: normalizeUrl(t.href),
      title: trimText(t.title || 'New marketplace thread'),
      author: trimText(t.author, 80),
      time: t.time
    }));
}

async function extractSellerFeedItems(page) {
  await page.goto(NEWS_FEED_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  if (await challengeDetected(page)) {
    throw new Error('Cloudflare challenge appeared on the RWI news feed.');
  }

  if (await loginFormVisible(page)) {
    throw new Error('RWI news feed is not authenticated.');
  }

  const sellerLower = SELLER.toLowerCase();

  const raw = await page.evaluate(({ origin, sellerLower }) => {
    const selectorSets = [
      '.contentRow',
      'li.block-row',
      '.block-row',
      '[data-author]'
    ];

    let nodes = [];

    for (const selector of selectorSets) {
      const found = Array.from(document.querySelectorAll(selector));

      const matching = found.filter(el =>
        (el.innerText || '').toLowerCase().includes(sellerLower)
      );

      if (matching.length) {
        nodes = matching;
        break;
      }
    }

    return nodes.slice(0, 80).map(el => {
      const text = (el.innerText || '')
        .replace(/\s+/g, ' ')
        .trim();

      const anchors = Array.from(el.querySelectorAll('a[href]')).map(a => ({
        href: new URL(a.getAttribute('href'), origin).href,
        text: (a.textContent || '').replace(/\s+/g, ' ').trim()
      }));

      const post = anchors.find(a => /\/posts\/\d+/i.test(a.href));
      const thread = anchors.find(a => /\/threads\//i.test(a.href));

      const url =
        post?.href ||
        thread?.href ||
        anchors.find(a => a.href.startsWith(origin))?.href ||
        '';

      const timestamp =
        el.querySelector('time[data-time]')?.getAttribute('data-time') || '';

      const titleEl =
        el.querySelector('.contentRow-title, .structItem-title, h3, h4');

      const title = (titleEl?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      return {
        text,
        url,
        timestamp,
        title
      };
    });
  }, { origin: ORIGIN, sellerLower });

  const dedup = new Map();

  for (const item of raw) {
    const url = normalizeUrl(item.url);
    const postMatch = url.match(/\/posts\/(\d+)/i);

    const stableBasis = postMatch?.[1]
      ? `post:${postMatch[1]}`
      : `${SELLER.toLowerCase()}|${item.timestamp}|${url}`;

    if (!item.timestamp && !postMatch && !url) continue;

    const id = postMatch?.[1]
      ? `post:${sha256(postMatch[1])}`
      : `feed:${sha256(stableBasis)}`;

    if (!dedup.has(id)) {
      dedup.set(id, {
        id,
        url: url || NEWS_FEED_URL,
        title: trimText(item.title || `${SELLER} posted on RWI`),
        text: trimText(item.text, 500),
        timestamp: item.timestamp
      });
    }
  }

  return [...dedup.values()];
}

function updateSeen(bucket, items) {
  const previous = new Set(bucket.seenIds || []);
  const currentIds = items.map(x => x.id);

  const newItems = bucket.initialized
    ? items.filter(x => !previous.has(x.id))
    : [];

  bucket.initialized = true;

  bucket.seenIds = [
    ...new Set([
      ...currentIds,
      ...(bucket.seenIds || [])
    ])
  ].slice(0, MAX_SEEN);

  return newItems;
}

async function processMarketplace(page, state) {
  if (!ENABLE_MARKETPLACE) {
    console.log('Marketplace test monitor is DISABLED.');
    return;
  }

  const items = await extractMarketplaceThreads(page);

  if (!items.length) {
    throw new Error('Marketplace parser found zero sales threads. RWI markup may have changed.');
  }

  console.log(`Marketplace: found ${items.length} current sales threads.`);

  const wasInitialized = state.marketplace.initialized;
  const newItems = updateSeen(state.marketplace, items);

  if (!wasInitialized) {
    console.log('Marketplace: initialized baseline; no old threads were notified.');
    return;
  }

  for (const item of newItems.reverse()) {
    await notify({
      title: 'TEST MARKETPLACE — new RWI sale',
      message: `${item.title}${item.author ? ` — ${item.author}` : ''}`,
      url: item.url,
      tags: ['test_tube', 'watch']
    });

    console.log(`Marketplace notification: ${item.title}`);
  }
}

async function processSeller(page, state) {
  const items = await extractSellerFeedItems(page);

  console.log(
    `Seller feed: found ${items.length} current item(s) containing ${SELLER}.`
  );

  const wasInitialized = state.seller.initialized;
  const newItems = updateSeen(state.seller, items);

  if (!wasInitialized) {
    console.log('Seller feed: initialized baseline; no old activity was notified.');
    return;
  }

  for (const item of newItems.reverse()) {
    await notify({
      title: `${SELLER} — new RWI post`,
      message:
        item.title !== `${SELLER} posted on RWI`
          ? item.title
          : item.text,
      url: item.url,
      tags: ['watch', 'eyes']
    });

    console.log(`Seller notification: ${item.title}`);
  }
}

async function maybeNotifyError(state, error) {
  const signature = sha256(String(error?.message || error));
  const now = Date.now();
  const previous = state.errors?.[signature] || 0;
  const sixHours = 6 * 60 * 60 * 1000;

  if (now - previous < sixHours) return;

  state.errors ??= {};
  state.errors[signature] = now;

  for (const [key, time] of Object.entries(state.errors)) {
    if (now - Number(time) > 7 * 24 * 60 * 60 * 1000) {
      delete state.errors[key];
    }
  }

  try {
    await notify({
      title: 'RWI monitor needs attention',
      message: trimText(error?.message || String(error), 700),
      url: 'https://github.com/',
      tags: ['warning', 'watch']
    });
  } catch (notifyError) {
    console.error(
      `Also failed to send ntfy error alert: ${notifyError.message}`
    );
  }
}

async function main() {
  if (process.argv.includes('--test-notification')) {
    await sendTestNotification();
    return;
  }

  const state = loadState();

  const launchOptions = {
    headless: true,
    executablePath: findChrome(),
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  };

  const browser = await chromium.launch(launchOptions);

  const contextOptions = {
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago'
  };

  if (fs.existsSync(AUTH_FILE)) {
    contextOptions.storageState = AUTH_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const monitorErrors = [];

  try {
    await ensureLoggedIn(page, context);

    try {
      await processMarketplace(page, state);
    } catch (error) {
      console.error(
        `MARKETPLACE ERROR: ${error.stack || error.message || error}`
      );

      monitorErrors.push(error);
      await maybeNotifyError(state, error);
    }

    try {
      await processSeller(page, state);
    } catch (error) {
      console.error(
        `SELLER ERROR: ${error.stack || error.message || error}`
      );

      monitorErrors.push(error);
      await maybeNotifyError(state, error);
    }

    const now = Date.now();

    const previousHeartbeat =
      state.heartbeatAt
        ? Date.parse(state.heartbeatAt)
        : 0;

    if (
      !previousHeartbeat ||
      now - previousHeartbeat > 30 * 24 * 60 * 60 * 1000
    ) {
      state.heartbeatAt = new Date(now).toISOString();
      console.log('Monthly repository heartbeat updated.');
    }

    saveState(state);

    if (monitorErrors.length) {
      process.exitCode = 1;
    }

  } catch (error) {
    console.error(
      `MONITOR ERROR: ${error.stack || error.message || error}`
    );

    await maybeNotifyError(state, error);
    saveState(state);

    process.exitCode = 1;

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

await main();
