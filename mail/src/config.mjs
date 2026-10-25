// The mail service's settings, from config/mail.env on the VM (see mail/README.md). Each route is three variables
// sharing a name:
//
//   ROUTE_BEEPERS=beepers.kingcountysar.org http://beepers:4100/api/ingest/email
//   ROUTE_BEEPERS_TOKEN=<sent as Authorization: Bearer, for the app to check>
//   ROUTE_BEEPERS_SENDERS=dispatch@example.org, @kcesar.org      optional: who may send; any sender when unset

/**
 * @typedef {{ name: string, domain: string, url: string, token: string, senders: string[] }} Route
 * @typedef {{ hostname: string, hostnames: string[], port: number, metricsPort: number, maxBytes: number, timeoutMs: number,
 *   routes: Map<string, Route> }} Config
 */

const list = (value = '') =>
  value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** @returns {Config} */
export function loadConfig(env = process.env) {
  const routes = new Map();
  for (const [key, value] of Object.entries(env)) {
    const match = /^ROUTE_([A-Z0-9_]+)$/.exec(key);
    if (!match || /_(TOKEN|SENDERS)$/.test(key)) continue;
    const name = match[1];
    const [domain, url, ...rest] = (value ?? '').trim().split(/\s+/);
    if (!domain || !url || rest.length) throw new Error(`${key} must be "<domain> <url>"`);
    if (!/^https?:\/\//.test(url)) throw new Error(`${key}: ${url} isn't an http(s) URL`);
    const token = env[`ROUTE_${name}_TOKEN`]?.trim();
    if (!token) throw new Error(`${key} needs ROUTE_${name}_TOKEN, the bearer token its app expects`);
    const d = domain.toLowerCase();
    if (routes.has(d)) throw new Error(`Two routes for ${d}: ${routes.get(d).name} and ${name}`);
    routes.set(d, { name, domain: d, url, token, senders: list(env[`ROUTE_${name}_SENDERS`]) });
  }
  const number = (key, def) => {
    const n = Number(env[key] || def);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a number`);
    return n;
  };
  // Every name the domains' MX records may point at (MAIL_HOSTS, comma separated), each with its own certificate.
  const hostnames = list(env.MAIL_HOSTS);
  if (!hostnames.length) hostnames.push('mail.kingcountysar.org');
  return {
    // The first is the name this server gives in its greeting, and in the Authentication-Results it works out.
    hostname: hostnames[0],
    hostnames,
    port: number('MAIL_PORT', 2525),
    metricsPort: number('METRICS_PORT', 9100),
    maxBytes: number('MAIL_MAX_KB', 5120) * 1024,
    timeoutMs: number('MAIL_POST_TIMEOUT_S', 20) * 1000,
    routes,
  };
}

/** Whether a sender list allows this From address: an address exactly, or @domain for anyone there. Empty: anyone. */
export function senderAllowed(senders, address) {
  if (senders.length === 0) return true;
  const a = address.toLowerCase();
  const domain = a.slice(a.lastIndexOf('@'));
  return senders.includes(a) || senders.includes(domain);
}
