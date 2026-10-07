import Customer from '../models/Customer.js';
import { nextNumber } from './numbering.service.js';
import { canOwnBuyer, nextInRotation } from './assignment.service.js';
import { normalisePhone } from '../utils/phone.js';
import { createEnquiryRecord } from '../controllers/pipeline.controller.js';

/**
 * New buyers arriving without anybody typing them in — an IndiaMART enquiry, a visiting card or
 * a chat screenshot sent to the plant's number — become a customer and an enquiry.
 *
 * There is no stage before the enquiry. The plant's workflow starts at Enquiry → Sampling →
 * Quotation (Navin CRM role requirements, 7 Oct 2026); a separate "lead" record was a second
 * list of the same buyers that marketing had to convert by hand before any department could see
 * them. What a first message rarely says is the model, so the enquiry opens in requirement
 * clarification with the buyer's own words, and must name a model before it is worked further.
 */

/** A customer already holding this phone number or email, on the record or on a contact. */
export async function customerByContact({ mobile, whatsapp, email } = {}) {
  const phones = [normalisePhone(mobile), normalisePhone(whatsapp)].filter(Boolean);
  const or = [
    ...phones.flatMap((phone) => [
      { mobile: phone }, { whatsapp: phone }, { 'contacts.mobile': phone }, { 'contacts.whatsapp': phone },
    ]),
    ...(email ? [{ email: String(email).toLowerCase() }, { 'contacts.email': String(email).toLowerCase() }] : []),
  ];
  if (!or.length) return null;
  return Customer.findOne({ $or: or });
}

/**
 * Who a new buyer belongs to when nobody chose: the person who brought them in if they can hold
 * a buyer, otherwise the next in the marketing rotation. `rotated` names who the rotation picked,
 * so the record can say so.
 */
export async function ownerForNewBuyer(bringer) {
  if (bringer && (await canOwnBuyer(bringer))) return { user: bringer._id, rotated: null };
  const next = await nextInRotation();
  if (next) return { user: next._id, rotated: next.name };
  return { user: bringer?._id, rotated: null };
}

/** The customer master record for a buyer we have never had. */
export async function createBuyer(fields, { assignedTo, source, conversation, notes } = {}) {
  return Customer.create({
    code: await nextNumber('CUST'),
    name: fields.company,
    city: fields.city,
    state: fields.state,
    mobile: fields.mobile,
    whatsapp: fields.whatsapp || fields.mobile,
    email: fields.email,
    contacts: fields.contactName && fields.contactName !== fields.company
      ? [{
          name: fields.contactName,
          designation: fields.designation,
          mobile: fields.mobile,
          whatsapp: fields.whatsapp || fields.mobile,
          email: fields.email,
          isPrimary: true,
        }]
      : [],
    assignedTo,
    source,
    conversation,
    notes,
  });
}

/**
 * The enquiry a new buyer opens with: in requirement clarification, carrying what they said, and
 * with a next step and a date so it lands on somebody's due list.
 */
export async function raiseFirstEnquiry({
  customer, remarks, nextAction, nextActionType = 'call', nextFollowUpDate, source, conversation, by = null,
}) {
  return createEnquiryRecord(
    {
      customer: customer._id,
      assignedTo: customer.assignedTo,
      status: 'requirement_clarification',
      remarks,
      nextAction,
      nextActionType,
      nextFollowUpDate,
      source,
      conversation,
    },
    by
  );
}
