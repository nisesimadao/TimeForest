/* GET /api/map/tile?z=&x=&y= -> an OSM tile PNG, fetched server-side with a
 * proper User-Agent. Same-origin, so the page's CSP never has to allow a tile
 * CDN. See web/map-core.js. */
const { tile } = require('../../web/map-core');

module.exports = async (req, res) => {
  try {
    const { z, x, y } = req.query || {};
    const t = await tile(z, x, y);
    res.setHeader('content-type', t.contentType);
    res.setHeader('cache-control', 'public, max-age=604800');
    res.status(200).send(t.body);
  } catch (e) {
    res.status(502).json({ error: 'tile' });
  }
};
