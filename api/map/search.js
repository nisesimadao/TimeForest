/* GET /api/map/search?q= -> Nominatim results ({name, address, lat, lon}),
 * fetched server-side. See web/map-core.js. */
const { search } = require('../../web/map-core');

module.exports = async (req, res) => {
  try {
    res.status(200).json({ list: await search((req.query || {}).q) });
  } catch (e) {
    res.status(502).json({ error: 'search' });
  }
};
