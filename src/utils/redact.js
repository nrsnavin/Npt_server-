/**
 * What the access log may not keep.
 *
 * The WhatsApp webhook accepts its shared token in the query string as well as in a header, and
 * Meta's verification sends its token the same way. Logged as-is, the URL puts the secret into
 * every log line, log shipper and support screenshot it passes through. The log keeps the route
 * and loses the value.
 */
const SECRET_PARAMS = /([?&](?:token|hub\.verify_token|signature)=)[^&#]*/gi;

export const redactUrl = (url) => String(url || '').replace(SECRET_PARAMS, '$1[redacted]');
