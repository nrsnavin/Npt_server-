import company from '../config/company.js';
import { normalisePhone } from '../utils/phone.js';

/**
 * What a quotation says when it is sent: the email and the WhatsApp message, pre-filled for the
 * person sending it to edit. The PDF carries the full terms; the message is the covering note.
 */

const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dated = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null;

/** The person the quote is addressed to, and where to reach them: the primary contact, else the firm. */
export function recipientOf(customer) {
  const contacts = customer?.contacts || [];
  const contact = contacts.find((row) => row.isPrimary) || contacts[0] || null;
  return {
    name: contact?.name || customer?.name || '',
    email: contact?.email || customer?.email || '',
    whatsapp: contact?.whatsapp || contact?.mobile || customer?.whatsapp || customer?.mobile || '',
  };
}

const lineText = (line) => {
  const model = line.modelNumber || line.mould?.mouldCode || 'Hanger';
  const moq = line.moq ? ` (minimum ${Number(line.moq).toLocaleString('en-IN')} pcs)` : '';
  return `• ${model} — ${rupees(line.unitPrice)} per piece${moq}`;
};

/** `{ subject, email, whatsapp }` — the texts a person then edits before anything is sent. */
export function draftQuoteMessages({ quotation, customer, sender }) {
  const { name } = recipientOf(customer);
  const greeting = name ? `Dear ${name},` : 'Dear Sir/Madam,';
  const lines = (quotation.lines || []).map(lineText);
  const validUntil = dated(quotation.validUntil);
  const terms = [
    validUntil && `Valid until ${validUntil}.`,
    quotation.paymentTerms && `Payment terms: ${quotation.paymentTerms}.`,
    quotation.isExport ? null : company.gstNote && `${company.gstNote}.`,
  ].filter(Boolean);
  const signature = [
    'Regards,',
    sender?.name,
    company.name,
    sender?.phone || company.phone,
  ].filter(Boolean);

  const subject = `Quotation ${quotation.number} — ${company.name}`;

  const email = [
    greeting,
    '',
    `Thank you for your enquiry. Please find attached our quotation ${quotation.number}.`,
    '',
    ...lines,
    '',
    ...terms,
    '',
    'Please let us know if you have any questions, or if you would like samples.',
    '',
    ...signature,
  ].join('\n');

  const whatsapp = [
    greeting,
    `Please find our quotation ${quotation.number} attached.`,
    ...lines,
    ...terms,
    `— ${[sender?.name, company.name].filter(Boolean).join(', ')}`,
  ].join('\n');

  return { subject, email, whatsapp };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why these recipients and texts cannot be sent, or null. The same rule the screen says first. */
export function sendProblem({ email, whatsapp }) {
  if (!email?.send && !whatsapp?.send) return null;
  if (email?.send) {
    if (!EMAIL.test(String(email.to || '').trim())) return 'Give an email address to send it to.';
    if (!String(email.subject || '').trim()) return 'The email needs a subject.';
    if (!String(email.body || '').trim()) return 'The email needs a message.';
  }
  if (whatsapp?.send) {
    if (!normalisePhone(whatsapp.to)) return 'Give a WhatsApp number to send it to.';
    if (!String(whatsapp.body || '').trim()) return 'The WhatsApp message is empty.';
  }
  return null;
}
