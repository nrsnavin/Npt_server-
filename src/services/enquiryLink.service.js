import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { CLOSED_STAGE } from '../config/enquiryStages.js';
import { ownsRecord } from './ownership.service.js';

/**
 * Everything is an enquiry.
 *
 * A sample, a costing sheet, a quotation and a sales order are each raised on an enquiry and
 * on nothing else — dispatches, payments, quality checks and order queries hang off the sales
 * order, so they inherit it. A department does not keep records of its own beside the enquiry:
 * whatever it does is found by opening the enquiry, and the enquiry's stage says who has it.
 *
 * `requireEnquiry` is the door every create goes through; `models/belongsToEnquiry.js` is the
 * model's own refusal, so an automation, a script or a future endpoint cannot create one without
 * it either.
 */

/**
 * The enquiry a new record is raised on, or a refusal that says what to do instead.
 * `customer`, when the caller named one, must be the enquiry's own.
 */
export async function requireEnquiry(enquiryId, user, { what, customer } = {}) {
  if (!enquiryId) {
    throw ApiError.badRequest(`Open the enquiry and raise the ${what} from there — every ${what} belongs to an enquiry`);
  }
  const enquiry = await Enquiry.findById(enquiryId);
  if (!enquiry) throw ApiError.badRequest('That enquiry does not exist');
  /* Raising a record on an enquiry you cannot see would put it in its owner's list. */
  if (user && !ownsRecord(user, enquiry)) throw ApiError.notFound('Enquiry not found');
  if (enquiry.stage === CLOSED_STAGE) {
    throw ApiError.badRequest(`${enquiry.number} is closed. Raise a new enquiry for new work.`);
  }
  if (customer && String(customer) !== String(enquiry.customer)) {
    throw ApiError.badRequest(`${enquiry.number} is for a different customer`);
  }
  return enquiry;
}
