import Mould from '../models/Mould.js';
import Customer from '../models/Customer.js';
import { few, leading } from './size.js';

/**
 * The mould register — which is now also the model master [BLUEPRINT §28].
 *
 * There used to be two seeds here: a product catalogue of model codes with a `mouldNumber`
 * written on each as free text, and a register of tools that pointed back at it. The pair
 * agreed only because they were written together, and the catalogue carried a hand-ticked
 * `mouldAvailable` beside the register that already knew the answer. One list now, because
 * there is one steel tool and it is the thing that exists.
 *
 * The figures are plausible for the size and weight of each model rather than uniform: a 15 g
 * kids' hanger runs twelve cavities on a nineteen-second cycle, a 48 g coat hanger runs two on
 * forty-one, and the runner is a far larger share of the small tool's shot than of the large
 * one's — 12.6% against 14.3%, which is not the direction most people would guess. A register
 * where every tool carries the same figures teaches nobody anything.
 *
 * Three details here exist to be met rather than to look tidy:
 *
 *   M-118  has a blocked cavity — three of four running. Output falls and consumption per
 *          piece rises together, which is the pair that a cut-cavity count alone gets wrong.
 *   M-141  is the customer's tool, so the model on it cannot be offered to anybody else.
 *   M-102  is one tool and two offers: the same geometry runs virgin PP and recycled PP, which
 *          used to be two catalogue rows and is now one tool costed against two materials.
 *
 * What is deliberately **not** here: the wooden skirt hanger and the chrome multi-tier, which
 * the plant buys in and resells. A traded piece has no steel of ours to record, so it has no
 * entry — it reaches the system as the model number the buyer asked for, on the enquiry. Five
 * of the twenty-five models on the plant's own 26-27 sheet are traded, so this is the ordinary
 * case rather than the awkward one, and a master that invented rows for them would be claiming
 * tools that do not exist.
 */

/**
 * `material` is the resin in the barrel, which is not always what the finished hanger is called.
 *
 * The velvet suit hanger is a moulded PP body that is then flocked; "velvet" describes what the
 * buyer receives and no resin is bought by that name. A gram weight recorded against a word
 * nobody purchases cannot be checked against a rate per kilo, and that check is the register's
 * whole use — so the tool records PP and the finish is a fact about the job.
 */
const MOULDS = [
  {
    mouldCode: 'M-101',
    name: '380mm slim shirt hanger',
    category: 'shirt',
    sizeMm: 380,
    hookType: 'fixed',
    material: 'pp',
    partWeightGrams: 22,
    moq: 5000,
    packingQty: 200,
    cavities: 8,
    runnerWeightGrams: 22,
    cycleTimeSeconds: 26,
    jobWorkCost: 0.75,
    hookCost: 0.7,
    packingCost: 0.2,
    efficiencyPercent: 92,
    machine: { code: 'INJ-01', tonnage: 180, hourRate: 420 },
    location: 'Moulding bay 1',
    mouldMaker: 'Sri Venkateswara Tools, Coimbatore',
    commissionedOn: '2021-06-14',
  },
  {
    mouldCode: 'M-102',
    name: '400mm standard shirt hanger',
    category: 'shirt',
    sizeMm: 400,
    hookType: 'swivel',
    material: 'pp',
    partWeightGrams: 26,
    moq: 5000,
    packingQty: 200,
    cavities: 8,
    runnerWeightGrams: 26,
    cycleTimeSeconds: 28,
    jobWorkCost: 0.8,
    hookCost: 0.7,
    printingCost: 0.5,
    packingCost: 0.2,
    efficiencyPercent: 90,
    machine: { code: 'INJ-02', tonnage: 200, hourRate: 450 },
    /* The runners come back: this tool feeds the grinder beside it and the blend takes 40%. */
    regrindRecoveryPercent: 40,
    location: 'Moulding bay 1',
    mouldMaker: 'Sri Venkateswara Tools, Coimbatore',
    commissionedOn: '2021-09-02',
    notes: 'Also runs recycled PP for GRS-scope orders — same tool, different resin and rate.',
  },
  {
    mouldCode: 'M-118',
    name: '420mm trouser hanger with clips',
    category: 'trouser',
    sizeMm: 420,
    hookType: 'clip',
    material: 'pp',
    partWeightGrams: 34,
    moq: 3000,
    packingQty: 100,
    cavities: 4,
    /*
     * One cavity blocked after a core pin sheared. The tool keeps earning on three, and both
     * numbers that matter move at once — a quarter less output, and every remaining piece
     * carrying a third of the runner instead of a quarter.
     */
    activeCavities: 3,
    runnerWeightGrams: 18,
    cycleTimeSeconds: 32,
    jobWorkCost: 1.1,
    hookCost: 0.7,
    clipsCost: 1.2,
    packingCost: 0.25,
    efficiencyPercent: 88,
    machine: { code: 'INJ-03', tonnage: 250, hourRate: 520 },
    status: 'maintenance',
    location: 'Moulding bay 2',
    notes: 'Cavity 4 blocked — core pin sheared 12 Jun. Tool room quoted 9 days for a new insert.',
  },
  {
    mouldCode: 'M-124',
    name: '450mm coat hanger — broad shoulder',
    category: 'coat',
    sizeMm: 450,
    hookType: 'metal_swivel',
    material: 'pp',
    partWeightGrams: 48,
    moq: 2000,
    packingQty: 50,
    cavities: 2,
    runnerWeightGrams: 16,
    cycleTimeSeconds: 41,
    jobWorkCost: 1.4,
    hookCost: 0.9,
    packingCost: 0.3,
    efficiencyPercent: 90,
    machine: { code: 'INJ-04', tonnage: 320, hourRate: 610 },
    location: 'Moulding bay 2',
    mouldMaker: 'Precision Moulds, Chennai',
    commissionedOn: '2022-02-11',
  },
  {
    mouldCode: 'M-107',
    name: '300mm kids hanger',
    category: 'kids',
    sizeMm: 300,
    hookType: 'fixed',
    material: 'pp',
    partWeightGrams: 15,
    moq: 10000,
    packingQty: 250,
    cavities: 12,
    runnerWeightGrams: 26,
    cycleTimeSeconds: 19,
    jobWorkCost: 0.55,
    hookCost: 0.45,
    packingCost: 0.15,
    efficiencyPercent: 94,
    machine: { code: 'INJ-01', tonnage: 180, hourRate: 420 },
    regrindRecoveryPercent: 40,
    location: 'Moulding bay 1',
    commissionedOn: '2020-11-27',
  },
  {
    mouldCode: 'M-133',
    name: '330mm lingerie hanger',
    category: 'lingerie',
    sizeMm: 330,
    hookType: 'fixed',
    material: 'pp',
    partWeightGrams: 14,
    moq: 10000,
    packingQty: 250,
    cavities: 12,
    runnerWeightGrams: 24,
    cycleTimeSeconds: 18,
    jobWorkCost: 0.5,
    hookCost: 0.4,
    packingCost: 0.15,
    efficiencyPercent: 93,
    machine: { code: 'INJ-05', tonnage: 150, hourRate: 380 },
    location: 'Moulding bay 3',
    commissionedOn: '2023-03-19',
  },
  {
    mouldCode: 'M-141',
    name: '410mm suit hanger — velvet flocked body',
    category: 'suit',
    sizeMm: 410,
    hookType: 'metal_swivel',
    material: 'pp',
    partWeightGrams: 52,
    moq: 1000,
    packingQty: 50,
    cavities: 2,
    runnerWeightGrams: 14,
    cycleTimeSeconds: 38,
    jobWorkCost: 1.6,
    hookCost: 1.1,
    packingCost: 0.4,
    efficiencyPercent: 85,
    machine: { code: 'INJ-04', tonnage: 320, hourRate: 610 },
    /*
     * The buyer paid for this tool, so the model on it is theirs. Recording it is what lets a
     * screen say so before somebody quotes the same hanger to a competitor down the road.
     */
    ownedByCustomerName: 'Vogue Retail India',
    location: 'Moulding bay 2',
    commissionedOn: '2024-07-08',
    notes: 'Customer-funded tool. Model is exclusive to them — not to be offered elsewhere.',
  },
];

export async function seedMoulds() {
  await Mould.deleteMany({});

  const created = [];

  /*
   * M-141 is pulled into the small set because it is the customer's own tool, and M-118 because
   * it is running three cavities of four. Those two rows are the only reason the register is
   * more than a list of weights.
   */
  for (const row of few(leading(MOULDS, 'mouldCode', ['M-101', 'M-102', 'M-118', 'M-141']))) {
    const { ownedByCustomerName, commissionedOn, ...fields } = row;

    created.push(
      await Mould.create({
        ...fields,
        status: row.status || 'active',
        commissionedOn: commissionedOn ? new Date(commissionedOn) : undefined,
      })
    );
  }

  return {
    moulds: created.length,
    /* Worth printing: it is the figure the whole register exists to make visible. */
    runnerShare: created.length
      ? Math.round(
          (created.reduce((sum, mould) => sum + mould.runnerPercent, 0) / created.length) * 10
        ) / 10
      : 0,
    blocked: created.filter((mould) => mould.runningCavities < mould.cavities).length,
  };
}

/**
 * Marks the buyer-funded tools, once the parties who paid for them exist.
 *
 * A second pass rather than a field set at creation, because the register is now the model
 * master and therefore has to be seeded *before* the enquiries that name a model — while the
 * customer who funded M-141 is created with the rest of the parties, after it. The pairing
 * still lives in this file, next to the tool it is about, so there is one place to correct it.
 */
export async function linkMouldOwners() {
  let linked = 0;

  for (const row of MOULDS.filter((mould) => mould.ownedByCustomerName)) {
    const owner = await Customer.findOne({ name: row.ownedByCustomerName });
    if (!owner) continue;

    const result = await Mould.updateOne(
      { mouldCode: row.mouldCode },
      { $set: { ownedBy: 'customer', ownedByCustomer: owner._id } }
    );
    linked += result.matchedCount || 0;
  }

  return linked;
}
