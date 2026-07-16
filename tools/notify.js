#!/usr/bin/env node
/* Post a build/feature notification to Discord.
 *
 * The webhook URL is a credential — anyone holding it can post as us — so it
 * never lives in the repo. Read from $TIMEFOREST_DISCORD_WEBHOOK, else from
 * .local/discord-webhook.txt (git-ignored).
 *
 * Usage:
 *   node tools/notify.js "タイトル" "本文"
 *   node tools/notify.js --push                      # summarise the last commit
 *   node tools/notify.js --json '{"title":..,"fields":[..]}'
 *   echo '{"title":..}' | node tools/notify.js --json -
 *
 * Options:
 *   --color <hex>   accent bar (default TimeForest green)
 *   --no-mention    don't @ anyone
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, '.local');

function webhook() {
  if (process.env.TIMEFOREST_DISCORD_WEBHOOK) return process.env.TIMEFOREST_DISCORD_WEBHOOK.trim();
  const f = path.join(LOCAL, 'discord-webhook.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('webhook が見つかりません: $TIMEFOREST_DISCORD_WEBHOOK か .local/discord-webhook.txt');
}

/**
 * A numeric snowflake is the only thing Discord turns into a real ping —
 * "@name" is just text. Optional: without it we still post, just silently.
 */
function mention() {
  const f = path.join(LOCAL, 'discord-user-id.txt');
  const id = process.env.TIMEFOREST_DISCORD_USER_ID
    || (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');
  return /^\d{5,}$/.test(id) ? `<@${id}>` : '@nisesimadao';
}

const git = (cmd) => {
  try { return execSync('git ' + cmd, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; }
};

function lastCommitEmbed() {
  const subject = git('log -1 --format=%s');
  const bodyText = git('log -1 --format=%b').split('\n\n')[0].slice(0, 900);
  const sha = git('rev-parse --short HEAD');
  const stat = git('show --stat --format= HEAD').trim().split('\n').slice(-1)[0] || '';
  const remote = git('remote get-url origin').replace(/\.git$/, '');
  return {
    title: '⬆ push: ' + subject,
    url: remote && sha ? `${remote}/commit/${sha}` : undefined,
    description: bodyText || undefined,
    fields: [{ name: 'commit', value: '`' + sha + '` — ' + (stat || 'n/a') }],
  };
}

function parseArgs(argv) {
  const o = { color: 0x2ecc87, mention: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') o.push = true;
    else if (a === '--no-mention') o.mention = false;
    else if (a === '--color') o.color = parseInt(argv[++i].replace('#', ''), 16);
    else if (a === '--json') o.json = argv[++i];
    else rest.push(a);
  }
  o.rest = rest;
  return o;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  let embed;

  if (o.push) {
    embed = lastCommitEmbed();
  } else if (o.json) {
    const raw = o.json === '-' ? await readStdin() : o.json;
    embed = JSON.parse(raw);
  } else {
    const [title, ...body] = o.rest;
    if (!title) {
      console.error('usage: node tools/notify.js "タイトル" "本文" | --push | --json <obj|->');
      process.exit(2);
    }
    embed = { title, description: body.join(' ') || undefined };
  }

  embed.color = embed.color ?? o.color;
  embed.timestamp = new Date().toISOString();
  // This channel is one-way on purpose. A webhook can only send; reading
  // replies needs a bot, and the local reply server the footer used to
  // advertise (localhost:8787) was never finished — and couldn't have worked
  // from away from the machine anyway, which was the entire point of it.
  embed.footer = embed.footer ?? { text: 'TimeForest — 進捗通知（送信専用）' };

  const payload = {
    username: 'TimeForest',
    content: o.mention ? mention() : undefined,
    allowed_mentions: { parse: ['users'] },
    embeds: [embed],
  };

  const res = await fetch(webhook() + '?wait=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('discord ' + res.status + ': ' + text.slice(0, 300));
    process.exit(1);
  }
  console.log('notified:', embed.title);
})();
