/* Runs in the PAGE's main world (not the content script's isolated world), so
 * it can wrap the page's own fetch. The only thing it watches for is TimeTree
 * creating an event — POST .../calendar/<id>/event — and it forwards the new
 * event's uuid to the content script via postMessage.
 *
 * Why this exists: TimeTree's form saves the location TEXT but never sends
 * coordinates, so the map pin's lat/lon have to be PUT onto the event right
 * after it's created — and to PUT them we need the uuid the server just minted.
 * The POST response carries it ({event:{uuid}}, measured), but only the main
 * world can see the page's fetch. This reads the response and hands the uuid
 * over; the content script does the PUT (it has the session + our lat/lon).
 *
 * It is deliberately tiny and touches nothing else: every request passes
 * through untouched, the response is cloned (never consumed) before reading,
 * and a read failure is swallowed so a wrapped fetch can never break the page.
 */
(() => {
  if (window.__ttxFetchWrapped) return;
  window.__ttxFetchWrapped = true;

  const orig = window.fetch;
  // POST to a calendar's singular /event (create). Not /events (read) and not
  // /event/<uuid> (update) — a trailing segment after event means an update.
  const isCreate = (method, url) =>
    method === 'POST' && /\/calendar\/\d+\/event(?:\?|$)/.test(url);

  window.fetch = async function (input, init) {
    const res = await orig.call(this, input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      if (isCreate(method, url) && res.ok) {
        // Clone so the page still gets an unread body.
        res.clone().json().then((body) => {
          const uuid = body?.event?.uuid || body?.uuid;
          const calendarId = body?.event?.calendar_id;
          if (uuid) {
            window.postMessage({ ttx: 'event-created', uuid, calendarId }, location.origin);
          }
        }).catch(() => { /* not json, or gone — ignore */ });
      }
    } catch { /* never let the wrapper break a real fetch */ }
    return res;
  };
})();
