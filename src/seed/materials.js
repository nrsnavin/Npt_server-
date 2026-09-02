import Material from '../models/Material.js';

/**
 * The resin register.
 *
 * Rates are the ones the 26-27 costing sheet actually works to — ₹160/kg for PP and ₹90 for
 * HIPS are its own two figures — so a seeded costing reproduces the sheet rather than a
 * plausible imitation of it.
 *
 * **The grammage factor is the point of the table.** A mould's cavity is a fixed volume, so the
 * same tool throws a heavier part in a denser resin. PP and LD are the basis a tool's grammage
 * is recorded in and sit at 0; HIPS carries the plant's own +18%. Held per material rather than
 * decided by a check on the resin's name, so a grade that behaves differently says so here
 * instead of needing somebody to edit code — and so the person who owns the number can see it.
 */
const MATERIALS = [
  {
    name: 'PP Natural',
    code: 'PP-NAT',
    type: 'pp',
    colour: 'Natural',
    ratePerKg: 160,
    grammageFactorPercent: 0,
    supplier: 'Reliance — via Coimbatore stockist',
  },
  {
    name: 'PP White',
    code: 'PP-WHT',
    type: 'pp',
    colour: 'White',
    /* Masterbatch on top of the natural grade, which is why it is not the same rate. */
    ratePerKg: 168,
    grammageFactorPercent: 0,
    supplier: 'Reliance — via Coimbatore stockist',
  },
  {
    name: 'PP Black',
    code: 'PP-BLK',
    type: 'pp',
    colour: 'Black',
    ratePerKg: 164,
    grammageFactorPercent: 0,
    supplier: 'Reliance — via Coimbatore stockist',
  },
  {
    name: 'HIPS Natural',
    code: 'HIPS-NAT',
    type: 'hips',
    colour: 'Natural',
    ratePerKg: 90,
    /*
     * The one entry that is not zero. HIPS is about 1.05 g/cc against PP's 0.905, and the plant
     * works to a round 18% — near enough the density ratio, and it is their figure rather than
     * a textbook one, so this is the number a costing should reproduce.
     */
    grammageFactorPercent: 18,
    supplier: 'Supreme Petrochem',
  },
  {
    name: 'HIPS White',
    code: 'HIPS-WHT',
    type: 'hips',
    colour: 'White',
    ratePerKg: 96,
    grammageFactorPercent: 18,
    supplier: 'Supreme Petrochem',
  },
  {
    name: 'LD Natural',
    code: 'LD-NAT',
    type: 'ld',
    colour: 'Natural',
    ratePerKg: 118,
    /* Close enough to PP in density that the plant treats the grammage as the same. */
    grammageFactorPercent: 0,
    supplier: 'GAIL — via local stockist',
  },
  {
    name: 'Recycled PP',
    code: 'RPP-GRY',
    type: 'recycled_pp',
    colour: 'Charcoal',
    ratePerKg: 96,
    grammageFactorPercent: 0,
    supplier: 'Sri Balaji Reprocessors, Tiruppur',
    notes: 'GRS certified. Batch-to-batch colour varies — confirm shade before a print job.',
  },
];

export async function seedMaterials() {
  await Material.deleteMany({});

  const created = await Material.create(
    MATERIALS.map((row) => ({ ...row, rateUpdatedAt: new Date(), isActive: true }))
  );

  return {
    materials: created.length,
    /* Worth printing: the uplift is the figure a costing gets wrong when it is done by hand. */
    uplifted: created.filter((row) => row.grammageFactorPercent > 0).length,
  };
}
