#!/usr/bin/env node
/* Boot the Electron client headlessly and assert it reaches a usable state.
 *
 * Not an end-to-end test — there's no TimeTree session on a CI runner, so the
 * app should land on the sign-in card. That is exactly what we assert: the main
 * process starts, the preload bridge resolves, the shared libs load off disk,
 * and the renderer decides "signed out" instead of throwing.
 *
 * Run from the client/ directory: node ../scripts/smoke-client.js
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CLIENT = path.join(__dirname, '..', 'client');
const PROBE = path.join(CLIENT, '.smoke-probe.js');

// Injected via --require so it runs inside the main process before app code.
fs.writeFileSync(PROBE, `
const { app } = require('electron');
const fail = (m) => { console.error('SMOKE-FAIL: ' + m); app.exit(1); };
process.on('uncaughtException', (e) => fail('uncaughtException: ' + e.stack));
process.on('unhandledRejection', (e) => fail('unhandledRejection: ' + e));

app.whenReady().then(() => {
  setTimeout(async () => {
    const { BrowserWindow } = require('electron');
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return fail('no window was created');
    try {
      const r = await w.webContents.executeJavaScript(\`(() => ({
        host: typeof window.host,
        libs: window.TTX ? Object.keys(window.TTX).sort() : [],
        body: document.body.innerText.slice(0, 80),
        err: document.getElementById('app')?.textContent?.startsWith('ERROR:') || false,
      }))()\`);
      console.log('SMOKE-STATE: ' + JSON.stringify(r));
      if (r.host !== 'object') return fail('preload bridge missing (window.host)');
      for (const lib of ['api', 'exporters', 'model', 'recur', 'store', 'tz']) {
        if (!r.libs.includes(lib)) return fail('shared lib not loaded: ' + lib);
      }
      if (r.err) return fail('renderer reported: ' + r.body);
      console.log('SMOKE-OK');
      app.exit(0);
    } catch (e) {
      fail('probe threw: ' + e.message);
    }
  }, 12000);
});
`);

const electron = require(path.join(CLIENT, 'node_modules', 'electron'));
const child = spawn(electron, ['--require', PROBE, '.', '--no-sandbox'], {
  cwd: CLIENT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});

const done = (code) => {
  try { fs.unlinkSync(PROBE); } catch { /* ignore */ }
  process.exit(code);
};

const timer = setTimeout(() => {
  console.error('SMOKE-FAIL: timed out');
  child.kill('SIGKILL');
  done(1);
}, 90000);

child.on('exit', (code) => {
  clearTimeout(timer);
  console.log(code === 0 ? 'smoke test passed' : `smoke test failed (exit ${code})`);
  done(code ?? 1);
});
