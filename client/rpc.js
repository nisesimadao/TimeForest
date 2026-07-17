/* A local door into the running app, for the CLI (and later, MCP).
 *
 * The point is that the app is a TRAY app: it is normally running, and it
 * already holds every event in memory. Asking it is instant, where a separate
 * process has to re-sync 4298 events first — measured, 8 seconds.
 *
 * It is deliberately not a network server. A named pipe on Windows and a unix
 * socket under userData elsewhere: both are reachable only by the user who owns
 * the session, which is the same trust boundary as the app itself. There is no
 * port to leave open and nothing to authenticate, because the OS already did.
 *
 * The work happens in the RENDERER, not here. The store lives there — the whole
 * cache, the recurrence expansion, the holiday merge. Reaching it via
 * executeJavaScript rather than adding an IPC channel keeps preload.js as small
 * as it is: the renderer's door to Node stays exactly as wide as it was.
 *
 * Protocol: one JSON object per line.
 *   → {"id":1,"cmd":"ls","args":{...}}
 *   ← {"id":1,"ok":true,"data":…}   or   {"id":1,"ok":false,"error":"…"}
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * One pipe per profile. Two TimeForests with different userData (a packaged
 * build and a checkout, say) must not answer each other's CLI — the answer
 * would be right about a calendar you didn't ask about.
 */
function socketPath(userDataDir) {
  const tag = crypto.createHash('sha1').update(userDataDir).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\timeforest-${tag}`
    : path.join(userDataDir, `tf-${tag}.sock`);
}

/**
 * @param {object} o
 * @param {string} o.userDataDir
 * @param {() => Promise<any>} o.dispatch  called with {cmd, args}, returns the payload
 */
function serve({ userDataDir, dispatch }) {
  const file = socketPath(userDataDir);

  // A unix socket outlives the process that made it. A stale one from a crash
  // would make listen() fail with EADDRINUSE forever — and the single-instance
  // lock already proved nobody else is here.
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(file); } catch { /* not there: good */ }
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', async (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let id = null;
        try {
          const req = JSON.parse(line);
          id = req.id ?? null;
          const data = await dispatch(req);
          sock.write(JSON.stringify({ id, ok: true, data }) + '\n');
        } catch (e) {
          sock.write(JSON.stringify({ id, ok: false, error: String(e?.message || e) }) + '\n');
        }
      }
    });
    // A CLI that hangs up mid-answer is normal (^C). Not an error.
    sock.on('error', () => {});
  });

  server.on('error', (e) => console.error('[rpc] ' + e.message));
  server.listen(file, () => console.log('[rpc] listening on ' + file));
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  return { server, file };
}

module.exports = { serve, socketPath };
