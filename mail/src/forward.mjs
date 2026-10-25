// POSTs one message to its route's app, as JSON with the route's bearer token:
//
//   { "to": "callout@beepers.kingcountysar.org", "from": "dispatch@example.org", "fromName": "Dispatch",
//     "subject": "...", "text": "...", "messageId": "<...>", "date": "2026-10-24T19:00:00.000Z",
//     "auth": { "by": "dkim", "spf": "pass", "dkim": ["example.org=pass"] } }
//
// What the app answers decides the SMTP reply: 2xx delivered; 4xx refused for good (the sender gets a bounce with the
// app's "error", like "Unknown channel"); anything else (5xx, no answer in time) is temporary, so the sending server
// tries again later.

/** @typedef {{ status: 'ok' } | { status: 'rejected', message: string } | { status: 'deferred', message: string }} Outcome */

/**
 * @param {import('./config.mjs').Route} route
 * @param {object} payload
 * @param {{ timeoutMs: number, fetch?: typeof fetch }} opts
 * @returns {Promise<Outcome>}
 */
export async function forward(route, payload, { timeoutMs, fetch: fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(route.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: 'deferred', message: `${route.name} didn't answer (${err.name === 'TimeoutError' ? 'timed out' : err.message})` };
  }
  if (res.ok) return { status: 'ok' };
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 200);
  try {
    message = JSON.parse(text).error ?? message;
  } catch {
    // not JSON: the text itself
  }
  message = String(message).replace(/[\r\n]+/g, ' ').trim() || `HTTP ${res.status}`;
  return res.status >= 400 && res.status < 500 ? { status: 'rejected', message } : { status: 'deferred', message };
}
