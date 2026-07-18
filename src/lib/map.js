/* A pannable slippy-map, drawn into a box, with the tile source injected.
 *
 * Split out of the desktop client so the Chrome extension can draw the same map
 * over TimeTree's own event form. Like the rest of src/lib it may touch browser
 * globals (document) but nothing platform-specific: the ONE thing that differs
 * between desktop and extension — where a tile comes from — is a function the
 * caller passes in.
 *
 *   desktop:   getTile = (z,x,y) => window.host.map.tile(z,x,y)   // Electron main
 *   extension: getTile = (z,x,y) => askBackground(z,x,y)          // service worker
 *
 * Both hand back a tile as a data: URI, so neither the renderer's CSP nor the
 * content script's has to be widened to a tile CDN. The reason tiles are fetched
 * off-thread at all is OpenStreetMap's usage policy, which wants a User-Agent
 * that identifies the app — something neither a file:// renderer nor a content
 * script can set, but a main process or a service worker can.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});

  const TILE = 256;

  /** WGS84 -> Web Mercator tile space, in fractional tiles at zoom z. */
  function toTile(lat, lon, z) {
    const n = 2 ** z;
    const rad = (lat * Math.PI) / 180;
    return {
      x: ((lon + 180) / 360) * n,
      y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
    };
  }

  /** And back. */
  function fromTile(x, y, z) {
    const n = 2 ** z;
    const k = Math.PI - (2 * Math.PI * y) / n;
    return {
      lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k))),
      lon: (x / n) * 360 - 180,
    };
  }

  const elem = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };

  /**
   * A map centred on `state` ({lat, lon, z}), drawn into `box`. Dragging pans
   * it and the wheel zooms; both mutate `state` in place and call `onMove`.
   * `getTile(z,x,y)` returns a Promise of a data: URI (or throws, and that
   * tile stays blank). Returns a repaint function — call it once the box has a
   * size, and again whenever `state` is changed from outside.
   */
  function mapView(box, state, getTile, onMove) {
    let dragging = null;

    async function paintTiles() {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      const c = toTile(state.lat, state.lon, state.z);
      // Which tile sits under the top-left corner, and by how much is it off.
      const left = c.x - w / 2 / TILE;
      const top = c.y - h / 2 / TILE;
      const x0 = Math.floor(left);
      const y0 = Math.floor(top);
      const cols = Math.ceil(w / TILE) + 1;
      const rows = Math.ceil(h / TILE) + 1;
      const n = 2 ** state.z;

      const grid = elem('div', 'mp-tiles');
      grid.style.transform =
        `translate(${Math.round((x0 - left) * TILE)}px, ${Math.round((y0 - top) * TILE)}px)`;
      grid.style.gridTemplateColumns = `repeat(${cols}, ${TILE}px)`;

      const want = [];
      for (let dy = 0; dy < rows; dy++) {
        for (let dx = 0; dx < cols; dx++) {
          const img = elem('img', 'mp-t');
          img.width = TILE;
          img.height = TILE;
          img.alt = '';
          grid.appendChild(img);
          const tx = ((x0 + dx) % n + n) % n;   // wrap round the dateline
          const ty = y0 + dy;
          if (ty < 0 || ty >= n) continue;      // no tiles past the poles
          want.push([img, state.z, tx, ty]);
        }
      }
      box.querySelector('.mp-tiles')?.remove();
      box.prepend(grid);
      await Promise.all(want.map(async ([img, z, x, y]) => {
        try { img.src = await getTile(z, x, y); } catch { /* blank */ }
      }));
    }

    box.onpointerdown = (e) => {
      if (e.button !== 0) return;
      dragging = { x: e.clientX, y: e.clientY, moved: 0 };
      box.setPointerCapture(e.pointerId);
      box.classList.add('grabbing');
    };
    box.onpointermove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging.moved += Math.abs(dx) + Math.abs(dy);
      dragging.x = e.clientX;
      dragging.y = e.clientY;
      const c = toTile(state.lat, state.lon, state.z);
      const p = fromTile(c.x - dx / TILE, c.y - dy / TILE, state.z);
      state.lat = Math.max(-85, Math.min(85, p.lat));
      state.lon = ((p.lon + 540) % 360) - 180;
      paintTiles();
      onMove?.();
    };
    const end = (e) => {
      if (!dragging) return;
      box.releasePointerCapture(e.pointerId);
      box.classList.remove('grabbing');
      dragging = null;
    };
    box.onpointerup = end;
    box.onpointercancel = end;
    box.onwheel = (e) => {
      e.preventDefault();
      const z = Math.max(2, Math.min(18, state.z + (e.deltaY < 0 ? 1 : -1)));
      if (z === state.z) return;
      state.z = z;
      paintTiles();
      onMove?.();
    };

    return paintTiles;
  }

  TTX.map = { TILE, toTile, fromTile, mapView };
})();
