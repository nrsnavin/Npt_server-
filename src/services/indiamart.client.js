import { env } from '../config/env.js';

/**
 * Talking to IndiaMART's Lead Manager pull API.
 *
 * This file knows about *their* API and nothing about ours: it fetches a window and hands back
 * plain objects. Normalising those into leads is the ingest service's job, and keeping the two
 * apart is what makes the ingest testable without a network and this replaceable if they
 * change the endpoint again.
 *
 * **Their shape is asserted, not assumed.** The field names and the time format below come from
 * their CRM integration docs and both have changed before. `parseResponse` therefore treats an
 * unexpected body as an error with the body in the message, rather than as an empty result —
 * an integration that silently reports "0 new leads" every fifteen minutes because the payload
 * moved is worse than one that is visibly broken.
 */

/** The feed's name, used for the sync-state row and the conversation reference. */
export const PROVIDER = 'indiamart';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Their timestamp format: `DD-MMM-YYYYHH:MM:SS`, with no separator before the time.
 *
 * Written out rather than done with `toISOString`, because it is not ISO and the difference is
 * the kind that fails at 400 with no explanation. Kept as its own function so that correcting
 * it — when they change it — is one edit in one place.
 */
export function asApiTime(date) {
  const value = new Date(date);
  const pad = (number) => String(number).padStart(2, '0');
  return (
    `${pad(value.getDate())}-${MONTHS[value.getMonth()]}-${value.getFullYear()}` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  );
}

/** True when the integration is configured at all. Without a key it is simply off. */
export const isConfigured = () => Boolean(env.indiamart.key);

/**
 * Pulls out the leads, and refuses to guess.
 *
 * Their success body carries `RESPONSE` as an array. Several documented failures come back as
 * HTTP 200 with a `CODE` other than 200 and a `MESSAGE` — a rate-limit trip is the common one —
 * so the status line alone does not say whether this worked.
 */
export function parseResponse(body) {
  if (!body || typeof body !== 'object') {
    throw new Error(`IndiaMART returned something that is not an object: ${String(body).slice(0, 200)}`);
  }

  const code = Number(body.CODE ?? body.code ?? 200);
  if (code !== 200) {
    // Their own words, because they are more use than ours: "no records", "limit exceeded".
    throw new Error(`IndiaMART refused the request (code ${code}): ${body.MESSAGE || body.message || 'no message'}`);
  }

  const rows = body.RESPONSE ?? body.response;

  /*
   * An empty window is a legitimate answer and comes back in more than one shape — an empty
   * array, or a null with a "no records" message. Both mean the same thing and neither is a
   * fault.
   */
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) {
    throw new Error(
      `IndiaMART's RESPONSE was ${typeof rows}, not a list — the payload shape has changed: ` +
        `${JSON.stringify(body).slice(0, 300)}`
    );
  }

  return rows;
}

/**
 * Fetches one window of leads.
 *
 * The window is passed in rather than worked out here, because deciding *which* window to ask
 * for is a question about what has already been read — which belongs with the watermark, not
 * with the transport.
 */
export async function fetchLeads({ from, to, fetchImpl = fetch } = {}) {
  if (!isConfigured()) throw new Error('No IndiaMART key configured');

  const url = new URL(env.indiamart.baseUrl);
  url.searchParams.set('glusr_crm_key', env.indiamart.key);
  url.searchParams.set('start_time', asApiTime(from));
  url.searchParams.set('end_time', asApiTime(to));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.indiamart.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`IndiaMART answered ${response.status}: ${text.slice(0, 200)}`);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      /*
       * They answer an expired or wrong key with an HTML page and a 200. Parsing that as
       * "no leads" is how an integration goes quiet for a week without anybody noticing.
       */
      throw new Error(`IndiaMART answered with something that is not JSON: ${text.slice(0, 200)}`);
    }

    return parseResponse(body);
  } finally {
    clearTimeout(timer);
  }
}
