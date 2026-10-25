import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { loadConfig } from './config.mjs';
import { createMailServer, Stats } from './server.mjs';

const cfg = loadConfig();
const stats = new Stats();
const log = (line) => console.log(line);

// STARTTLS, with the certificates Caddy gets for the mail host names (the mail service's caddy labels give each a site),
// from Caddy's folder of certificates mounted at TLS_DIR. A sender asks for the name its MX record gave (SNI) and gets
// that one; one asking for none, or another name, gets the first host name's (or the first there is). Caddy renews them
// every couple of months, and gets one for a host name added later: checked hourly.
const TLS_DIR = process.env.TLS_DIR || '/certs';

/** Caddy's certificate and key for a host name, preferring Let's Encrypt's real CA to its staging one. */
function findCertificate(hostname) {
  let cas;
  try {
    cas = readdirSync(TLS_DIR).sort((a, b) => Number(a.includes('staging')) - Number(b.includes('staging')));
  } catch {
    return null;
  }
  for (const ca of cas) {
    const base = join(TLS_DIR, ca, hostname, hostname);
    try {
      return { certPath: `${base}.crt`, keyPath: `${base}.key`, mtime: statSync(`${base}.crt`).mtimeMs };
    } catch {
      // not from this CA
    }
  }
  return null;
}

/**
 * Each host name's certificate, by name.
 * @type {Map<string, { certPath: string, mtime: number, cert: Buffer, key: Buffer, context: import('node:tls').SecureContext }>}
 */
const certificates = new Map();
const fallback = () => certificates.get(cfg.hostname) ?? certificates.values().next().value;

/** Reads each host name's certificate that's new or renewed since last time. Whether any was. */
function loadCertificates() {
  let changed = false;
  for (const hostname of cfg.hostnames) {
    const found = findCertificate(hostname);
    const had = certificates.get(hostname);
    if (!found || found.mtime === had?.mtime) continue;
    const cert = readFileSync(found.certPath);
    const key = readFileSync(found.keyPath);
    certificates.set(hostname, { ...found, cert, key, context: createSecureContext({ cert, key }) });
    log(`mail: ${had ? 'reloaded' : 'STARTTLS with'} ${found.certPath}`);
    changed = true;
  }
  return changed;
}

loadCertificates();
const missing = cfg.hostnames.filter((h) => !certificates.has(h));
if (!certificates.size) {
  log(`mail: no certificate for ${missing.join(', ')} in ${TLS_DIR} yet; STARTTLS is off until there is one (restart then)`);
} else if (missing.length) {
  log(`mail: no certificate for ${missing.join(', ')} yet (picked up within an hour of Caddy getting it)`);
}
const tls = certificates.size
  ? {
      cert: fallback().cert,
      key: fallback().key,
      SNICallback: (servername, cb) => cb(null, (certificates.get(servername.toLowerCase()) ?? fallback()).context),
    }
  : null;

const server = createMailServer(cfg, { stats, tls, log });
server.on('error', (err) => log(`mail: ${err.message}`));
server.listen(cfg.port, () => {
  const routes = [...cfg.routes.values()].map((r) => `${r.domain} -> ${r.url}`);
  log(`mail: listening on :${cfg.port} as ${cfg.hostname}; routes: ${routes.join(', ') || 'none, so all mail is refused'}`);
});

const reload = setInterval(() => {
  // The SNI callback reads the map; only the default (for senders without SNI) needs giving to the server again.
  if (tls && loadCertificates()) server.updateSecureContext({ cert: fallback().cert, key: fallback().key });
}, 3600_000);

// Prometheus's apps job collects this (the kcsara.metrics label in mail/compose.yaml).
const metrics = createServer((req, res) => {
  if (req.url !== '/metrics') return res.writeHead(404).end();
  const lines = [
    '# HELP mail_messages_total Messages received, by what became of them',
    '# TYPE mail_messages_total counter',
    // From 0, so increase() counts the first of each after a restart.
    ...['delivered', 'rejected_auth', 'rejected_sender', 'rejected_app', 'deferred', 'too_large'].map(
      (result) => `mail_messages_total{result="${result}"} ${stats.messages.get(result) ?? 0}`,
    ),
    '# HELP mail_recipients_no_route_total Recipients refused for a domain with no route',
    '# TYPE mail_recipients_no_route_total counter',
    `mail_recipients_no_route_total ${stats.noRoute}`,
    '# HELP mail_starttls 1 when STARTTLS is offered',
    '# TYPE mail_starttls gauge',
    `mail_starttls ${tls ? 1 : 0}`,
  ];
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(lines.join('\n') + '\n');
});
if (cfg.metricsPort > 0) metrics.listen(cfg.metricsPort);

const shutdown = () => {
  clearInterval(reload);
  metrics.close();
  server.close(() => process.exit(0));
  // Connections still open after this long are cut off; their senders try again.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
