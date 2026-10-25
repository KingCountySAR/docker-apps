import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import nodemailer from 'nodemailer';
import { loadConfig, senderAllowed } from '../src/config.mjs';
import { createMailServer, Stats } from '../src/server.mjs';

// The real SMTP server on localhost, sent to with nodemailer. DNS comes from `records` (so SPF and DKIM pass or fail as
// set up here) and the apps are a fake fetch.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const dkimKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
const dkimRecord = `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`;

const records = {
  // example.org signs with DKIM; spf.example.net only has SPF, for this host; other.example.com has neither.
  'TXT:sel._domainkey.example.org': [[dkimRecord]],
  'TXT:sel._domainkey.elsewhere.example': [[dkimRecord]],
  'TXT:example.org': [['v=spf1 -all']],
  'TXT:spf.example.net': [['v=spf1 ip4:127.0.0.1 -all']],
  'TXT:mail.spf.example.net': [['v=spf1 ip4:127.0.0.1 -all']],
};
async function resolver(name, type) {
  const found = records[`${type}:${name.toLowerCase()}`];
  if (found) return found;
  throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
}

const posts = [];
let answer = () => new Response(JSON.stringify({ id: 1 }), { status: 201 });
async function fakeFetch(url, init) {
  posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return answer(url);
}

const cfg = loadConfig({
  MAIL_HOSTS: 'mail.test, mx.other.test',
  ROUTE_BEEPERS: 'beepers.test http://beepers:4100/api/ingest/email',
  ROUTE_BEEPERS_TOKEN: 'beepers-token',
  ROUTE_REPORTS: 'reports.test http://reports:3000/email',
  ROUTE_REPORTS_TOKEN: 'reports-token',
  ROUTE_REPORTS_SENDERS: 'boss@example.org, @spf.example.net',
});
const stats = new Stats();
const logs = [];
const server = createMailServer(cfg, { stats, resolver, fetch: fakeFetch, log: (l) => logs.push(l) });
let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  posts.length = 0;
  answer = () => new Response(JSON.stringify({ id: 1 }), { status: 201 });
});

/** A message, DKIM-signed by `sign` (a domain) when given, sent with the envelope `mailFrom` and `to`. */
async function send({ from = 'Dispatch <dispatch@example.org>', to = 'callout@beepers.test', mailFrom, sign, subject = 'Callout', text = 'Lost hiker near Mt Si.' } = {}) {
  let raw = Buffer.from(
    [`From: ${from}`, `To: ${[].concat(to).join(', ')}`, `Subject: ${subject}`, 'Message-ID: <1@example.org>', 'Date: Sat, 24 Oct 2026 19:00:00 +0000', 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n'),
  );
  if (sign) {
    const signed = await dkimSign(raw, { signatureData: [{ signingDomain: sign, selector: 'sel', privateKey: dkimKey }] });
    raw = Buffer.concat([Buffer.from(signed.signatures), raw]);
  }
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, name: 'client.test' });
  try {
    return await transport.sendMail({ envelope: { from: mailFrom ?? /<(.*)>/.exec(from)?.[1] ?? from, to }, raw });
  } finally {
    transport.close();
  }
}

/** The SMTP reply code and text a send failed with. */
async function refusal(opts) {
  const err = await send(opts).then(
    () => assert.fail('expected the message to be refused'),
    (e) => e,
  );
  return { code: err.responseCode, text: err.response };
}

describe('mail', () => {
  it('delivers DKIM-signed mail from the From domain to its route, with the token', async () => {
    const info = await send({ sign: 'example.org' });
    assert.match(info.response, /^250 2\.0\.0 Delivered to callout@beepers\.test/);
    assert.equal(posts.length, 1);
    const [post] = posts;
    assert.equal(post.url, 'http://beepers:4100/api/ingest/email');
    assert.equal(post.headers.authorization, 'Bearer beepers-token');
    assert.deepEqual(
      { ...post.body, auth: undefined },
      {
        to: 'callout@beepers.test',
        from: 'dispatch@example.org',
        fromName: 'Dispatch',
        subject: 'Callout',
        text: 'Lost hiker near Mt Si.\n',
        messageId: '<1@example.org>',
        date: '2026-10-24T19:00:00.000Z',
        auth: undefined,
      },
    );
    assert.equal(post.body.auth.by, 'dkim');
  });

  it('delivers mail SPF allows, from a subdomain of the From domain', async () => {
    await send({ from: 'alerts@spf.example.net', mailFrom: 'bounces@mail.spf.example.net' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.auth.by, 'spf');
  });

  it('refuses mail neither SPF nor DKIM vouches for', async () => {
    const { code, text } = await refusal({ from: 'someone@other.example.com' });
    assert.equal(code, 550);
    assert.match(text, /Neither SPF nor DKIM passes for other\.example\.com/);
    assert.equal(posts.length, 0);
  });

  it("refuses a forged From that SPF passes for another domain's envelope", async () => {
    // spf.example.net allows this host, but the From claims example.org, which only signs with DKIM.
    const { code, text } = await refusal({ from: 'dispatch@example.org', mailFrom: 'x@spf.example.net' });
    assert.equal(code, 550);
    assert.match(text, /Neither SPF nor DKIM passes for example\.org \(spf=pass, dkim=none\)/);
    assert.equal(posts.length, 0);
  });

  it("refuses a valid DKIM signature by a domain that isn't the From's", async () => {
    const { code, text } = await refusal({ from: 'dispatch@example.org', mailFrom: 'x@other.example.com', sign: 'elsewhere.example' });
    assert.equal(code, 550);
    assert.match(text, /Neither SPF nor DKIM passes for example\.org \(spf=none, dkim=elsewhere\.example=pass\)/);
  });

  it('refuses recipients in domains without a route, so it never relays', async () => {
    const { code, text } = await refusal({ sign: 'example.org', to: 'someone@gmail.com' });
    assert.equal(code, 550);
    assert.match(text, /Not accepting mail for gmail\.com/);
    assert.equal(posts.length, 0);
  });

  it("refuses senders not in the route's SENDERS", async () => {
    const { code, text } = await refusal({ from: 'dispatch@example.org', sign: 'example.org', to: 'x@reports.test' });
    assert.equal(code, 550);
    assert.match(text, /dispatch@example\.org may not send to reports\.test/);
    await send({ from: 'boss@example.org', sign: 'example.org', to: 'x@reports.test' });
    await send({ from: 'anyone@spf.example.net', to: 'x@reports.test' });
    assert.equal(posts.length, 2);
  });

  it("bounces with the app's error when it refuses the message", async () => {
    answer = () => new Response(JSON.stringify({ error: 'Unknown channel "nope"' }), { status: 404 });
    const { code, text } = await refusal({ sign: 'example.org', to: 'nope@beepers.test' });
    assert.equal(code, 550);
    assert.match(text, /nope@beepers\.test: Unknown channel "nope"/);
  });

  it("asks the sender to try again when the app fails or doesn't answer", async () => {
    answer = () => new Response('Bad gateway', { status: 502 });
    assert.equal((await refusal({ sign: 'example.org' })).code, 451);
    answer = () => {
      throw new TypeError('fetch failed');
    };
    const { code, text } = await refusal({ sign: 'example.org' });
    assert.equal(code, 451);
    assert.match(text, /BEEPERS didn't answer \(fetch failed\)/);
  });

  it('posts once per recipient, to each route', async () => {
    await send({ sign: 'example.org', from: 'boss@example.org', to: ['a@beepers.test', 'b@beepers.test', 'c@reports.test'] });
    assert.deepEqual(
      posts.map((p) => [p.url, p.body.to]),
      [
        ['http://beepers:4100/api/ingest/email', 'a@beepers.test'],
        ['http://beepers:4100/api/ingest/email', 'b@beepers.test'],
        ['http://reports:3000/email', 'c@reports.test'],
      ],
    );
  });

  it('counts what became of each message', () => {
    assert.ok(stats.messages.get('delivered') >= 5);
    assert.ok(stats.messages.get('rejected_auth') >= 3);
    assert.equal(stats.messages.get('rejected_sender'), 1);
    assert.ok(stats.noRoute >= 1);
  });
});

describe('config', () => {
  it('needs a token for each route, and one route per domain', () => {
    assert.throws(() => loadConfig({ ROUTE_A: 'a.test http://a/' }), /needs ROUTE_A_TOKEN/);
    assert.throws(() => loadConfig({ ROUTE_A: 'a.test' }), /must be "<domain> <url>"/);
    assert.throws(
      () => loadConfig({ ROUTE_A: 'a.test http://a/', ROUTE_A_TOKEN: 't', ROUTE_B: 'A.test http://b/', ROUTE_B_TOKEN: 't' }),
      /Two routes for a\.test/,
    );
    assert.equal(loadConfig({}).routes.size, 0);
  });

  it('matches senders by address or @domain, ignoring case', () => {
    assert.ok(senderAllowed([], 'anyone@anywhere.test'));
    assert.ok(senderAllowed(['boss@example.org'], 'Boss@Example.org'));
    assert.ok(senderAllowed(['@example.org'], 'x@example.org'));
    assert.ok(!senderAllowed(['@example.org'], 'x@sub.example.org'));
    assert.ok(!senderAllowed(['boss@example.org'], 'other@example.org'));
  });
});
