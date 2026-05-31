#!/usr/bin/env node
// Instagram community-building bot for @designedby.surya
// Runs on GitHub Actions — no Chrome, no osascript, pure HTTPS (Node 18+ built-in fetch)

const fs   = require('fs');
const path = require('path');

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

// --- Account discovery ---

async function findFreshAccounts(excluded, alreadyEngaged, needed = 18) {
  const queries = [
    'ux designer portfolio', 'brand identity designer', 'logo design studio',
    'product designer freelance', 'ui designer work', 'design founder',
    'branding designer', 'visual designer portfolio', 'app designer',
    'website designer portfolio', 'graphic designer work', 'design studio agency',
    'saas designer', 'mobile app designer', 'typography designer',
    'motion designer portfolio', 'illustration designer', 'icon designer',
    'design system', 'figma designer', 'web designer portfolio',
    'creative designer', 'design consultant', 'startup design',
    'ux researcher', 'interaction designer', 'design lead',
  ];

  const tried     = new Set();
  const verified  = [];

  for (const q of queries) {
    if (verified.length >= needed) break;
    const sd = await igGet(
      `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(q)}&include_reel=false`
    );
    const candidates = (sd?.users || []).map(u => ({
      username: u.user.username,
      private: u.user.is_private,
    }));
    await sleep(500);

    for (const c of candidates) {
      if (verified.length >= needed) break;
      if (
        tried.has(c.username) ||
        excluded.has(c.username) ||
        c.username === OWN_ACCOUNT ||
        c.private ||
        alreadyEngaged.has(c.username)
      ) continue;
      tried.add(c.username);

      const pd = await igGet(`/api/v1/users/web_profile_info/?username=${c.username}`);
      const u  = pd?.data?.user;
      await sleep(400);
      if (!u || u.is_private) continue;

      const fc = u.edge_followed_by?.count || 0;
      if (fc < 200 || fc > 150000) continue;
      if (excluded.has(u.username) || u.username === OWN_ACCOUNT || alreadyEngaged.has(u.username)) continue;

      const edge = u.edge_owner_to_timeline_media?.edges?.[0]?.node;
      verified.push({
        username:      u.username,
        followers:     fc,
        pk:            u.id,
        latestMediaId: edge?.id || null,
        latestCaption: edge?.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      });
      log(`  Found @${u.username} (${fc} followers)`);
    }
  }
  return verified;
}

// --- Engagement ---

async function likePost(mediaId) {
  const d = await igPost(`/api/v1/web/likes/${mediaId}/like/`, {});
  return d?.status || 'unknown';
}

async function commentPost(mediaId, text) {
  const d = await igPost(`/api/v1/web/comments/${mediaId}/add/`, { comment_text: text });
  return d?.status || 'unknown';
}

async function sendDM(userPk, message) {
  // Broadcast API works correctly in pure HTTP context (outside browser)
  const d = await igPost(`/api/v1/direct_v2/threads/broadcast/text/`, {
    recipient_users: `[[${userPk}]]`,
    text: message,
  });
  if (d?.status === 'ok' || d?.payload?.thread_id) return 'sent';
  log(`  DM raw response: ${JSON.stringify(d)?.slice(0, 150)}`);
  return 'failed';
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
        const likeRes = await likePost(acc.latestMediaId);
        liked = likeRes === 'ok';
        log(`  Like: ${likeRes}`);
        await sleep(1000);

        if (isDesignRelated(acc.latestCaption)) {
          commentText = generateComment(acc.latestCaption);
          const commentRes = await commentPost(acc.latestMediaId, commentText);
          commented = commentRes === 'ok';
          log(`  Comment: "${commentText}" -> ${commentRes}`);
          await sleep(1500);
        }
      } else {
        log('  No posts found');
      }

      const message = generateDM(acc.username, acc.followers);
      const dmRes   = await sendDM(acc.pk, message);
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
