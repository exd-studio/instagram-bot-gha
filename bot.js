#!/usr/bin/env node
// Instagram community-building bot for @designedby.surya
// Runs on GitHub Actions — no Chrome, no osascript, pure HTTPS (Node 18+ built-in fetch)

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DIR          = __dirname;
const LOG          = path.join(DIR, 'bot.log');
const ENGAGED_LOG  = path.join(DIR, 'engaged.txt');
const APP_ID       = '936619743392459';
const OWN_ACCOUNT  = 'designedby.surya';
const TARGET_DMS   = 10; // every hour × 10 = ~240 DMs/day

const RAW_COOKIES = process.env.IG_COOKIES || '';
if (!RAW_COOKIES.includes('sessionid')) {
  console.error('ERROR: IG_COOKIES env var missing or does not contain sessionid.');
  console.error('Go to GitHub repo → Settings → Secrets → add IG_COOKIES.');
  process.exit(1);
}

// --- Utilities ---

function getCsrf() {
  const m = RAW_COOKIES.match(/csrftoken=([^;]+)/);
  return m ? m[1].trim() : '';
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch(e) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadEngaged() {
  try {
    return new Set(fs.readFileSync(ENGAGED_LOG, 'utf8').trim().split('\n').filter(Boolean));
  } catch(e) { return new Set(); }
}

function markEngaged(username) {
  fs.appendFileSync(ENGAGED_LOG, username + '\n');
}

// --- Instagram API helpers ---

const BASE_HEADERS = {
  'x-ig-app-id': APP_ID,
  'Cookie': RAW_COOKIES,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.instagram.com/',
};

async function igGet(url) {
  if (!url.startsWith('http')) url = 'https://www.instagram.com' + url;
  try {
    const res = await fetch(url, { headers: BASE_HEADERS });
    const text = await res.text();
    return JSON.parse(text);
  } catch(e) { return null; }
}

async function igPost(url, fields) {
  if (!url.startsWith('http')) url = 'https://www.instagram.com' + url;
  const body = Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'x-csrftoken': getCsrf(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.instagram.com',
      },
      body,
    });
    const text = await res.text();
    return JSON.parse(text);
  } catch(e) { return null; }
}

// --- Inbox exclusion list ---

async function getExclusionList() {
  log('Building inbox exclusion list...');
  const all = new Set();
  let cursor = '';
  for (let i = 0; i < 8; i++) {
    const url = 'https://www.instagram.com/api/v1/direct_v2/inbox/?visual_message_return_type=unseen&direction=older&limit=50'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const d = await igGet(url);
    if (!d?.inbox) break;
    (d.inbox.threads || []).forEach(t => (t.users || []).forEach(u => all.add(u.username)));
    cursor = d.inbox.oldest_cursor || '';
    if (!cursor || !d.inbox.has_older) break;
    await sleep(400);
  }
  log(`Exclusion list: ${all.size} accounts`);
  return all;
}

// --- Account discovery via hashtags (fresh posts every run) ---

async function findFreshAccounts(excluded, alreadyEngaged, needed = 18) {
  const hashtags = [
    'uidesign', 'uxdesign', 'branddesign', 'logodesign', 'freelancedesigner',
    'brandidentity', 'graphicdesigner', 'productdesign', 'uiuxdesign',
    'figmadesign', 'webdesigner', 'designportfolio', 'brandingdesign',
    'uxdesigner', 'uidesigner', 'logodesigner', 'designinspiration',
    'appdesign', 'interfacedesign', 'visualidentity', 'designstudio',
    'typographydesign', 'motiondesign', 'creativedesign', 'startupdesign',
  ];

  const tried    = new Set();
  const verified = [];

  for (const tag of hashtags) {
    if (verified.length >= needed) break;

    // Try multiple endpoint variations to get hashtag media
    const medias = [];

    // Variation 1: POST sections API
    const sections = await igPost(`/api/v1/tags/${tag}/sections/`, {
      max_id: '',
      page: 1,
      server_filter_threshold: '0.02',
      tab: 'recent',
      include_persistent: 'false',
      display_mediatype_preference: 'video_then_image',
    });
    await sleep(350);
    (sections?.sections || []).forEach(s => {
      (s.layout_content?.medias || []).forEach(m => m.media && medias.push(m.media));
      (s.layout_content?.fill_media || []).forEach(m => m.media && medias.push(m.media));
    });

    // Variation 2: GET web_info for top posts
    const webInfo = await igGet(`/api/v1/tags/web_info/?tag_name=${tag}`);
    await sleep(300);
    const topMedia = webInfo?.data?.top?.sections || [];
    topMedia.forEach(s => {
      (s.layout_content?.medias || []).forEach(m => m.media && medias.push(m.media));
    });

    // Variation 3: GraphQL hashtag query (fallback)
    if (medias.length === 0) {
      const gql = await igGet(
        `/graphql/query/?query_hash=9b498c08113f1e09617a1703c22b2f32&variables=${encodeURIComponent(JSON.stringify({ tag_name: tag, first: 12 }))}`
      );
      await sleep(300);
      (gql?.data?.hashtag?.edge_hashtag_to_media?.edges || []).forEach(e => {
        if (e.node?.owner?.username) medias.push({ user: { username: e.node.owner.username, pk: e.node.owner.id }, pk: e.node.id, caption: { text: e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '' } });
      });
    }

    if (medias.length === 0) {
      log(`  #${tag}: no media found, skipping`);
      continue;
    }
    log(`  #${tag}: ${medias.length} posts found`);

    for (const media of medias) {
      if (verified.length >= needed) break;

      // Use data directly from media object — no extra profile API call needed
      const user     = media?.user || media?.owner;
      const username = user?.username;
      if (!username) continue;
      if (tried.has(username)) continue;
      if (excluded.has(username) || alreadyEngaged.has(username) || username === OWN_ACCOUNT) continue;
      if (user?.is_private) continue;
      tried.add(username);

      const pk      = user?.pk || user?.id;
      const caption = media?.caption?.text || '';

      verified.push({
        username,
        followers: 0,   // not available without profile fetch — skipping filter
        pk,
        latestMediaId: media?.pk || media?.id || null,
        latestCaption: caption,
      });
      log(`  ✓ Found @${username} via #${tag}`);
    }
  }
  return verified;
}

// --- Engagement ---

async function likePost(mediaId) {
  // Use just the numeric part of the media ID
  const id = String(mediaId).split('_')[0];
  const d = await igPost(`/api/v1/web/likes/${id}/like/`, {});
  if (d?.status !== 'ok') log(`  Like raw: ${JSON.stringify(d)?.slice(0, 120)}`);
  return d?.status || 'unknown';
}

async function commentPost(mediaId, text) {
  const id = String(mediaId).split('_')[0];
  const d = await igPost(`/api/v1/web/comments/${id}/add/`, { comment_text: text });
  if (d?.status !== 'ok') log(`  Comment raw: ${JSON.stringify(d)?.slice(0, 120)}`);
  return d?.status || 'unknown';
}

// Parse cookie string → Playwright cookie objects
function parseCookiesForPlaywright(raw) {
  return raw.split(';').map(c => c.trim()).filter(Boolean).map(c => {
    const idx = c.indexOf('=');
    return {
      name:   c.slice(0, idx).trim(),
      value:  c.slice(idx + 1).trim(),
      domain: '.instagram.com',
      path:   '/',
    };
  });
}

async function sendDM(username, message) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 800 },
    });
    await ctx.addCookies(parseCookiesForPlaywright(RAW_COOKIES));

    const page = await ctx.newPage();

    // Navigate to instagram home first to establish session
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    // Navigate to target profile
    await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);

    // Click the Message button
    const msgBtn = page.locator('button:has-text("Message"), [role="button"]:has-text("Message")').first();
    await msgBtn.waitFor({ timeout: 8000 });
    await msgBtn.click();
    await sleep(2500);

    // Find the message input box
    const box = page.locator('[contenteditable="true"], [aria-label="Message"], textarea[placeholder]').first();
    await box.waitFor({ timeout: 8000 });
    await box.click();
    await sleep(500);

    // Paste message text
    await page.evaluate((msg) => {
      const el = document.querySelector('[contenteditable="true"]');
      if (!el) return;
      const dt = new DataTransfer();
      dt.setData('text/plain', msg);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, message);
    await sleep(1000);

    // Click Send
    const sendBtn = page.locator('[aria-label="Send"], button:has-text("Send"), [role="button"]:has-text("Send")').first();
    await sendBtn.waitFor({ timeout: 5000 });
    await sendBtn.click();
    await sleep(1500);

    return 'sent';
  } catch(e) {
    log(`  DM error: ${e.message}`);
    return 'failed';
  } finally {
    if (browser) await browser.close();
  }
}

// --- Content helpers ---

const DESIGN_KEYWORDS = [
  'design','brand','ui','ux','creative','product','startup','launch',
  'business','typography','logo','portfolio','agency','studio','interface',
  'app','website','freelance','entrepreneur','strategy','branding','visual',
  'identity','mockup','wireframe','saas','founder','marketing','digital',
];

function isDesignRelated(text) {
  const l = text.toLowerCase();
  return DESIGN_KEYWORDS.some(k => l.includes(k));
}

function generateComment(caption) {
  const l = caption.toLowerCase();
  if (l.includes('brand') || l.includes('branding')) return 'This branding direction is spot on.';
  if (l.includes('logo'))                             return 'Clean logomark -- love the restraint here.';
  if (l.includes('typography') || l.includes('type')) return 'Typography choices are doing a lot here.';
  if (l.includes('launch'))                           return 'Congrats on the launch -- the work shows!';
  if (l.includes('portfolio'))                        return 'Portfolio looking sharp. Great work.';
  if (l.includes('freelance'))                        return 'The freelance output is real -- looking great!';
  if (l.includes('ui') || l.includes('interface'))    return 'The UI flow here is super clean.';
  if (l.includes('ux'))                               return 'Great UX thinking behind this!';
  if (l.includes('startup') || l.includes('founder')) return 'Love seeing founders prioritize design this early.';
  if (l.includes('product'))                          return 'Product thinking clearly drives the design here.';
  if (l.includes('visual') || l.includes('identity')) return 'Love the visual direction here.';
  return 'Love the creative direction on this one.';
}

function generateDM(username, followers) {
  const rawName = username.replace(/[._\-]/g, ' ').trim().split(' ')[0];
  const Name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  if (followers > 20000) {
    return `Hey ${Name}! The work coming out of your profile is genuinely impressive. I'm Surya, a Senior UI/UX Designer at @designedby.surya. Would love to connect!`;
  }
  const templates = [
    `Hey ${Name}! Came across your work and loved what you're building. I'm Surya, a Senior UI/UX Designer sharing work on interfaces and branding at @designedby.surya. Would love to connect and grow together!`,
    `Hey ${Name}! Your work caught my eye and I'm really impressed. I'm Surya, a Senior UI/UX Designer at @designedby.surya. Would love to connect with fellow creatives!`,
    `Hey ${Name}! Love the creative work you're putting out. I'm Surya, a Senior UI/UX Designer sharing design and branding content at @designedby.surya. Would love to connect!`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

// --- Main ---

async function main() {
  log('=== Instagram Bot Run Start (GitHub Actions) ===');

  const excluded = await getExclusionList();
  if (excluded.size === 0) {
    log('WARN: Exclusion list is empty. Session cookie may be expired.');
    log('Refresh IG_COOKIES secret in GitHub → repo → Settings → Secrets.');
  }

  const alreadyEngaged = loadEngaged();
  log(`Previously engaged: ${alreadyEngaged.size} accounts`);

  log('Searching for fresh accounts...');
  const accounts = await findFreshAccounts(excluded, alreadyEngaged, TARGET_DMS + 5);
  if (accounts.length === 0) {
    log('No valid accounts found. Exiting.');
    return;
  }
  log(`Found ${accounts.length} candidates, targeting up to ${TARGET_DMS} DMs`);

  const results  = [];
  let dmsSent    = 0;

  for (let i = 0; i < accounts.length && dmsSent < TARGET_DMS; i++) {
    const acc = accounts[i];
    log(`\n[${i+1}/${accounts.length}, DMs:${dmsSent}/${TARGET_DMS}] @${acc.username} (${acc.followers} followers)`);

    let liked = false, commented = false, commentText = '', dmSent = false;

    try {
      if (acc.latestMediaId) {
        await sleep(2000 + Math.random() * 2000); // 2-4s before like
        const likeRes = await likePost(acc.latestMediaId);
        liked = likeRes === 'ok';
        log(`  Like: ${likeRes}`);
        await sleep(3000 + Math.random() * 2000); // 3-5s before comment

        if (isDesignRelated(acc.latestCaption)) {
          commentText = generateComment(acc.latestCaption);
          const commentRes = await commentPost(acc.latestMediaId, commentText);
          commented = commentRes === 'ok';
          log(`  Comment: "${commentText}" -> ${commentRes}`);
          await sleep(3000 + Math.random() * 2000); // 3-5s before DM
        }
      } else {
        log('  No posts found');
      }

      const message = generateDM(acc.username, acc.followers);
      const dmRes   = await sendDM(acc.username, message);
      dmSent = dmRes === 'sent';
      log(`  DM: ${dmRes}`);
      if (dmSent) { log(`  Message: "${message}"`); dmsSent++; }

      markEngaged(acc.username);
    } catch(e) {
      log(`  Error: ${e.message}`);
    }

    results.push({ username: acc.username, followers: acc.followers, liked, commented, commentText, dmSent });

    if (dmSent && dmsSent < TARGET_DMS) {
      const delay = 30000 + Math.floor(Math.random() * 30000); // 30–60s between DMs
      log(`  Waiting ${Math.round(delay / 1000)}s before next DM...`);
      await sleep(delay);
    }
  }

  log('\n=== Summary ===');
  for (const r of results) {
    const c = r.commented ? `"${r.commentText}"` : 'no';
    log(`@${r.username} (${r.followers}) | liked:${r.liked} | commented:${c} | dm:${r.dmSent}`);
  }
  log(`Total DMs sent this run: ${dmsSent}/${TARGET_DMS}`);
  log('=== Run Complete ===\n');
}

main().catch(e => {
  log(`Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
