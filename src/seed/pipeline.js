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
import { few, leading, resolved } from './size.js';
import { nextNumber } from '../services/numbering.service.js';

const days = (offset, hour = 11) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/**
 * Turns `[status, dayOffset, hour]` steps into a status history.
 *
 * Written out step by step rather than jumping from the request straight to the current
 * status, because the analytics reads the gaps between entries. A history that stamps every
 * change at the moment of the request describes a plant that finishes everything instantly.
 */
const walk = (requestedAt, steps) => {
  const history = [{ to: 'request_received', at: requestedAt }];
  for (const [to, offset, hour] of steps) {
    history.push({ from: history[history.length - 1].to, to, at: days(offset, hour) });
  }
  return history;
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

  /*
   * The four the rest of the seed cannot do without: the two ordinary shirt hangers, the trouser
   * hanger whose tool is running a cavity short, and the velvet suit hanger on the mould the
   * customer paid for. Between them they carry the blocked-cavity arithmetic, the resin uplift
   * and the ownership rule; a plain first-four would keep none of the last two.
   */
  const products = await Product.create(
    few(leading(PRODUCTS, 'modelCode', ['NPT-380S', 'NPT-400S', 'NPT-420T', 'NPT-410V']))
  );
  const byCode = Object.fromEntries(products.map((product) => [product.modelCode, product]));
  const byId = Object.fromEntries(products.map((product) => [String(product._id), product]));

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
  /* Vogue is fourth by name here because it owns a mould, and the register has to be able to
     say whose tool it is. */
  for (const row of few(
    leading(customerRows, 'name', [
      'SCM Garments Pvt Ltd', 'Sunrise Exports', 'Trendline Apparels', 'Vogue Retail India',
    ])
  )) {
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
  for (const row of few(leadRows)) {
    leads.push(await Lead.create({ ...row, number: await nextNumber('LEAD') }));
  }

  /*
   * Enquiries by a key of their own, not by the number they happen to be issued.
   *
   * The samples below used to find their enquiry as `ENQ-2026-0003` — the third one created.
   * That is a reference to a position in an array dressed up as a reference to a record: reorder
   * the enquiries or seed fewer of them and every sample silently attaches to a different one,
   * or to nothing, with no error anywhere. A key written on the row survives both.
   */
  const byKey = {};

  const groupRef = await nextNumber('GRP');

  const enquiryRows = [
    {
      key: 'scm-400s',
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
      key: 'scm-420t',
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
      key: 'sunrise-400r',
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
      key: 'trendline-matte',
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
      key: 'vogue-410v',
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
      key: 'orient-450c',
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
      key: 'sunrise-300k',
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
      key: 'metro-380s',
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
      key: 'trendline-360w',
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

  /*
   * Only the enquiries whose customer and model both survived the trim.
   *
   * `'product' in row` tells a row that asked for a model from one that never had one — the
   * matte-finish trial is a new development and correctly has no product, which is not the same
   * thing as a row whose model was trimmed away and would be created pointing at nothing.
   */
  const enquiries = [];
  for (const row of few(
    resolved(
      enquiryRows,
      (row) => row.customer && (!('product' in row) || row.product),
      'enquiries'
    )
  )) {
    const { key, customer, product, ...rest } = row;
    enquiries.push(
      await Enquiry.create({
        ...rest,
        customer: customer._id,
        product: product?._id,
        number: await nextNumber('ENQ'),
        statusHistory: [{ to: rest.status, at: rest.enquiryDate, by: rest.assignedTo }],
      })
    );
    byKey[key] = enquiries[enquiries.length - 1];
  }

  /**
   * Samples at four points of their life, so the queue, the overdue escalation and the
   * feedback loop all have something real behind them.
   */
  const sampleRows = [
    {
      // Overdue and still unassigned — the case §25 escalates.
      enquiry: byKey['trendline-matte'],
      status: 'production_required',
      purpose: 'new_development',
      colour: 'Matte White',
      quantity: 5,
      requiredDate: days(-2, 17),
      requestedAt: days(-5),
      autoCreated: true,
      remarks: 'Matte finish trial. Buyer supplied a competitor piece for reference.',
      history: [['checking_stock', -5, 15], ['production_required', -4, 10]],
    },
    {
      // With the customer, waiting on their answer.
      enquiry: byKey['vogue-410v'],
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
      history: [
        ['checking_stock', -12, 15],
        ['production_required', -11, 10],
        ['sample_ready', -5, 16],
        ['dispatched', -4, 11],
      ],
    },
    {
      // Ready on the bench, waiting for marketing to arrange the courier.
      enquiry: byKey['scm-420t'],
      status: 'sample_ready',
      purpose: 'existing_model',
      colour: 'Black',
      quantity: 6,
      requiredDate: days(1, 17),
      requestedAt: days(-3),
      assignedTo: meera?._id,
      history: [['sample_available', -3, 14], ['sample_ready', -1, 12]],
    },
    {
      // Settled: this is what an approved sample looks like in the register.
      enquiry: byKey['scm-400s'],
      status: 'approved',
      purpose: 'buyer_approval',
      colour: 'White',
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
      feedbackNote: 'Buyer approved the shade and the print. Proceed to pricing.',
      history: [
        ['checking_stock', -36, 15],
        ['production_required', -35, 10],
        ['printing_required', -34, 12],
        ['sample_ready', -32, 16],
        ['dispatched', -31, 11],
        ['delivered', -29, 14],
        ['approved', -27, 10],
      ],
    },
  ];

  /**
   * Settled requests from earlier months.
   *
   * The four above describe the queue as it stands, which is what the sampling screens are
   * for. The analytics page asks a different question — how long we take, and what makes the
   * difference — and cannot answer it from four rows in one month. These carry the spread it
   * reads: printed against plain, hook types, and a turnaround that varies by more than noise.
   */
  const historicalRows = [
    { model: 'NPT-380S', purpose: 'existing_model', quantity: 4, took: 3, agoDays: 12, printing: '' },
    { model: 'NPT-400S', purpose: 'colour_approval', quantity: 6, took: 4, agoDays: 20, printing: '' },
    { model: 'NPT-400S', purpose: 'existing_model', quantity: 3, took: 3, agoDays: 26, printing: '' },
    { model: 'NPT-360W', purpose: 'buyer_approval', quantity: 8, took: 6, agoDays: 34, printing: '' },
    { model: 'NPT-380S', purpose: 'print_approval', quantity: 5, took: 9, agoDays: 41, printing: 'Two-colour logo, front face' },
    { model: 'NPT-400S', purpose: 'print_approval', quantity: 6, took: 11, agoDays: 48, printing: 'Buyer brand mark, both faces' },
    { model: 'NPT-360W', purpose: 'new_development', quantity: 10, took: 21, agoDays: 55, printing: '' },
    { model: 'NPT-380S', purpose: 'existing_model', quantity: 2, took: 2, agoDays: 62, printing: '' },
    { model: 'NPT-400S', purpose: 'fit_test', quantity: 5, took: 5, agoDays: 70, printing: '' },
    { model: 'NPT-380S', purpose: 'print_approval', quantity: 4, took: 10, agoDays: 78, printing: 'Single-colour size mark' },
    // The one that went wrong. It is why the report shows the worst case beside the average:
    // at this volume p90 sits below it, and this is the one worth the conversation.
    { model: 'NPT-360W', purpose: 'new_development', quantity: 12, took: 38, agoDays: 90, printing: '', outcome: 'modification_required' },
    { model: 'NPT-400S', purpose: 'colour_approval', quantity: 6, took: 4, agoDays: 96, printing: '' },
  ];

  const samples = [];
  for (const row of resolved(sampleRows, (row) => row.enquiry, 'sample requests')) {
    const { enquiry, history = [], ...rest } = row;

    const product = enquiry.product ? byId[String(enquiry.product)] : null;

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
        // Inherited from the model, the way a request raised through the API inherits it.
        hookType: product?.hookType,
        statusHistory: walk(rest.requestedAt, history),
      })
    );
  }

  /*
   * The settled back-catalogue the analytics page reads.
   *
   * Trimmed like everything else, and filtered to models that are actually in this set — a
   * historical sample against a hanger the catalogue no longer carries is a row the analytics
   * page cannot attribute to anything. On the small set the report is correspondingly thin,
   * which is the honest consequence of a small set rather than something to paper over.
   */
  for (const row of few(historicalRows.filter((row) => byCode[row.model]))) {
    const product = byCode[row.model];
    const customer = customers[samples.length % customers.length];
    const outcome = row.outcome || 'approved';

    // A plausible run through the stages, ending at the outcome. The two dates that matter
    // analytically are the request and the ready tick; the rest give the stage breakdown
    // something to divide up.
    const raised = days(-(row.agoDays + row.took));
    const history = [
      ['checking_stock', -(row.agoDays + row.took), 15],
      [row.printing ? 'printing_required' : 'production_required', -(row.agoDays + row.took) + 1, 10],
      ['sample_ready', -row.agoDays, 16],
      ['dispatched', -row.agoDays + 1, 11],
      ['delivered', -row.agoDays + 3, 14],
      [outcome, -row.agoDays + 5, 10],
    ];

    samples.push(
      await Sample.create({
        number: await nextNumber('SMP'),
        customer: customer._id,
        requestedBy: nandhini._id,
        assignedTo: meera?._id,
        product: product?._id,
        modelNumber: product?.modelCode,
        category: product?.category,
        sizeMm: product?.sizeMm,
        material: product?.material,
        hookType: product?.hookType,
        printing: row.printing,
        colour: product?.availableColours?.[0],
        quantity: row.quantity,
        purpose: row.purpose,
        status: outcome,
        requestedAt: raised,
        // Promised a week; the slow ones therefore miss it, which is the point of on-time.
        requiredDate: days(-(row.agoDays + row.took) + 7, 17),
        courier: 'Blue Dart',
        awbNumber: `7721${String(390000 + samples.length)}`,
        dispatchedAt: days(-row.agoDays + 1, 11),
        dispatchedQuantity: row.quantity,
        deliveredAt: days(-row.agoDays + 3, 14),
        feedbackAt: days(-row.agoDays + 5, 10),
        feedbackBy: nandhini._id,
        statusHistory: walk(raised, history),
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
