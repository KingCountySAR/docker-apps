import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { checkAuthentication } from './check.mjs';
import { senderAllowed } from './config.mjs';
import { forward } from './forward.mjs';

/** The SMTP error a handler passes back: the code and enhanced status the sender sees. */
const smtpError = (code, message) => Object.assign(new Error(message), { responseCode: code });

const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
/** IPv4 clients show up as ::ffff:1.2.3.4 on a dual-stack socket; SPF wants 1.2.3.4. */
const plainIp = (ip = '') => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

/** Counters for /metrics: messages by result, and recipients refused for having no route. */
export class Stats {
  messages = new Map();
  noRoute = 0;
  count(result) {
    this.messages.set(result, (this.messages.get(result) ?? 0) + 1);
  }
}

/**
 * The SMTP server: recipients only in a routed domain, so it never relays; then each message is checked (SPF/DKIM,
 * its route's senders) and POSTed to the app.
 *
 * @param {import('./config.mjs').Config} cfg
 * @param {{ stats: Stats, tls?: { key: Buffer, cert: Buffer, SNICallback?: Function } | null, resolver?: Function, fetch?: typeof fetch,
 *   log?: (line: string) => void }} deps
 */
export function createMailServer(cfg, { stats, tls = null, resolver, fetch, log = console.log }) {
  const server = new SMTPServer({
    name: cfg.hostname,
    banner: 'KCSARA mail',
    size: cfg.maxBytes,
    // Mail in, never mail out: there's nothing to sign in to.
    authOptional: true,
    disabledCommands: tls ? ['AUTH'] : ['AUTH', 'STARTTLS'],
    ...(tls ?? {}),
    maxClients: 50,
    logger: false,

    onRcptTo(address, session, callback) {
      const domain = domainOf(address.address);
      if (!cfg.routes.has(domain)) {
        stats.noRoute++;
        return callback(smtpError(550, `5.7.1 Not accepting mail for ${domain}`));
      }
      if (session.envelope.rcptTo.length >= 10) return callback(smtpError(452, '4.5.3 Too many recipients'));
      callback();
    },

    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => {
        if (!stream.sizeExceeded) chunks.push(chunk);
      });
      stream.on('error', callback);
      stream.on('end', () => {
        if (stream.sizeExceeded) {
          stats.count('too_large');
          return callback(smtpError(552, `5.3.4 Over ${Math.round(cfg.maxBytes / 1024)} KB`));
        }
        receive(Buffer.concat(chunks), session).then(
          (reply) => callback(null, reply),
          (err) => {
            if (!err.responseCode) {
              log(`mail: error: ${err.stack ?? err}`);
              err = smtpError(451, '4.3.0 Something went wrong here; try again later');
            }
            callback(err);
          },
        );
      });
    },
  });

  async function receive(raw, session) {
    const envelopeFrom = session.envelope.mailFrom?.address ?? '';
    const recipients = session.envelope.rcptTo.map((r) => r.address);
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const from = parsed.from?.value ?? [];
    const summary = `from=${from[0]?.address ?? '?'} to=${recipients.join(',')} ip=${plainIp(session.remoteAddress)}`;
    const refuse = (result, code, message) => {
      stats.count(result);
      log(`mail: ${result} ${summary}: ${message}`);
      return smtpError(code, message);
    };

    if (from.length !== 1 || !from[0].address) throw refuse('rejected_auth', 550, '5.7.1 Needs exactly one From address');
    const fromAddress = from[0].address.toLowerCase();

    const auth = await checkAuthentication(raw, {
      ip: plainIp(session.remoteAddress),
      helo: session.hostNameAppearsAs,
      sender: envelopeFrom,
      mta: cfg.hostname,
      fromAddress,
      resolver,
    });
    if (!auth.pass) {
      throw refuse(
        'rejected_auth',
        550,
        `5.7.1 Neither SPF nor DKIM passes for ${domainOf(fromAddress)} (spf=${auth.spf}, dkim=${auth.dkim.join(' ') || 'none'})`,
      );
    }

    const payload = {
      from: fromAddress,
      fromName: from[0].name ?? '',
      subject: parsed.subject ?? '',
      text: parsed.text ?? '',
      messageId: parsed.messageId ?? '',
      date: (parsed.date ?? new Date()).toISOString(),
      auth: { by: auth.by, spf: auth.spf, dkim: auth.dkim },
    };

    // One POST per recipient. A message to several only gets one reply, so a temporary failure for any of them asks
    // the sender to try them all again later (and the others may get it twice); a refusal for any, with none
    // temporary, bounces it.
    const outcomes = [];
    for (const to of recipients) {
      const route = cfg.routes.get(domainOf(to));
      if (!senderAllowed(route.senders, fromAddress)) {
        outcomes.push({ to, status: 'rejected', message: `${fromAddress} may not send to ${route.domain}` });
        continue;
      }
      const outcome = await forward(route, { ...payload, to: to.toLowerCase() }, { timeoutMs: cfg.timeoutMs, fetch });
      outcomes.push({ to, ...outcome });
    }

    const deferred = outcomes.filter((o) => o.status === 'deferred');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    const detail = (list) => list.map((o) => `${o.to}: ${o.message}`).join('; ');
    if (deferred.length) throw refuse('deferred', 451, `4.4.0 ${detail(deferred)}`);
    if (rejected.length) {
      const result = rejected.every((o) => o.message.includes(' may not send to ')) ? 'rejected_sender' : 'rejected_app';
      throw refuse(result, 550, `5.7.1 ${detail(rejected)}`);
    }
    stats.count('delivered');
    log(`mail: delivered ${summary} by=${auth.by}`);
    return `2.0.0 Delivered to ${recipients.length === 1 ? recipients[0] : `${recipients.length} recipients`}`;
  }

  return server;
}
