/**
 * Who the quotation is *from*.
 *
 * A letterhead hardcoded inside a PDF generator is the thing you regret: the GST number
 * changes, the plant moves, a second entity starts quoting, and the address is buried in a
 * layout function three modules deep. Here it is one object, overridable per deployment.
 *
 * The defaults are this plant's, because a system with no configuration should still produce a
 * correct document rather than a template with `[COMPANY NAME]` on it — a placeholder that
 * reaches a customer is worse than a wrong address, which somebody at least notices.
 */
export const company = {
  name: process.env.COMPANY_NAME || 'Navin Plastic Tech',
  tagline: process.env.COMPANY_TAGLINE || 'Garment Hangers · Injection Moulding',
  addressLines: (
    process.env.COMPANY_ADDRESS ||
    'SF No. 285/2, Kunnathur Road|Tiruppur — 641 606|Tamil Nadu, India'
  )
    .split('|')
    .map((line) => line.trim())
    .filter(Boolean),
  gstin: process.env.COMPANY_GSTIN || '33AAAFN1234K1ZP',
  phone: process.env.COMPANY_PHONE || '+91 421 000 0000',
  email: process.env.COMPANY_EMAIL || 'sales@navinhangers.com',
  website: process.env.COMPANY_WEBSITE || 'www.navinhangers.com',

  /**
   * The tariff heading the plant quotes under.
   *
   * One code for every line, because it is one code for everything this plant makes — moulded
   * plastic hangers, 3926.90.69. A per-model field would be five characters of truth and a
   * hundred rows of the same value copied by hand, which is how a wrong one gets in.
   */
  hsnCode: process.env.COMPANY_HSN || '39269069',

  /**
   * What the document says about tax, in the plant's own words.
   *
   * A quotation is a rate, and this plant's sheet has always said "GST 18% EXTRA" rather than
   * computing a tax line — because the rate is what is being offered, and the tax is a fact
   * about the invoice that has not been raised yet.
   */
  gstNote: process.env.COMPANY_GST_NOTE || 'GST 18% EXTRA',

  /** Printed under the signature block, where a quotation's standing conditions live. */
  standardTerms: (
    process.env.COMPANY_QUOTE_TERMS ||
    'Prices are ex-works unless stated otherwise and are exclusive of GST.|' +
      'Quantity tolerance of ±5% on moulded items is to be accepted as full delivery.|' +
      'Colour and shade matching is subject to approval of the pre-production sample.|' +
      'Prices are subject to revision if the polymer rate moves beyond 5%.|' +
      'Rates hold until the validity date above and are subject to the minimum stated per model.'
  )
    .split('|')
    .map((line) => line.trim())
    .filter(Boolean),
};

export default company;
