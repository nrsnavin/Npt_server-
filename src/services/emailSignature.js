import { company } from '../config/company.js';

/**
 * The footer on every email a customer receives — quotations, sample updates, LR copies and the
 * papers sent from an enquiry. One place, so every mail signs off the same way.
 *
 * Each line can be changed per deployment from `.env` without a code change. The logo is the
 * NAVIN HANGERS wordmark drawn in the email itself; set EMAIL_LOGO_URL to a public https image to
 * show the logo file instead (mail clients block images that are not on a public address).
 */
export const signature = {
  closing: process.env.EMAIL_SIGNOFF || 'Thanks & Regards',
  name: process.env.EMAIL_SIGNER_NAME || 'Senthil kumar. A',
  title: process.env.EMAIL_SIGNER_TITLE || 'Managing Director',
  mobile: process.env.EMAIL_SIGNER_MOBILE || '+91-99444 23690',
  phone: process.env.EMAIL_COMPANY_PHONE || '+91-421-4334690',
  email: process.env.EMAIL_COMPANY_EMAIL || 'info@navinplastic.com',
  website: process.env.EMAIL_COMPANY_WEBSITE || 'www.navinplastic.com',
  company: process.env.EMAIL_COMPANY_NAME || 'NAVIN PLASTIC TECH',
  address: (process.env.EMAIL_COMPANY_ADDRESS || '1/110-F, Kaniyampoondi,|Vanjipalayam Post, Tirupur-641663,|Tamilnadu, India.')
    .split('|').map((line) => line.trim()).filter(Boolean),
  logoUrl: process.env.EMAIL_LOGO_URL || '',
};

const ORANGE = '#F28C3A';
const TEAL = '#1F5F66';
const GREY = '#4A4A4A';

const escape = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A body's own closing lines — "Thank you," / "Regards," and the company or its phone on their
 * own — dropped from the email, because the footer below says them. WhatsApp keeps them.
 */
export function withoutSignOff(body) {
  const closing = /^(thanks|thank you|regards|thanks & regards|thanks and regards|warm regards|best regards)[,.!]?$/i;
  const own = new Set([company.name, company.phone, signature.company, signature.name].map((line) => String(line).trim().toLowerCase()));
  const lines = String(body ?? '').replace(/\s+$/, '').split('\n');
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (!last || closing.test(last) || own.has(last.toLowerCase()) || /^[—-]\s*/.test(last) && own.has(last.replace(/^[—-]\s*/, '').toLowerCase())) {
      lines.pop();
    } else break;
  }
  return lines.join('\n');
}

const wordmark = () => (signature.logoUrl
  ? `<img src="${escape(signature.logoUrl)}" alt="Navin Hangers" width="150" style="display:block;border:0;max-width:150px;height:auto">`
  : `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <td style="font:700 44px/1 Arial,Helvetica,sans-serif;color:${ORANGE};padding-right:6px;vertical-align:middle">N</td>
      <td style="vertical-align:middle;font:800 20px/1.05 Arial,Helvetica,sans-serif;color:${TEAL};letter-spacing:.5px">NAVIN<br>HANGERS</td>
    </tr></table>`);

/** The footer as HTML: tables and inline styles, which every mail client draws the same. */
export function signatureHtml() {
  const row = (icon, text, href) => `<tr><td style="padding:2px 8px 2px 0;color:${ORANGE};font-size:12px;vertical-align:top">${icon}</td>
    <td style="padding:2px 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:${GREY}">${href ? `<a href="${escape(href)}" style="color:${GREY};text-decoration:none">${escape(text)}</a>` : escape(text)}</td></tr>`;
  const digits = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;
  const site = signature.website.startsWith('http') ? signature.website : `https://${signature.website}`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:24px;max-width:600px;width:100%">
  <tr><td colspan="2" style="font:italic 700 14px/1.4 Arial,Helvetica,sans-serif;color:#1d2b33;padding-bottom:6px">${escape(signature.closing)}</td></tr>
  <tr>
    <td style="vertical-align:middle;padding-bottom:14px">
      <div style="font:700 22px/1.2 Arial,Helvetica,sans-serif;color:${ORANGE}">${escape(signature.name)}</div>
      <div style="font:700 13px/1.4 Arial,Helvetica,sans-serif;color:${TEAL}">${escape(signature.title)}</div>
    </td>
    <td style="vertical-align:middle;padding:0 0 14px 24px">${wordmark()}</td>
  </tr>
  <tr><td colspan="2" style="border-top:1px solid #d9d9d9;padding-top:12px">
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%"><tr>
      <td style="vertical-align:top;padding-right:16px;border-right:1px solid #d9d9d9">
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          ${row('&#9990;', `${signature.mobile} (WhatsApp)`, digits(signature.mobile))}
          ${row('&#9742;', signature.phone, digits(signature.phone))}
          ${row('&#9993;', signature.email, `mailto:${signature.email}`)}
          ${row('&#127760;', signature.website, site)}
        </table>
      </td>
      <td style="vertical-align:top;padding-left:16px">
        <div style="font:700 12px/1.5 Arial,Helvetica,sans-serif;color:${TEAL}"><span style="color:${ORANGE}">&#9679;</span> ${escape(signature.company)}</div>
        <div style="font:12px/1.5 Arial,Helvetica,sans-serif;color:${GREY};padding-left:14px">${signature.address.map(escape).join('<br>')}</div>
      </td>
    </tr></table>
  </td></tr>
</table>`;
}

/** The footer as plain text, for mail clients that show no HTML. */
export function signatureText() {
  return [
    signature.closing,
    signature.name,
    signature.title,
    '',
    `${signature.company} — NAVIN HANGERS`,
    ...signature.address,
    `Mobile / WhatsApp: ${signature.mobile}`,
    `Phone: ${signature.phone}`,
    `Email: ${signature.email}`,
    `Web: ${signature.website}`,
  ].join('\n');
}

/**
 * A customer email, ready for `sendEmail`: the body as written (its own sign-off dropped), then
 * the footer — as text and as HTML.
 */
export function customerEmail(body) {
  const text = withoutSignOff(body);
  return {
    text: `${text}\n\n${signatureText()}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1d2b33;max-width:600px">
  <div style="white-space:pre-wrap">${escape(text)}</div>
  ${signatureHtml()}
</div>`,
  };
}
