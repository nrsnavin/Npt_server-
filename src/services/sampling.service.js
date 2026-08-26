import Sample from '../models/Sample.js';
import { nextNumber } from './numbering.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * How long the sample team gets by default when the automation raises a request [§6].
 *
 * The blueprint says "set due date" without naming a number, so this is the plant's own
 * working assumption rather than a rule from the spec — a week covers stock check, moulding
 * and printing for anything already in the catalogue. An explicit date always wins, and the
 * enquiry's own delivery date caps it: a sample due after the order is a sample due never.
 */
const DEFAULT_SAMPLE_DAYS = 7;

export function defaultRequiredDate(enquiry, from = new Date()) {
  const target = new Date(from);
  target.setDate(target.getDate() + DEFAULT_SAMPLE_DAYS);
  target.setHours(17, 0, 0, 0);

  const delivery = enquiry?.requiredDeliveryDate ? new Date(enquiry.requiredDeliveryDate) : null;
  return delivery && delivery < target ? delivery : target;
}

/** What a sample takes from the enquiry that raised it, so nothing is re-keyed [§41.4]. */
const fromEnquiry = (enquiry) => ({
  customer: enquiry.customer?._id || enquiry.customer,
  enquiry: enquiry._id,
  requestedBy: enquiry.assignedTo?._id || enquiry.assignedTo,
  product: enquiry.product?._id || enquiry.product,
  modelNumber: enquiry.requirement?.modelNumber,
  category: enquiry.requirement?.category,
  sizeMm: enquiry.requirement?.sizeMm,
  material: enquiry.requirement?.material,
  colour: enquiry.requirement?.colour,
  printing: enquiry.requirement?.printing,
  referenceImageUrl: enquiry.referenceImageUrl,
});

/**
 * A sample raised without one already open against the same enquiry.
 *
 * Moving an enquiry to `sample_required` twice — which happens whenever marketing corrects a
 * status — must not produce two live requests for the same thing. A request that has already
 * been answered is not in the way, so a re-sample after `modification_required` still works.
 */
export async function openSampleFor(enquiryId) {
  return Sample.findOne({
    enquiry: enquiryId,
    status: { $nin: ['approved', 'rejected', 'modification_required'] },
  });
}

/**
 * Creates the sample request. Shared by the enquiry automation and by the sample team
 * raising one directly, so both produce the same record.
 */
export async function createSampleForEnquiry(enquiry, overrides = {}, { autoCreated = false } = {}) {
  const existing = await openSampleFor(enquiry._id);
  if (existing) return { sample: existing, created: false };

  const purpose = overrides.purpose || (enquiry.isNewDevelopment ? 'new_development' : 'existing_model');

  const sample = await Sample.create({
    ...fromEnquiry(enquiry),
    ...overrides,
    purpose,
    number: await nextNumber('SMP'),
    requiredDate: overrides.requiredDate || defaultRequiredDate(enquiry),
    autoCreated,
    statusHistory: [{ to: 'request_received', note: autoCreated ? 'Raised by the enquiry moving to sample required' : undefined }],
  });

  publish(EVENTS.SAMPLE_CREATED, { sample, enquiry, autoCreated });
  return { sample, created: true };
}
