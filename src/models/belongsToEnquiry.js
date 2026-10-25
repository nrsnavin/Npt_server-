/**
 * Everything is an enquiry [services/enquiryLink.service.js].
 *
 * Mongoose plugin: a new record without an enquiry is refused at validation. Existing records
 * are left alone, so anything raised before this rule can still be read and worked. `orOn` names
 * the one other record it may hang on instead — a team job's sample, found on the job.
 */
export default function belongsToEnquiry(schema, { what, orOn = null }) {
  schema.pre('validate', function enquiryRequired() {
    if (this.isNew && !this.enquiry && !(orOn && this[orOn])) {
      this.invalidate('enquiry', `Every ${what} belongs to an enquiry — raise it from the enquiry`);
    }
  });
}
