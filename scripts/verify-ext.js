#!/usr/bin/env node
/* Verify the Chrome extension's injections into TimeTree's own pages.
 *
 * The extension adds things to TimeTree's UI by hooking hand-written anchors
 * (data-test-id, input[name]) and injecting siblings that survive React's
 * re-renders. All of that is invisible to the structural checks and breaks
 * silently on a TimeTree redeploy, so it needs its own end-to-end check.
 *
 * Two layers, cheapest first:
 *   1. injection logic against a faithful copy of TimeTree's form DOM, in a real
 *      engine (the client's Chromium over CDP). No login, no network.
 *   2. the real extension loaded into Chromium, proving it boots and its
 *      service worker answers — the part unit DOM can't cover.
 *
 * Usage: npm run verify:ext   (needs a client on :9333 for layer 1;
 *        layer 2 launches its own Chromium via playwright's bundled build)
 */
const { chromium } = require('playwright-core');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const sec = (t) => console.log('\n' + t);
const check = (c, m) => (c ? ok(m) : bad(m));

(async () => {
  // --- layer 1: injection logic on a faithful form DOM ----------------------
  sec('map pin injects into TimeTree\'s own event form');
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333').catch(() => null);
  if (!b) {
    bad('no client on :9333 for the DOM sandbox — start one with `npm run inspect`');
  } else {
    const page = b.contexts()[0].pages().find((x) => x.url().includes('index.html'));
    // Reload first. A MutationObserver from a previous verify:ext run stays
    // watching document.body and re-injects into any new event-form — so the
    // "no button in userscript build" case saw a button that a PAST run's
    // observer had added, not this run's. The renderer outlives the test; wipe
    // it. (Same reload-first rule the DOM verify scripts learned the hard way.)
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/mapform.js'), 'utf8');
    const r = await page.evaluate(async (mapformSrc) => {
      document.getElementById('ttxtest')?.remove();
      const box = document.createElement('div');
      box.id = 'ttxtest';
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff';
      // The shape captured off TimeTree's real form: an event-form with a
      // location input nested in hashed-class rows.
      box.innerHTML = `
        <div data-test-id="event-form"><div data-test-id="event-form-scroll-area">
          <div><textarea name="title"></textarea></div>
          <div class="h1"><div class="h2"><input name="location" placeholder="場所を追加"></div></div>
          <div><input name="url"></div>
        </div><button data-test-id="event-form-submit-button">保存</button></div>`;
      document.body.appendChild(box);

      // Set chrome explicitly, not with ||: the Electron renderer this test
      // borrows may already have a partial chrome.* and we must not depend on
      // its shape. The extension environment has sendMessage; that's what makes
      // the button appear.
      const savedChrome = window.chrome;
      window.chrome = {
        runtime: { sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      };

      (0, eval)(mapformSrc);              // eslint-disable-line no-eval
      window.TTX.mapform.start();
      await new Promise((r2) => setTimeout(r2, 100));

      const btn = box.querySelector('[data-ttx-mapform]');
      const loc = box.querySelector('input[name="location"]');
      const locRow = loc.closest('div');
      const out = {
        count: box.querySelectorAll('[data-ttx-mapform]').length,
        sibling: btn && btn.parentElement === locRow.parentElement && !locRow.contains(btn),
        after: btn && locRow.nextElementSibling === btn,
        type: btn?.getAttribute('type'),
      };
      // Churn the DOM: must not double-inject.
      document.body.appendChild(document.createElement('span'));
      await new Promise((r2) => setTimeout(r2, 80));
      out.afterChurn = box.querySelectorAll('[data-ttx-mapform]').length;
      // React re-renders the row's inner node: a sibling button must remain.
      (locRow.querySelector('div') || locRow).innerHTML = '<input name="location">';
      await new Promise((r2) => setTimeout(r2, 80));
      out.survived = box.querySelectorAll('[data-ttx-mapform]').length;
      window.TTX.mapform.stop();     // don't leave the observer watching body
      box.remove();
      window.chrome = savedChrome;
      return out;
    }, src);

    check(r.count === 1, `injects exactly one button (${r.count})`);
    check(r.sibling, 'as a sibling of the location row, not a child React owns');
    check(r.after, 'right after the location row');
    check(r.type === 'button', 'as type=button, so it never submits the form');
    check(r.afterChurn === 1, 'and unrelated DOM churn does not double-inject');
    check(r.survived === 1, 'and it survives React re-rendering the location row');

    // On the phone (userscript build) there is no service worker to reach OSM,
    // so the button must NOT appear — a button that hangs when pressed is worse
    // than no button. The userscript's chrome shim has storage + onMessage but
    // not sendMessage; simulate exactly that.
    const noBtn = await page.evaluate(async (mapformSrc) => {
      document.getElementById('ttxtest2')?.remove();
      const box = document.createElement('div');
      box.id = 'ttxtest2';
      box.innerHTML = '<div data-test-id="event-form"><div><input name="location"></div></div>';
      document.body.appendChild(box);
      // The userscript shim: storage + onMessage, but no sendMessage.
      const saved = window.chrome;
      window.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { onMessage: { addListener() {} } } };
      delete window.TTX.mapform;
      (0, eval)(mapformSrc);              // eslint-disable-line no-eval
      window.TTX.mapform.start();
      await new Promise((r2) => setTimeout(r2, 100));
      const n = box.querySelectorAll('[data-ttx-mapform]').length;
      box.remove();
      window.chrome = saved;
      return n;
    }, src);
    check(noBtn === 0, 'and shows no button in the userscript build, where there is no worker behind it');

    // The picker itself: opens, tiles paint, search populates, 決定 writes the
    // chosen place back into TimeTree's own <input> the React way and remembers
    // lat/lon (which TimeTree's POST omits). A 1px png stands in for a tile and
    // sendMessage is stubbed, so no network and no login.
    sec('the map picker opens over the form and writes back');
    const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const pk = await page.evaluate(async ({ mapformSrc, px }) => {
      document.getElementById('pk')?.remove();
      const box = document.createElement('div');
      box.id = 'pk';
      box.innerHTML = '<div data-test-id="event-form"><div><input name="location" value="旧"></div></div>';
      document.body.appendChild(box);
      const input = box.querySelector('input[name="location"]');

      const savedChrome = window.chrome; const savedConfirm = window.confirm;
      window.confirm = () => true;
      window.chrome = {
        storage: { local: { get: async () => ({ maps: true }), set: async () => {} } },
        runtime: {
          sendMessage(msg, cb) {
            if (msg.ttx === 'tile') cb({ uri: px });
            else if (msg.ttx === 'search') cb({ list: [{ name: '東京駅', address: '東京都千代田区', lat: 35.681, lon: 139.767 }] });
            else cb({});
          },
          lastError: null, onMessage: { addListener() {} },
        },
      };

      delete window.TTX.mapform;
      (0, eval)(mapformSrc);            // eslint-disable-line no-eval
      window.TTX.mapform.start();
      box.querySelector('[data-ttx-mapform]').click();
      await new Promise((r2) => setTimeout(r2, 400));

      const scrim = document.querySelector('.ttx-mf-scrim');
      const out = { opened: !!scrim };
      if (scrim) {
        const t = scrim.querySelectorAll('.mp-t');
        out.tiles = t.length;
        out.tilesLoaded = [...t].filter((i) => i.src.startsWith('data:')).length;
        const q = scrim.querySelector('.ttx-mf-q');
        q.value = '東京'; q.dispatchEvent(new Event('input'));
        await new Promise((r2) => setTimeout(r2, 550));
        out.hits = scrim.querySelectorAll('.ttx-mf-r').length;
        scrim.querySelector('.ttx-mf-r')?.click();
        await new Promise((r2) => setTimeout(r2, 60));
        scrim.querySelector('.ttx-mf-btn.pri')?.click();
        await new Promise((r2) => setTimeout(r2, 60));
        out.wroteBack = input.value;
        out.closed = !document.querySelector('.ttx-mf-scrim');
        out.pending = window.TTX.mapform._pending;
      }
      window.TTX.mapform.stop?.();
      document.querySelector('.ttx-mf-scrim')?.remove();
      box.remove();
      window.chrome = savedChrome; window.confirm = savedConfirm;
      return out;
    }, { mapformSrc: src, px: PX });

    check(pk.opened, 'the picker opens');
    check(pk.tiles > 0 && pk.tilesLoaded === pk.tiles, `tiles paint (${pk.tilesLoaded}/${pk.tiles})`);
    check(pk.hits === 1, `search populates from the worker (${pk.hits})`);
    check(pk.wroteBack === '東京駅', `決定 writes the place into TimeTree's own input (${pk.wroteBack})`);
    check(!!pk.pending && Math.abs(pk.pending.lat - 35.681) < 0.01, 'and remembers lat/lon for the save hook');
    check(pk.closed, 'and closes');

    await b.close();
  }

  // --- layer 2: the real extension boots ------------------------------------
  //
  // system Chrome + --load-extension is unreliable (the extension silently
  // doesn't load); playwright's bundled Chromium loads it. This proves the
  // manifest is valid, the service worker starts, and OSM is reachable from it —
  // the design premise of the map, which no unit DOM can check.
  sec('the packed extension loads and its worker reaches OSM');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttx-ext-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: false,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  }).catch((e) => { bad('extension failed to launch: ' + e.message); return null; });

  if (ctx) {
    const p = await ctx.newPage();
    await p.goto('https://timetreeapp.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(2000);
    let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null);
    check(!!sw, `the service worker starts (${sw ? sw.url().replace(/^chrome-extension:\/\//, '').slice(0, 24) + '…' : 'never appeared'})`);

    if (sw) {
      const r = await sw.evaluate(async () => {
        const out = {};
        await chrome.storage.local.set({ maps: false });
        try { await tile(13, 7280, 3225); out.off = false; } catch { out.off = true; }
        await chrome.storage.local.set({ maps: true });
        try { const u = await tile(13, 7280, 3225); out.tile = /^data:image\/png/.test(u); } catch (e) { out.tile = 'ERR ' + e.message; }
        try { const s = await search('東京駅'); out.search = Array.isArray(s) && s.length > 0; } catch (e) { out.search = 'ERR ' + e.message; }
        return out;
      }).catch((e) => ({ evalErr: e.message }));
      check(r.off === true, 'tiles are refused while maps are off (the default)');
      check(r.tile === true, `and returned as a data: png once on (${r.tile})`);
      check(r.search === true, `and Nominatim search works from the worker (${r.search})`);
    }
    await ctx.close();
  }
  fs.rmSync(userDir, { recursive: true, force: true });

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message); process.exit(1); });
