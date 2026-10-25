import { authenticate } from 'mailauth';
import { getDomain } from 'tldts';

// Basic checks that a message is from who its From says: SPF or DKIM must pass for the From address's own domain
// (DMARC's relaxed alignment, without needing the sender to publish a DMARC record).
//   DKIM: a valid signature by the From domain, or another domain of the same organization (mail.example.org for
//         example.org).
//   SPF:  the connecting server is allowed to send for the envelope sender (MAIL FROM), in the From domain likewise.
// Anything else is refused: forwarded mail that breaks both, or a sender with neither SPF nor DKIM set up.

/** The organizational domain (example.org for a.b.example.org), or the name itself when it has no public suffix. */
const orgDomain = (domain) => getDomain(domain, { allowPrivateDomains: true }) ?? domain.toLowerCase();

/**
 * @param {Buffer} raw the message as received
 * @param {{ ip: string, helo: string, sender: string, mta: string, fromAddress: string, resolver?: Function }} opts
 * @returns {Promise<{ pass: boolean, by: 'dkim' | 'spf' | null, spf: string, dkim: string[] }>}
 */
export async function checkAuthentication(raw, { ip, helo, sender, mta, fromAddress, resolver }) {
  const result = await authenticate(raw, {
    ip,
    helo,
    sender,
    mta,
    resolver,
    disableArc: true,
    disableBimi: true,
    disableDmarc: true,
  });
  const fromOrg = orgDomain(fromAddress.slice(fromAddress.lastIndexOf('@') + 1));

  // An unsigned message still has one result, with no domain ("none"): only real signatures count.
  const signatures = (result.dkim?.results ?? []).filter((r) => r.signingDomain);
  const dkimPasses = signatures.filter((r) => r.status?.result === 'pass');
  const dkimAligned = dkimPasses.some((r) => r.signingDomain && orgDomain(r.signingDomain) === fromOrg);
  const spfResult = result.spf?.status?.result ?? 'none';
  const spfAligned = spfResult === 'pass' && !!result.spf.domain && orgDomain(result.spf.domain) === fromOrg;

  return {
    pass: dkimAligned || spfAligned,
    by: dkimAligned ? 'dkim' : spfAligned ? 'spf' : null,
    spf: spfResult,
    dkim: signatures.map((r) => `${r.signingDomain}=${r.status?.result ?? 'none'}`),
  };
}
