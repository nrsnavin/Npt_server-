import { whatsappTemplates } from '../config/env.js';

/**
 * What a customer may be told, and in what words.
 *
 * The blueprint's rule [§42.8] is that only customer-safe fields feed a draft: never an
 * internal note, a machine problem, a material shortage, a margin or a quality
 * investigation. That is enforced structurally here rather than by remembering — a template
 * receives a context built by `contextFor` below, and that function is the only thing that
 * decides what leaves the building. A field that is not in it cannot reach a customer, even
 * by accident, even if someone adds a template later.
 *
 * `remarks`, `feedbackNote` and `statusHistory[].note` are all deliberately absent.
 */

const formatNumber = new Intl.NumberFormat('en-IN');

const describe = (sample) =>
  [sample.modelNumber, sample.colour].filter(Boolean).join(' in ') || 'your sample';

/**
 * The whole of what a template may know. Built from the sample, its enquiry and its
 * customer, and nothing else.
 */
export function contextFor({ sample, enquiry, customer }) {
  return {
    customerName: customer?.name || 'there',
    contactName: customer?.contacts?.find((contact) => contact.isPrimary)?.name,
    sampleNumber: sample.number,
    enquiryNumber: enquiry?.number,
    model: sample.modelNumber || 'a new development',
    colour: sample.colour,
    quantity: sample.quantity,
    description: describe(sample),
    courier: sample.courier,
    awbNumber: sample.awbNumber,
    dispatchedQuantity: sample.dispatchedQuantity,
    company: 'Navin Plastic Tech',
  };
}

/**
 * One entry per eligible update [§42.5]. Phase 2 covers the two sample stages; the rest
 * of that list arrives with the modules that raise them.
 *
 * `variables` is the ordered map a WhatsApp template expects — Meta templates are
 * positional, so the order here must match the template registered in the Content Template
 * Builder. It is documented alongside the SIDs in .env.example.
 */
export const TEMPLATES = {
  sample_ready: {
    label: 'Sample ready',
    subject: (ctx) => `Your sample ${ctx.sampleNumber} is ready — ${ctx.company}`,
    body: (ctx) =>
      `Hello ${ctx.customerName},\n\n` +
      `Your sample ${ctx.sampleNumber} — ${ctx.description}, ${formatNumber.format(ctx.quantity)} pc — ` +
      `is ready.\n\n` +
      `We will confirm the courier details shortly. Please let us know if the delivery address has changed.\n\n` +
      `${ctx.company}`,
    variables: (ctx) => ({
      1: ctx.customerName,
      2: ctx.sampleNumber,
      3: ctx.model,
      4: ctx.colour || '-',
      5: String(ctx.quantity),
    }),
    contentSid: () => whatsappTemplates.sample_ready,
  },

  sample_dispatched: {
    label: 'Sample dispatched',
    subject: (ctx) => `Your sample ${ctx.sampleNumber} is on its way — ${ctx.company}`,
    body: (ctx) =>
      `Hello ${ctx.customerName},\n\n` +
      `Your sample ${ctx.sampleNumber} — ${ctx.description} — has been dispatched.\n\n` +
      `Courier: ${ctx.courier}\n` +
      `Tracking number: ${ctx.awbNumber}\n` +
      `Quantity sent: ${formatNumber.format(ctx.dispatchedQuantity ?? ctx.quantity)} pc\n\n` +
      `Please let us know your feedback once it reaches you.\n\n` +
      `${ctx.company}`,
    variables: (ctx) => ({
      1: ctx.customerName,
      2: ctx.sampleNumber,
      3: ctx.model,
      4: ctx.colour || '-',
      5: String(ctx.dispatchedQuantity ?? ctx.quantity),
      6: ctx.courier || '-',
      7: ctx.awbNumber || '-',
    }),
    contentSid: () => whatsappTemplates.sample_dispatched,
  },
};

export const EVENT_KEYS = Object.keys(TEMPLATES);

/** Renders a draft. Returns the subject and body a human can then edit before sending. */
export function render(event, context) {
  const template = TEMPLATES[event];
  if (!template) throw new Error(`No customer message template for ${event}`);

  return {
    event,
    label: template.label,
    subject: template.subject(context),
    body: template.body(context),
  };
}
