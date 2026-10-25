# Mail

Receives email for the apps, on port 25, and POSTs each message to the app its domain routes to: pages for beepers
come in as `<channel>@beepers.kingcountysar.org`, for example. It only receives; nothing on the VM sends email.

For each message:

1. **Recipients.** Only addresses in a domain with a route are accepted, so it never relays mail anywhere else (550 for
   the rest, before the message is sent).
2. **Who it's from.** SPF or DKIM must pass for the From address's own domain, or one of the same organization
   (`mail.example.org` for `example.org`): a valid DKIM signature by that domain, or SPF allowing the sending server for
   an envelope sender (MAIL FROM) in it. That's DMARC's relaxed alignment, without needing the sender to publish a
   DMARC record. Otherwise it's refused (550): a forged From, mail forwarded in a way that breaks both, or a sender
   with neither SPF nor DKIM.
3. **Allowed senders**, if the route has a list: the From address, or its whole domain.
4. **The app.** A POST to the route's URL, with its token. The app's answer decides the reply to the sending server:
   2xx delivered; 4xx bounced, with the app's `error` as the reason (like "No channel "nope""); anything else, or no
   answer in 20 seconds, is temporary (451), so the sending server tries again later, for days. Nothing is kept here.

A message to several addresses gets one POST for each, and only one reply: when any is temporary, the sender sends it
again to all of them, and the others may get it twice.

## Routes

In `config/mail.env` on the VM (`bin/secrets.sh` makes it, with none), then `docker compose up -d mail`:

```
ROUTE_BEEPERS=beepers.kingcountysar.org http://beepers:4100/api/ingest/email
ROUTE_BEEPERS_TOKEN=<sent as Authorization: Bearer; beepers' INGEST_TOKEN>
ROUTE_BEEPERS_SENDERS=dispatch@example.org, @kcesar.org
```

`ROUTE_<NAME>` is the domain and the app's URL on the `kcsara` network. `_TOKEN` is required. `_SENDERS` is optional:
addresses, or `@domain` for anyone at that exact domain; without it, any sender passing step 2 may send.

Optional too: `MAIL_MAX_KB` (5120: larger messages are refused) and `MAIL_POST_TIMEOUT_S` (20).

## What the app gets

```
POST <url>
Authorization: Bearer <token>
Content-Type: application/json

{ "to": "callout@beepers.kingcountysar.org", "from": "dispatch@example.org", "fromName": "Dispatch",
  "subject": "...", "text": "...", "messageId": "<...>", "date": "2026-10-24T19:00:00.000Z",
  "auth": { "by": "dkim", "spf": "pass", "dkim": ["example.org=pass"] } }
```

`text` is the plain text part (or the HTML part as text). Attachments are left out.

## DNS

- **The mail hosts**: `mail.kingcountysar.org`, or the names in `MAIL_HOSTS` in `/srv/kcsara/.env` when it's set, comma
  separated, like `MAIL_HOSTS=mx.kcesar.org, mail.kingcountysar.org`. Each needs an A record to the VM. Each is also a
  site, only so Caddy gets a certificate for it (`https://<host>/health`, which the health checks ask for). The first
  is the name the server greets senders with. To change them, edit `.env`, then `node deploy.mjs vm`. Leave out a
  name until its DNS points here, or Caddy keeps trying (and failing) to get it a certificate.
- **Each routed domain**: an MX record to any of the mail hosts, like
  `beepers.kingcountysar.org. MX 10 mail.kingcountysar.org.`. Different domains can use different hosts. Without one,
  senders fall back to the domain's own A record, which is the VM too, but don't rely on that.

Azure lets port 25 in; it's sending out on 25 that it blocks, which this never does.

## TLS

STARTTLS, with Caddy's certificates for the mail hosts (mounted from `data/caddy/caddy/certificates`). Each sender gets
the certificate for the host name it asks for (SNI), which is the host its MX record names. A sender that asks for no
name, or for another one, gets the first host's certificate (or, if that one has none yet, the first one there is).
STARTTLS is off until Caddy has a certificate for at least one host: after the first arrives, restart the service
(`docker compose restart mail`). Renewals, and certificates for the other hosts, are picked up within an hour. Senders
use TLS when it's offered, but fall back to plain text, and don't check the certificate.

To make them use it, and check it, publish an MTA-STS policy for each domain: a TXT record
`_mta-sts.<domain>` (`v=STSv1; id=<a new value each time the policy changes>`), and the policy at
`https://mta-sts.<domain>/.well-known/mta-sts.txt` (a Caddy site), with `mode: testing` first, then `enforce`:

```
version: STSv1
mode: testing
mx: mail.kingcountysar.org
max_age: 86400
```

`mx` is the host the domain's MX record names, with one `mx:` line for each host if it names more than one.

A `_smtp._tls.<domain>` TXT record (`v=TLSRPTv1; rua=mailto:<you>`) gets daily reports of senders' TLS failures. None
of this is set up yet.

## Watching it

`node deploy.mjs logs mail`: one line per message, with what became of it and why. Prometheus collects
`mail_messages_total{result}` (`delivered`, `rejected_auth`, `rejected_sender`, `rejected_app`, `deferred`,
`too_large`), `mail_recipients_no_route_total` and `mail_starttls`.

To send a test from a dev machine (it must pass SPF or DKIM, so send from a real account, like Gmail), or check the
reply to a forged one:

```
swaks --to callout@beepers.kingcountysar.org --from you@example.org --server mail.kingcountysar.org
```

## Developing

`npm install` and `npm test` here: the tests run the real SMTP server on localhost, with SPF and DKIM against made-up
DNS records and a fake app. On a dev machine `docker compose up` doesn't run it (no port 25, no certificate).
Dependencies are exact versions (`package-lock.json`).

`node deploy.mjs vm` builds it before sending it: `npm run build` here (installing the dependencies first, the first
time) bundles the service and its dependencies into one file, `dist/mail.mjs`, which runs on `node:22-alpine` on the
VM, as the apps' builds do. Nothing is installed or built on the VM.
