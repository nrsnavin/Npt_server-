/**
 * Phase 1 sample data: the product master, customers, open leads and enquiries spread
 * across the funnel. Called by the main seed so a fresh database has something to work
 * with on the customers, leads and enquiries screens.
 */
import Product from '../models/Product.js';
import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import Counter from '../models/Counter.js';
import { nextNumber } from '../services/numbering.service.js';

const days = (offset, hour = 11) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/** The catalogue. Model codes follow the plant's own convention: NPT-<size><letter>. */
const PRODUCTS = [
  {
    modelCode: 'NPT-380S',
    name: '380mm Shirt Hanger — Slim',
    category: 'shirt',
    sizeMm: 380,
    material: 'plastic',
    standardWeightGrams: 22,
    availableColours: ['White', 'Black', 'Smoke Grey'],
    hookType: 'fixed',
    mouldAvailable: true,
    mouldNumber: 'M-101',
    standardPrice: 4.6,
    moq: 5000,
    packingQty: 200,
  },
  {
    modelCode: 'NPT-400S',
    name: '400mm Shirt Hanger — Standard',
    category: 'shirt',
    sizeMm: 400,
    material: 'plastic',
    standardWeightGrams: 26,
    availableColours: ['White', 'Black', 'Navy', 'Transparent'],
    hookType: 'swivel',
    mouldAvailable: true,
    mouldNumber: 'M-102',
    standardPrice: 5.2,
    moq: 5000,
    packingQty: 200,
  },
  {
    modelCode: 'NPT-420T',
    name: '420mm Trouser Hanger with Clips',
    category: 'trouser',
    sizeMm: 420,
    material: 'plastic',
    standardWeightGrams: 34,
    availableColours: ['Black', 'White'],
    hookType: 'clip',
    mouldAvailable: true,
    mouldNumber: 'M-118',
    standardPrice: 8.9,
    moq: 3000,
    packingQty: 100,
  },
  {
    modelCode: 'NPT-450C',
    name: '450mm Coat Hanger — Broad Shoulder',
    category: 'coat',
    sizeMm: 450,
    material: 'plastic',
    standardWeightGrams: 48,
    availableColours: ['Black', 'White', 'Walnut'],
    hookType: 'metal_swivel',
    mouldAvailable: true,
    mouldNumber: 'M-124',
    standardPrice: 12.4,
    moq: 2000,
    packingQty: 50,
  },
  {
    modelCode: 'NPT-300K',
    name: '300mm Kids Hanger',
    category: 'kids',
    sizeMm: 300,
    material: 'plastic',
    standardWeightGrams: 15,
    availableColours: ['White', 'Pink', 'Sky Blue', 'Lemon'],
    hookType: 'fixed',
    mouldAvailable: true,
    mouldNumber: 'M-107',
    standardPrice: 3.4,
    moq: 10000,
    packingQty: 250,
  },
  {
    modelCode: 'NPT-330L',
    name: '330mm Lingerie Hanger',
    category: 'lingerie',
    sizeMm: 330,
    material: 'plastic',
    standardWeightGrams: 14,
    availableColours: ['White', 'Blush', 'Transparent'],
    hookType: 'fixed',
    mouldAvailable: true,
    mouldNumber: 'M-133',
    standardPrice: 3.1,
    moq: 10000,
    packingQty: 250,
  },
  {
    modelCode: 'NPT-410V',
    name: '410mm Velvet Flocked Suit Hanger',
    category: 'suit',
    sizeMm: 410,
    material: 'velvet',
    standardWeightGrams: 52,
    availableColours: ['Charcoal', 'Ivory', 'Burgundy'],
    hookType: 'metal_swivel',
    mouldAvailable: true,
    mouldNumber: 'M-141',
    standardPrice: 21.5,
    moq: 1000,
    packingQty: 50,
  },
  {
    modelCode: 'NPT-400R',
    name: '400mm Shirt Hanger — Recycled PP',
    category: 'shirt',
    sizeMm: 400,
    material: 'recycled_pp',
    standardWeightGrams: 27,
    availableColours: ['Charcoal', 'Stone'],
    hookType: 'swivel',
    mouldAvailable: true,
    mouldNumber: 'M-102',
    standardPrice: 5.9,
    moq: 5000,
    packingQty: 200,
    notes: 'GRS certified. Quote only against a GRS-scope order.',
  },
  {
    modelCode: 'NPT-360W',
    name: '360mm Wooden Skirt Hanger',
    category: 'skirt',
    sizeMm: 360,
    material: 'wood',
    standardWeightGrams: 96,
    availableColours: ['Natural', 'Walnut'],
    hookType: 'metal_swivel',
    mouldAvailable: false,
    standardPrice: 34,
    moq: 500,
    packingQty: 25,
    notes: 'Bought out and re-branded — no mould of our own.',
  },
  {
    modelCode: 'NPT-440M',
    name: '440mm Multi-Tier Hanger',
    category: 'multi',
    sizeMm: 440,
    material: 'metal',
    standardWeightGrams: 128,
    availableColours: ['Chrome', 'Black'],
    hookType: 'fixed',
    mouldAvailable: false,
    standardPrice: 46,
    moq: 500,
    packingQty: 20,
    isActive: false,
    notes: 'Withdrawn — chrome supplier discontinued the finish.',
  },
];

export async function seedPipeline({ nandhini, arun, meera }) {
  await Promise.all([
    Product.deleteMany({}),
    Customer.deleteMany({}),
    Lead.deleteMany({}),
    Enquiry.deleteMany({}),
    Sample.deleteMany({}),
    Counter.deleteMany({}),
  ]);

  const products = await Product.create(PRODUCTS);
  const byCode = Object.fromEntries(products.map((product) => [product.modelCode, product]));

  const customerRows = [
    {
      name: 'SCM Garments Pvt Ltd',
      customerType: 'garment_factory',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      mobile: '9840011221',
      whatsapp: '9840011221',
      email: 'purchase@scmgarments.in',
      gstin: '33AABCS1429P1ZQ',
      assignedTo: nandhini._id,
      rating: 'A',
      creditTermsDays: 45,
      paymentTerms: '45 days from invoice',
      source: 'referral',
      contacts: [
        { name: 'Karthik R', designation: 'Purchase Manager', mobile: '9840011221', email: 'purchase@scmgarments.in', isPrimary: true },
        { name: 'Divya M', designation: 'Merchandiser', mobile: '9840011222' },
      ],
      lastOrderDate: days(-18),
      totalBusinessValue: 2840000,
      outstandingAmount: 186000,
    },
    {
      name: 'Sunrise Exports',
      customerType: 'exporter',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      mobile: '9843022331',
      email: 'ops@sunriseexports.com',
      gstin: '33AACCS7781L1Z8',
      assignedTo: nandhini._id,
      rating: 'A',
      creditTermsDays: 30,
      paymentTerms: '30 days, LC on export orders',
      source: 'trade_show',
      contacts: [{ name: 'Bhuvana S', designation: 'Sourcing Head', mobile: '9843022331', isPrimary: true }],
      lastOrderDate: days(-6),
      totalBusinessValue: 5120000,
      outstandingAmount: 412000,
    },
    {
      name: 'Trendline Apparels',
      customerType: 'buying_house',
      city: 'Bengaluru',
      state: 'Karnataka',
      mobile: '9880144552',
      email: 'sourcing@trendline.co.in',
      gstin: '29AAGCT4410M1ZR',
      assignedTo: nandhini._id,
      rating: 'B',
      creditTermsDays: 30,
      source: 'email',
      contacts: [{ name: 'Aravind N', designation: 'Category Buyer', mobile: '9880144552', isPrimary: true }],
      lastOrderDate: days(-52),
      totalBusinessValue: 760000,
    },
    {
      name: 'Metro Wholesale Traders',
      customerType: 'domestic_distributor',
      city: 'Coimbatore',
      state: 'Tamil Nadu',
      mobile: '9842177880',
      email: 'metro.wholesale@gmail.com',
      assignedTo: nandhini._id,
      rating: 'C',
      creditTermsDays: 0,
      paymentTerms: 'Advance',
      source: 'walk_in',
      contacts: [{ name: 'Suresh P', designation: 'Proprietor', mobile: '9842177880', isPrimary: true }],
      totalBusinessValue: 190000,
      status: 'on_hold',
      notes: 'Two cheques bounced in FY24-25. Advance only until cleared.',
    },
    {
      name: 'Vogue Retail India',
      customerType: 'retailer',
      city: 'Chennai',
      state: 'Tamil Nadu',
      mobile: '9791066443',
      email: 'store.ops@vogueretail.in',
      gstin: '33AAECV9021H1ZM',
      assignedTo: arun._id,
      rating: 'B',
      creditTermsDays: 21,
      source: 'phone',
      contacts: [{ name: 'Lakshmi V', designation: 'Store Operations', mobile: '9791066443', isPrimary: true }],
      lastOrderDate: days(-31),
      totalBusinessValue: 615000,
    },
    {
      name: 'Orient Sourcing FZE',
      customerType: 'overseas_buyer',
      city: 'Dubai',
      state: '',
      country: 'United Arab Emirates',
      mobile: '+971501224477',
      email: 'buying@orientsourcing.ae',
      assignedTo: arun._id,
      rating: 'A',
      creditTermsDays: 0,
      paymentTerms: '50% advance, balance against BL',
      source: 'trade_show',
      contacts: [{ name: 'Faisal Rahman', designation: 'Buying Director', mobile: '+971501224477', isPrimary: true }],
      lastOrderDate: days(-74),
      totalBusinessValue: 3380000,
    },
  ];

  const customers = [];
  for (const row of customerRows) {
    customers.push(await Customer.create({ ...row, code: await nextNumber('CUST') }));
  }
  const byName = Object.fromEntries(customers.map((customer) => [customer.name, customer]));

  const leadRows = [
    {
      company: 'Everblue Knitwear',
      contactName: 'Prakash D',
      designation: 'Purchase Executive',
      mobile: '9865412300',
      email: 'prakash@everblueknit.in',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      source: 'trade_show',
      productInterest: 'Shirt hangers, 400mm, white — roughly 60,000 pcs a quarter',
      estimatedQuantity: 60000,
      estimatedValue: 312000,
      status: 'new',
      assignedTo: nandhini._id,
      nextAction: 'Call to confirm sizes and packing',
      nextFollowUpDate: days(0, 15),
    },
    {
      company: 'Coral Fashions',
      contactName: 'Meenakshi R',
      designation: 'Owner',
      mobile: '9600788112',
      email: 'coral.fashions@outlook.com',
      city: 'Erode',
      state: 'Tamil Nadu',
      source: 'referral',
      productInterest: 'Kids hangers in assorted colours',
      estimatedQuantity: 25000,
      estimatedValue: 85000,
      status: 'contacted',
      assignedTo: nandhini._id,
      nextAction: 'Send catalogue and colour chart',
      nextFollowUpDate: days(-1, 16),
      activities: [
        { type: 'call', summary: 'Introductory call. Buys through a Chennai agent today, open to direct supply.', occurredAt: days(-3), createdBy: nandhini._id },
      ],
    },
    {
      company: 'Northstar Apparel Group',
      contactName: 'Vikram Sethi',
      designation: 'Head of Sourcing',
      mobile: '9820344551',
      email: 'vikram.sethi@northstarapparel.com',
      city: 'Mumbai',
      state: 'Maharashtra',
      source: 'email',
      productInterest: 'Velvet suit hangers for a premium in-store rollout',
      estimatedQuantity: 12000,
      estimatedValue: 258000,
      status: 'qualified',
      assignedTo: arun._id,
      nextAction: 'Convert and raise the sample enquiry',
      nextFollowUpDate: days(2, 11),
      activities: [
        { type: 'call', summary: 'Discussed volumes. 12,000 pcs first drop, repeat every quarter.', occurredAt: days(-7), createdBy: arun._id },
        { type: 'meeting', summary: 'Showed the flocked range at their Mumbai office. Wants charcoal.', occurredAt: days(-2), createdBy: arun._id },
      ],
    },
    {
      company: 'Budget Bazaar Retail',
      contactName: 'Naresh Kumar',
      mobile: '9945011223',
      city: 'Hyderabad',
      state: 'Telangana',
      source: 'phone',
      productInterest: '2,000 assorted hangers',
      estimatedQuantity: 2000,
      status: 'disqualified',
      disqualifyReason: 'volume_too_low',
      disqualifyNote: 'Below MOQ on every model and unwilling to consolidate.',
      assignedTo: nandhini._id,
      activities: [
        { type: 'call', summary: 'Quantity is one-off and below MOQ. Referred to our Hyderabad distributor.', occurredAt: days(-9), createdBy: nandhini._id },
      ],
    },
  ];

  const leads = [];
  for (const row of leadRows) {
    leads.push(await Lead.create({ ...row, number: await nextNumber('LEAD') }));
  }

  const groupRef = await nextNumber('GRP');

  const enquiryRows = [
    {
      customer: byName['SCM Garments Pvt Ltd'],
      assignedTo: nandhini._id,
      product: byCode['NPT-400S'],
      requirement: { modelNumber: 'NPT-400S', category: 'shirt', sizeMm: 400, material: 'plastic', colour: 'White', quantity: 80000, printing: 'SCM logo, single colour', packing: '200 pcs per carton' },
      targetPrice: 4.9,
      requiredDeliveryDate: days(24),
      status: 'quote_submitted',
      nextAction: 'Follow up on the quote with Karthik',
      nextFollowUpDate: days(0, 15),
      estimatedValue: 416000,
      probability: 60,
      enquiryDate: days(-9),
      source: 'phone',
      groupRef,
    },
    {
      customer: byName['SCM Garments Pvt Ltd'],
      assignedTo: nandhini._id,
      product: byCode['NPT-420T'],
      requirement: { modelNumber: 'NPT-420T', category: 'trouser', sizeMm: 420, material: 'plastic', colour: 'Black', quantity: 30000, packing: '100 pcs per carton' },
      targetPrice: 8.4,
      requiredDeliveryDate: days(24),
      status: 'pricing_required',
      nextAction: 'Get the clip cost from accounts and price it',
      nextFollowUpDate: days(1, 12),
      estimatedValue: 267000,
      probability: 50,
      enquiryDate: days(-9),
      source: 'phone',
      groupRef,
    },
    {
      customer: byName['Sunrise Exports'],
      assignedTo: nandhini._id,
      product: byCode['NPT-400R'],
      requirement: { modelNumber: 'NPT-400R', category: 'shirt', sizeMm: 400, material: 'recycled_pp', colour: 'Charcoal', quantity: 150000, printing: 'GRS mark on the shoulder', packing: '200 pcs per carton' },
      targetPrice: 5.6,
      requiredDeliveryDate: days(40),
      status: 'negotiation',
      nextAction: 'Send the revised landed price with GRS documentation',
      nextFollowUpDate: days(-1, 17),
      estimatedValue: 885000,
      probability: 70,
      enquiryDate: days(-14),
      source: 'email',
    },
    {
      customer: byName['Trendline Apparels'],
      assignedTo: nandhini._id,
      isNewDevelopment: true,
      requirement: { modelNumber: 'Matte 400mm white — new finish', category: 'shirt', sizeMm: 400, material: 'plastic', colour: 'Matte White', quantity: 40000, packing: '200 pcs per carton' },
      requiredDeliveryDate: days(45),
      status: 'sample_required',
      nextAction: 'Chase sampling for the matte finish trial piece',
      nextFollowUpDate: days(0, 10),
      estimatedValue: 224000,
      probability: 40,
      enquiryDate: days(-5),
      source: 'email',
      remarks: 'Buyer supplied a competitor sample for the finish reference.',
    },
    {
      customer: byName['Vogue Retail India'],
      assignedTo: arun._id,
      product: byCode['NPT-410V'],
      requirement: { modelNumber: 'NPT-410V', category: 'suit', sizeMm: 410, material: 'velvet', colour: 'Charcoal', quantity: 6000, packing: '50 pcs per carton' },
      targetPrice: 20,
      requiredDeliveryDate: days(30),
      status: 'new',
      nextAction: 'Confirm hook finish and whether they want the branded insert',
      nextFollowUpDate: days(1, 10),
      estimatedValue: 129000,
      probability: 25,
      enquiryDate: days(-1),
      source: 'phone',
    },
    {
      customer: byName['Orient Sourcing FZE'],
      assignedTo: arun._id,
      product: byCode['NPT-450C'],
      requirement: { modelNumber: 'NPT-450C', category: 'coat', sizeMm: 450, material: 'plastic', colour: 'Black', quantity: 45000, packing: '50 pcs per carton, export cartons' },
      targetPrice: 11.8,
      requiredDeliveryDate: days(60),
      status: 'po_expected',
      nextAction: 'Collect the PO and hand over to order confirmation',
      nextFollowUpDate: days(2, 14),
      estimatedValue: 558000,
      probability: 90,
      enquiryDate: days(-21),
      source: 'email',
    },
    {
      customer: byName['Sunrise Exports'],
      assignedTo: nandhini._id,
      product: byCode['NPT-300K'],
      requirement: { modelNumber: 'NPT-300K', category: 'kids', sizeMm: 300, material: 'plastic', colour: 'Assorted', quantity: 90000, packing: '250 pcs per carton' },
      status: 'won',
      estimatedValue: 306000,
      probability: 100,
      enquiryDate: days(-38),
      source: 'phone',
    },
    {
      customer: byName['Metro Wholesale Traders'],
      assignedTo: nandhini._id,
      product: byCode['NPT-380S'],
      requirement: { modelNumber: 'NPT-380S', category: 'shirt', sizeMm: 380, material: 'plastic', colour: 'White', quantity: 20000, packing: '200 pcs per carton' },
      status: 'lost',
      lostReason: 'price',
      lostNote: 'Local moulder quoted ₹4.10. Not worth matching at this volume.',
      estimatedValue: 92000,
      enquiryDate: days(-45),
      source: 'walk_in',
    },
    {
      customer: byName['Trendline Apparels'],
      assignedTo: nandhini._id,
      product: byCode['NPT-360W'],
      requirement: { modelNumber: 'NPT-360W', category: 'skirt', sizeMm: 360, material: 'wood', colour: 'Natural', quantity: 3000, packing: '25 pcs per carton' },
      status: 'hold',
      holdReason: 'Buyer paused the wooden range until their store refit finishes.',
      nextAction: 'Revisit after their refit',
      nextFollowUpDate: days(21, 11),
      estimatedValue: 102000,
      probability: 20,
      enquiryDate: days(-28),
      source: 'email',
    },
  ];

  const enquiries = [];
  for (const row of enquiryRows) {
    const { customer, product, ...rest } = row;
    enquiries.push(
      await Enquiry.create({
        ...rest,
        customer: customer._id,
        product: product?._id,
        number: await nextNumber('ENQ'),
        statusHistory: [{ to: rest.status, at: rest.enquiryDate, by: rest.assignedTo }],
      })
    );
  }

  const byNumber = Object.fromEntries(enquiries.map((enquiry) => [enquiry.number, enquiry]));

  /**
   * Samples at four points of their life, so the queue, the overdue escalation and the
   * feedback loop all have something real behind them.
   */
  const sampleRows = [
    {
      // Overdue and still unassigned — the case §25 escalates.
      enquiry: byNumber['ENQ-2026-0004'],
      status: 'production_required',
      purpose: 'new_development',
      colour: 'Matte White',
      quantity: 5,
      requiredDate: days(-2, 17),
      requestedAt: days(-5),
      autoCreated: true,
      remarks: 'Matte finish trial. Buyer supplied a competitor piece for reference.',
    },
    {
      // With the customer, waiting on their answer.
      enquiry: byNumber['ENQ-2026-0003'],
      status: 'dispatched',
      purpose: 'colour_approval',
      colour: 'Charcoal',
      quantity: 10,
      requiredDate: days(-6, 17),
      requestedAt: days(-12),
      assignedTo: meera?._id,
      courier: 'Blue Dart',
      awbNumber: '77213904118',
      dispatchedAt: days(-4),
      dispatchedQuantity: 10,
      autoCreated: true,
    },
    {
      // Ready on the bench, waiting for marketing to arrange the courier.
      enquiry: byNumber['ENQ-2026-0002'],
      status: 'sample_ready',
      purpose: 'existing_model',
      colour: 'Black',
      quantity: 6,
      requiredDate: days(1, 17),
      requestedAt: days(-3),
      assignedTo: meera?._id,
    },
    {
      // Settled: this is what an approved sample looks like in the register.
      enquiry: byNumber['ENQ-2026-0007'],
      status: 'approved',
      purpose: 'buyer_approval',
      colour: 'Assorted',
      quantity: 12,
      requiredDate: days(-30, 17),
      requestedAt: days(-36),
      assignedTo: meera?._id,
      courier: 'Professional Couriers',
      awbNumber: '55910233741',
      dispatchedAt: days(-31),
      dispatchedQuantity: 12,
      deliveredAt: days(-29),
      feedbackAt: days(-27),
      feedbackBy: nandhini._id,
      feedbackNote: 'Buyer approved all four colours. Proceed to pricing.',
    },
  ];

  const samples = [];
  for (const row of sampleRows) {
    const { enquiry, ...rest } = row;
    if (!enquiry) continue;

    samples.push(
      await Sample.create({
        ...rest,
        number: await nextNumber('SMP'),
        customer: enquiry.customer,
        enquiry: enquiry._id,
        requestedBy: enquiry.assignedTo,
        product: enquiry.product,
        modelNumber: enquiry.requirement.modelNumber,
        category: enquiry.requirement.category,
        sizeMm: enquiry.requirement.sizeMm,
        material: enquiry.requirement.material,
        printing: enquiry.requirement.printing,
        statusHistory: [
          { to: 'request_received', at: rest.requestedAt },
          ...(rest.status === 'request_received'
            ? []
            : [{ from: 'request_received', to: rest.status, at: rest.requestedAt }]),
        ],
      })
    );
  }

  return {
    products: products.length,
    customers: customers.length,
    leads: leads.length,
    enquiries: enquiries.length,
    samples: samples.length,
  };
}
