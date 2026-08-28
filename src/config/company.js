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

  /** Printed under the signature block, where a quotation's standing conditions live. */
  standardTerms: (
    process.env.COMPANY_QUOTE_TERMS ||
    'Prices are ex-works unless stated otherwise and are exclusive of GST.|' +
      'Quantity tolerance of ±5% on moulded items is to be accepted as full delivery.|' +
      'Colour and shade matching is subject to approval of the pre-production sample.|' +
      'Prices are subject to revision if the polymer rate moves beyond 5%.|' +
      'This quotation is valid only for the quantity and validity stated above.'
  )
    .split('|')
    .map((line) => line.trim())
    .filter(Boolean),
};

export default company;
