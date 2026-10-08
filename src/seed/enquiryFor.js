import Enquiry from '../models/Enquiry.js';
import { nextNumber } from '../services/numbering.service.js';

/**
 * The enquiry a seeded sample, costing, quotation or order is raised on.
 *
 * Every one of those belongs to an enquiry [services/enquiryLink.service.js], and the demo data
 * has to obey the same rule as everybody else — a seed that quietly skipped it would be the one
 * place the screens show records nobody could reach from an enquiry.
 */
export async function enquiryFor({ customer, owner, modelNumber, mould, status = 'won', at = new Date() }) {
  return Enquiry.create({
    number: await nextNumber('ENQ'),
    customer: customer?._id || customer,
    assignedTo: owner?._id || owner,
    mould: mould?._id || mould || undefined,
    status,
    enquiryDate: at,
    requirement: { modelNumber: modelNumber || 'Mixed models' },
    statusHistory: [{ to: status, at, by: owner?._id || owner }],
  });
}
