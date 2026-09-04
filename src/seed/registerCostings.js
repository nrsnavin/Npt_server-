import Pricing from '../models/Pricing.js';
import Customer from '../models/Customer.js';
import Mould from '../models/Mould.js';
import Material from '../models/Material.js';
import Component from '../models/Component.js';
import { nextNumber } from '../services/numbering.service.js';
import { priceFrom } from '../services/pricing.service.js';
import { costingFrom } from '../controllers/pricing.controller.js';
import { few, leading } from './size.js';

/**
 * Costings built the way the app builds them: pick a tool, a resin and the parts, and let the
 * registers fill the sheet.
 *
 * **This closes a real hole in the seeded data.** The 26-27 sheet's costings are transcribed
 * figures against models — `MAU-35 WB`, `CRF-30` — that have no tool on the mould register, so
 * on a freshly seeded database every register was populated and *nothing was priced off one*.
 * The grammage conversion, the rate copy and the parts lines were all covered by tests and
 * invisible to anyone clicking around, which is the worst place for a feature to be: working,
 * and impossible to see working.
 *
 * `costingFrom` is imported from the controller rather than reimplemented here. A seed that
 * does its own arithmetic is a second implementation of the rule, and the day they disagree the
 * seeded data looks like a bug in the app.
 *
 * Four things are deliberately in the mix:
 *
 *   NPT-420T  runs in HIPS on M-118 — the blocked-cavity tool. Its grammage carries both the
 *             short-cavity runner share *and* the +18% resin uplift, which is the compound case
 *             nobody works out by hand.
 *   NPT-410V  runs on the customer's own mould, so a screen can show that the model is not ours
 *             to offer elsewhere.
 *   NPT-400R  is the recycled-PP twin of NPT-400S off the same steel — one geometry, two
 *             catalogue entries, two rates.
 *   NPT-450C  is priced at the 15% tier rather than the floor, so not every seeded costing
 *             looks like the minimum is the only price anybody ever quotes.
 */

const JOBS = [
  {
    model: 'NPT-380S',
    customer: 'SCM Garments Pvt Ltd',
    mould: 'M-101',
    material: 'PP-NAT',
    hook: 'HK-FIX',
    quantity: 80000,
    markupPercent: 10,
  },
  {
    model: 'NPT-400S',
    customer: 'SCM Garments Pvt Ltd',
    mould: 'M-102',
    material: 'PP-WHT',
    hook: 'HK-SWV',
    print: 'PR-1C',
    quantity: 120000,
    markupPercent: 10,
    printing: '1 COLOUR',
  },
  {
    model: 'NPT-400R',
    customer: 'Sunrise Exports',
    mould: 'M-102',
    material: 'RPP-GRY',
    hook: 'HK-SWV',
    print: 'PR-PAD',
    quantity: 150000,
    markupPercent: 15,
    printing: 'GRS mark on the shoulder',
    remarks: 'GRS certified stock. Confirm shade against the approved swatch before each batch.',
  },
  {
    model: 'NPT-420T',
    customer: 'Trendline Apparels',
    /* The blocked-cavity tool, in the denser resin — both corrections at once. */
    mould: 'M-118',
    material: 'HIPS-NAT',
    hook: 'HK-HVY',
    clip: 'CL-MTL',
    quantity: 30000,
    markupPercent: 10,
    remarks: 'M-118 is running three of four cavities — re-cost when the insert is replaced.',
  },
  {
    model: 'NPT-450C',
    customer: 'Metro Wholesale Traders',
    mould: 'M-124',
    material: 'PP-BLK',
    hook: 'HK-HVY',
    quantity: 45000,
    /* Not the floor: a register of costings all priced at the minimum teaches the wrong habit. */
    markupPercent: 15,
  },
  {
    model: 'NPT-410V',
    customer: 'Vogue Retail India',
    /* Their tool, so the model is theirs — see the register's ownership field. */
    mould: 'M-141',
    material: 'HIPS-WHT',
    hook: 'HK-HVY',
    print: 'PR-FOIL',
    quantity: 6000,
    markupPercent: 20,
    printing: 'Hot foil crest, gold',
    remarks: 'Customer-funded mould. Not to be offered to anyone else.',
  },
  {
    model: 'NPT-300K',
    customer: 'Orient Sourcing FZE',
    mould: 'M-107',
    material: 'PP-NAT',
    hook: 'HK-FIX',
    quantity: 90000,
    markupPercent: 10,
    isExport: true,
  },
];

/** A lookup keyed on whatever field names the record, so a missing row is a skip not a crash. */
const by = (rows, key) => Object.fromEntries(rows.map((row) => [row[key], row]));

export async function seedRegisterCostings({ admin, nandhini }) {
  const [customers, moulds, materials, components] = await Promise.all([
    Customer.find().select('name'),
    Mould.find(),
    Material.find(),
    Component.find(),
  ]);

  const party = by(customers, 'name');
  const tool = by(moulds, 'mouldCode');
  const resin = by(materials, 'code');
  const part = by(components, 'code');

  const made = [];

  /*
   * The four whose mould, resin and parts all survive a trimmed set — and between them they
   * still carry every case this seed exists to show: the blocked cavity, the resin uplift, the
   * customer's own tool and a sheet priced above the floor rather than at it.
   */
  for (const job of few(leading(JOBS, 'model', ['NPT-380S', 'NPT-400S', 'NPT-420T', 'NPT-410V']))) {
    const customer = party[job.customer];
    const mould = tool[job.mould];
    const material = resin[job.material];

    /*
     * Everything above has to exist; a costing pointing at nothing is worse than one fewer.
     *
     * The skip is announced rather than silent. A mistyped code here would otherwise produce a
     * seed that finishes cleanly with six costings where seven were meant, and the only way to
     * notice is to already know the number — which is the sort of quiet shortfall that gets
     * mistaken for the feature not working.
     */
    const missing = [
      !customer && `customer ${job.customer}`,
      !mould && `mould ${job.mould}`,
      !material && `material ${job.material}`,
    ].filter(Boolean);
    if (missing.length) {
      console.warn(`  Skipped a costing — nothing on the register for ${missing.join(', ')}.`);
      continue;
    }

    const parts = {
      hook: job.hook ? part[job.hook] : undefined,
      clip: job.clip ? part[job.clip] : undefined,
      print: job.print ? part[job.print] : undefined,
    };

    const pricing = new Pricing({
      number: await nextNumber('PRC'),
      customer: customer._id,
      mould: mould._id,
      materialRef: material._id,
      hookRef: parts.hook?._id,
      clipRef: parts.clip?._id,
      printRef: parts.print?._id,
      /* The buyer's word for the model. The tool is named above; this is what goes on paper. */
      modelNumber: job.model,
      material: material.type,
      procurement: 'manufacture',
      printing: job.printing,
      quantity: job.quantity,
      /* The one line that matters: the registers fill the sheet, exactly as the app does. */
      cost: costingFrom(mould, material, parts),
      markupPercent: job.markupPercent,
      requestedBy: nandhini._id,
      costedBy: admin._id,
      remarks: job.remarks,
    });

    /* The app's own tier arithmetic, not a second copy of it — same reasoning as `costingFrom`. */
    pricing.calculatedSellingPrice = priceFrom(pricing);
    pricing.approvedSellingPrice = pricing.calculatedSellingPrice;

    /*
     * All of these clear their own floor, because they are priced off the tiers rather than off
     * a negotiation. §9's refusal route already has three genuine cases from the 26-27 sheet;
     * what the seed was missing was the ordinary state — an approved costing somebody can
     * actually raise a quotation from.
     */
    pricing.status = 'approved';
    pricing.approvedBy = admin._id;
    pricing.approvedAt = new Date();
    pricing.statusHistory = [
      { to: 'requested', by: nandhini._id },
      { from: 'requested', to: 'costed', by: admin._id },
      { from: 'costed', to: 'approved', by: admin._id },
    ];

    await pricing.save();
    made.push(pricing);
  }

  const uplifted = made.filter((row) => {
    const resinFor = materials.find((m) => String(m._id) === String(row.materialRef));
    return resinFor?.grammageFactorPercent > 0;
  });

  return {
    costings: made.length,
    uplifted: uplifted.length,
    /* Printed because it is the figure the whole chain exists to get right. */
    heaviest: made.reduce(
      (top, row) => (row.cost.gramWeight > (top?.cost.gramWeight ?? 0) ? row : top),
      null
    ),
  };
}
