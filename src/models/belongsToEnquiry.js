/**
 * Everything is an enquiry [services/enquiryLink.service.js].
 *
 * Mongoose plugin: a new record without an enquiry is refused at validation. Existing records
 * are left alone, so anything raised before this rule can still be read and worked.
 */
export default function belongsToEnquiry(schema, { what }) {
  schema.pre('validate', function enquiryRequired() {
    if (this.isNew && !this.enquiry) {
      this.invalidate('enquiry', `Every ${what} belongs to an enquiry — raise it from the enquiry`);
    }
  });
}
