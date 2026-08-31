import Mould from '../models/Mould.js';
import Product from '../models/Product.js';
import Customer from '../models/Customer.js';

/**
 * The mould register, for the tools the seeded catalogue already refers to.
 *
 * The product master carries `mouldNumber` as free text — `M-101`, `M-102` — and until now
 * that string was the whole of what the system knew about a tool. These records give those
 * numbers something to be, with figures that are plausible for the size and weight of each
 * model rather than uniform: a 15 g kids' hanger runs twelve cavities on a nineteen-second
 * cycle, a 48 g coat hanger runs two on forty-one, and the runner is a far larger share of the
 * small tool's shot than of the large one's — 12.6% against 14.3%, which is not the direction
 * most people would guess. A register where every tool carries the same figures teaches nobody
 * anything.
 *
 * Three details here exist to be met rather than to look tidy:
 *
 *   M-118  has a blocked cavity — three of four running. Output falls and consumption per
 *          piece rises together, which is the pair that a cut-cavity count alone gets wrong.
 *   M-141  is the customer's tool, so the model on it cannot be offered to anybody else.
 *   M-102  makes two catalogue models, virgin and recycled PP off one geometry.
 *
 * Nothing here is invented where the catalogue already knows it: every part weight is the
 * product master's own `standardWeightGrams`, so the register and the catalogue agree on what
 * a piece weighs and disagree only about what it *consumes* — which is the whole point.
 */

/**
 * Cycle times and runner weights, by tool.
 *
 * `models` names product codes; the tool is skipped if none of them are in the catalogue, so
 * the register never carries a mould for a model that does not exist.
 */
const MOULDS = [
  {
    mouldCode: 'M-101',
    name: '380mm slim shirt hanger',
    models: ['NPT-380S'],
    cavities: 8,
    runnerWeightGrams: 22,
    cycleTimeSeconds: 26,
    efficiencyPercent: 92,
    machine: { code: 'INJ-01', tonnage: 180, hourRate: 420 },
    location: 'Moulding bay 1',
    mouldMaker: 'Sri Venkateswara Tools, Coimbatore',
    commissionedOn: '2021-06-14',
  },
  {
    mouldCode: 'M-102',
    name: '400mm standard shirt hanger',
    /* One geometry, two catalogue entries: the same steel runs virgin and recycled PP. */
    models: ['NPT-400S', 'NPT-400R'],
    cavities: 8,
    runnerWeightGrams: 26,
    cycleTimeSeconds: 28,
    efficiencyPercent: 90,
    machine: { code: 'INJ-02', tonnage: 200, hourRate: 450 },
    /* The runners come back: this tool feeds the grinder beside it and the blend takes 40%. */
    regrindRecoveryPercent: 40,
    location: 'Moulding bay 1',
    mouldMaker: 'Sri Venkateswara Tools, Coimbatore',
    commissionedOn: '2021-09-02',
  },
  {
    mouldCode: 'M-118',
    name: '420mm trouser hanger with clips',
    models: ['NPT-420T'],
    cavities: 4,
    /*
     * One cavity blocked after a core pin sheared. The tool keeps earning on three, and both
     * numbers that matter move at once — a quarter less output, and every remaining piece
     * carrying a third of the runner instead of a quarter.
     */
    activeCavities: 3,
    runnerWeightGrams: 18,
    cycleTimeSeconds: 32,
    efficiencyPercent: 88,
    machine: { code: 'INJ-03', tonnage: 250, hourRate: 520 },
    status: 'maintenance',
    location: 'Moulding bay 2',
    notes: 'Cavity 4 blocked — core pin sheared 12 Jun. Tool room quoted 9 days for a new insert.',
  },
  {
    mouldCode: 'M-124',
    name: '450mm coat hanger',
    models: ['NPT-450C'],
    cavities: 2,
    runnerWeightGrams: 16,
    cycleTimeSeconds: 41,
    efficiencyPercent: 90,
    machine: { code: 'INJ-04', tonnage: 320, hourRate: 610 },
    location: 'Moulding bay 2',
    mouldMaker: 'Precision Moulds, Chennai',
    commissionedOn: '2022-02-11',
  },
  {
    mouldCode: 'M-107',
    name: '300mm kids hanger',
    models: ['NPT-300K'],
    cavities: 12,
    runnerWeightGrams: 26,
    cycleTimeSeconds: 19,
    efficiencyPercent: 94,
    machine: { code: 'INJ-01', tonnage: 180, hourRate: 420 },
    regrindRecoveryPercent: 40,
    location: 'Moulding bay 1',
    commissionedOn: '2020-11-27',
  },
  {
    mouldCode: 'M-133',
    name: '330mm lingerie hanger',
    models: ['NPT-330L'],
    cavities: 12,
    runnerWeightGrams: 24,
    cycleTimeSeconds: 18,
    efficiencyPercent: 93,
    machine: { code: 'INJ-05', tonnage: 150, hourRate: 380 },
    location: 'Moulding bay 3',
    commissionedOn: '2023-03-19',
  },
  {
    mouldCode: 'M-141',
    name: '410mm suit hanger — velvet flocked body',
    models: ['NPT-410V'],
    cavities: 2,
    runnerWeightGrams: 14,
    cycleTimeSeconds: 38,
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

/**
 * What a tool actually moulds, which is not always what the catalogue calls the product.
 *
 * The master's material describes the finished hanger: `velvet` is a moulded body that is then
 * flocked, and `plastic` is what most of the seeded models say — a word nobody buys resin by.
 * A tool records the resin in the barrel, because a gram weight recorded against no resin
 * cannot be checked against a rate per kilo, and that check is the register's whole use.
 */
const MOULDING_RESINS = ['pp', 'hips', 'recycled_pp'];
const mouldingResin = (material) => (MOULDING_RESINS.includes(material) ? material : 'pp');

export async function seedMoulds() {
  await Mould.deleteMany({});

  const products = Object.fromEntries(
    (await Product.find().select('modelCode material standardWeightGrams')).map((product) => [
      product.modelCode,
      product,
    ])
  );

  const created = [];

  for (const row of MOULDS) {
    const models = row.models.map((code) => products[code]).filter(Boolean);
    /* A tool for a model nobody catalogued would be a register entry pointing at nothing. */
    if (!models.length) continue;

    const owner = row.ownedByCustomerName
      ? await Customer.findOne({ name: row.ownedByCustomerName })
      : null;

    created.push(
      await Mould.create({
        mouldCode: row.mouldCode,
        name: row.name,
        products: models.map((product) => product._id),
        material: mouldingResin(models[0].material),
        partWeightGrams: models[0].standardWeightGrams,
        cavities: row.cavities,
        activeCavities: row.activeCavities,
        runnerWeightGrams: row.runnerWeightGrams,
        regrindRecoveryPercent: row.regrindRecoveryPercent,
        cycleTimeSeconds: row.cycleTimeSeconds,
        efficiencyPercent: row.efficiencyPercent,
        machine: row.machine,
        status: row.status || 'active',
        ownedBy: owner ? 'customer' : 'company',
        ownedByCustomer: owner?._id,
        mouldMaker: row.mouldMaker,
        commissionedOn: row.commissionedOn ? new Date(row.commissionedOn) : undefined,
        location: row.location,
        notes: row.notes,
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
    customerOwned: created.filter((mould) => mould.ownedBy === 'customer').length,
    blocked: created.filter((mould) => mould.runningCavities < mould.cavities).length,
  };
}
