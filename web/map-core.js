/* Map backend for the browser client — the server-side counterpart of the
 * extension's bg.js map handlers. The renderer's map picker needs OSM tiles and
 * Nominatim search; a browser page can't fetch them into a data: URI (tile
 * servers don't all send CORS), and shouldn't talk to a third party directly
 * anyway. So the server fetches them and the page only ever sees same-origin
 * responses — the CSP stays shut (img-src 'self' data:, connect-src 'self').
 *
 * Unlike the MV3 worker, a Node server CAN set a User-Agent, which OSM's tile
 * policy requires; we identify the client honestly. Shared by the dev server and
 * the Vercel functions. */
const OSM_TILES = 'https://tile.openstreetmap.org';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'TimeForest/0.1 (self-hosted TimeTree web client; https://github.com/nisesimadao/TimeForest)';

async function tile(z, x, y) {
  z = Number(z); x = Number(x); y = Number(y);
  if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0) || z > 19) throw new Error('bad tile');
  if (x >= 2 ** z || y >= 2 ** z) throw new Error('tile out of range');
  const r = await fetch(`${OSM_TILES}/${z}/${x}/${y}.png`, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error('tile ' + r.status);
  return { contentType: 'image/png', body: Buffer.from(await r.arrayBuffer()) };
}

async function search(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  const u = new URL(NOMINATIM);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '8');
  u.searchParams.set('accept-language', 'ja');
  const r = await fetch(u, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error('search ' + r.status);
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map((it) => ({
    name: it.name || (it.display_name || '').split(',')[0],
    address: it.display_name,
    lat: Number(it.lat),
    lon: Number(it.lon),
  }));
}

module.exports = { tile, search };
