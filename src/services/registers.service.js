import Material from '../models/Material.js';
import Component from '../models/Component.js';
import Mould, { MATERIALS } from '../models/Mould.js';
import ApiError from '../utils/ApiError.js';

/**
 * Turning register picks into a specification [BLUEPRINT §28].
 *
 * A sales order line and a sample request both say the same thing: what the plant has to make.
 * Which tool, which resin, which hook, which clip, which print. Every one of those is a record
 * somewhere else, and the point of this file is that both *point at those records* rather than
 * describing them again — which is also what lets §13's "approved sample" check mean something,
 * since the sample and the order become comparable rather than two boxes of similar text.
 *
 * Three things happen here, and each of them is a mistake that would otherwise reach the floor.
 *
 * **A part is checked against its own register.** `Component` is one collection behind three
 * registers, so a clip's id fits the hook field perfectly — same shape, same collection, silent
 * on save. The line would then read "hook: Wooden clip 25mm", and the first person to notice
 * would be whoever went to the store. So the kind is verified, and the refusal says which
 * register the thing actually came from.
 *
 * **What the registers already know is not asked for twice.** Choosing "HIPS White" fills the
 * material family and the colour; choosing a print job fills what is printed. A form that asked
 * for all of it again would be a form where the answers disagree — and the one that disagrees
 * is always the one nobody looks at.
 *
 * **A typed answer still wins.** Every fill is a default, not an override: a buyer who names a
 * shade we have to match, or a resin coloured with masterbatch, is ordinary rather than an
 * error. The register supplies what nobody has said; it never contradicts somebody who has.
 */

/** Which register each field must have come from, and what to call it in a refusal. */
const PART_FIELDS = [
  { field: 'hookRef', kind: 'hook', label: 'hook' },
  { field: 'clipRef', kind: 'clip', label: 'clip' },
  { field: 'printRef', kind: 'print', label: 'print job' },
];

/**
 * The coarse family a register entry belongs to.
 *
 * The material register's own types and the line's family list overlap but are not the same
 * list — the register knows LD, ABS and PS as grades the plant buys, and the line's list is
 * about what a *hanger* is made of, which includes wood and metal the register has never heard
 * of. Mapped rather than assumed, and left empty where there is no honest answer: a line that
 * said `pp` because nothing better fitted would be worse than one that said nothing.
 */
const familyOf = (material) => (MATERIALS.includes(material?.type) ? material.type : undefined);

/**
 * Resolves one line's register picks, and fills what they imply.
 *
 * Returns the patch to apply to the line rather than mutating it, because two of the three
 * callers are building a new line from parts and one is correcting an existing one — and a
 * function that mutated would need the line to exist before it could be checked.
 *
 * @param {object} line  the line as the request gave it
 * @returns {Promise<object>} the fields the registers decide, ready to spread over the line
 */
export async function resolveLineRegisters(line = {}) {
  const [material, ...parts] = await Promise.all([
    line.materialRef ? Material.findById(line.materialRef) : null,
    ...PART_FIELDS.map((part) => (line[part.field] ? Component.findById(line[part.field]) : null)),
  ]);

  const fill = {};

  if (line.materialRef) {
    if (!material) throw ApiError.badRequest('That material is not on the register');
    /*
     * An inactive grade is refused rather than warned about. The register marks a material
     * inactive when the plant has stopped buying it, and booking an order against one commits a
     * delivery date to a resin nobody can get — which is discovered at the press, weeks later.
     */
    if (material.isActive === false) {
      throw ApiError.badRequest(`${material.name} is no longer on the active register`);
    }

    fill.material = familyOf(material) ?? line.material;
    /* The colour follows the resin unless somebody has said otherwise — see the model's note. */
    if (!line.colour && material.colour) fill.colour = material.colour;
  }

  PART_FIELDS.forEach((part, index) => {
    const chosen = parts[index];
    if (!line[part.field]) return;

    if (!chosen) throw ApiError.badRequest(`That ${part.label} is not on the register`);
    /*
     * The check this file exists for. One collection, three registers — a clip's id is a
     * perfectly valid ObjectId in the hook field, and nothing downstream would ever query it
     * back out to notice.
     */
    if (chosen.kind !== part.kind) {
      throw ApiError.badRequest(
        `${chosen.name} is a ${chosen.kind}, not a ${part.label} — pick it from the ${part.label} register`
      );
    }
    if (chosen.isActive === false) {
      throw ApiError.badRequest(`${chosen.name} is no longer on the active ${part.label} register`);
    }

    /* What is printed, in words, so a delivery note and a screen can say it without a join. */
    if (part.kind === 'print' && !line.printing) fill.printing = chosen.name;
  });

  return fill;
}

/**
 * The register picks a costing already made, for a line being built from a quotation.
 *
 * The ordinary path into an order is an accepted quote, and the quote's price came off a
 * costing — which named the resin, the hook, the clip and the print it was built on. Carrying
 * those across is what makes "nothing is retyped" true of the specification and not only of the
 * price: an order booked this way is made of exactly what was costed, and a discrepancy between
 * the two stops being possible rather than merely unlikely.
 *
 * A pick already on the request wins, because a PO that specifies a different colour from the
 * quote is a real thing that happens and the buyer's paperwork is the one that governs.
 */
export const registersFromPricing = (pricing, asked = {}) => ({
  materialRef: asked.materialRef ?? pricing?.materialRef ?? undefined,
  hookRef: asked.hookRef ?? pricing?.hookRef ?? undefined,
  clipRef: asked.clipRef ?? pricing?.clipRef ?? undefined,
  printRef: asked.printRef ?? pricing?.printRef ?? undefined,
});

/**
 * What the tool itself says about a line, for the fields nobody should have to look up.
 *
 * The register is the model master [§28], so the category and the family are facts about the
 * steel rather than choices on an order. Filled only where the request left them empty.
 */
async function fillFromMould(line = {}) {
  if (!line.mould) return {};

  const mould = await Mould.findById(line.mould).select('category material mouldCode name');
  if (!mould) throw ApiError.badRequest('That model is not on the mould register');

  return {
    category: line.category ?? mould.category,
    material: line.material ?? mould.material,
    /* The tool's own name, where the buyer's PO did not give the model one of its own. */
    modelNumber: line.modelNumber ?? mould.mouldCode,
  };
}

/**
 * One specification — an order line or a sample request — as the registers say it should read.
 *
 * The whole resolution in one call, in the one order that is correct: the tool first, because
 * it is a fact about the steel and the weakest claim; then the registers, because a resin
 * picked for *this* job beats the tool's usual one; and anything the request actually said
 * beats both. Five callers need this — a hand-typed order, an order correction, one built from
 * a quotation, a sample request and a sample correction — and sequencing it wrongly in any of
 * them would put the tool's default resin over the one somebody deliberately chose.
 */
export async function buildSpec(spec = {}) {
  const withMould = { ...spec, ...(await fillFromMould(spec)) };
  return { ...withMould, ...(await resolveLineRegisters(withMould)) };
}

/** The four references, picked out of a resolved spec for a caller that assigns them by name. */
export const registerRefs = (spec = {}) => ({
  materialRef: spec.materialRef || undefined,
  hookRef: spec.hookRef || undefined,
  clipRef: spec.clipRef || undefined,
  printRef: spec.printRef || undefined,
});

/** Everything the registers have an opinion about, so a partial update can be merged properly. */
const SPEC_FIELDS = [
  'mould', 'modelNumber', 'category', 'material',
  'materialRef', 'hookRef', 'clipRef', 'printRef',
  'colour', 'printing',
];

/**
 * Applies a *partial* change to a record that carries a specification.
 *
 * The difference from `buildSpec` is the one that matters on a PATCH. An order replaces its
 * lines wholesale, so the request is the whole truth; a sample is corrected a field at a time,
 * so "did somebody type a colour?" has to be asked of the **merged** record rather than of the
 * patch. Resolving the patch alone would answer no every time — and a request that changed only
 * the resin would then quietly overwrite a shade the buyer had named.
 *
 * Only the specification fields are written back, never the whole merged object: assigning that
 * over a document would put `_id`, `number` and every timestamp back through Mongoose for no
 * reason, which is the kind of thing that works until one of them is immutable.
 */
export async function applySpec(doc, patch = {}) {
  const current = Object.fromEntries(
    SPEC_FIELDS.map((field) => [field, doc?.[field]]).filter(([, value]) => value !== undefined)
  );

  const merged = await buildSpec({ ...current, ...patch });
  const settled = Object.fromEntries(SPEC_FIELDS.map((field) => [field, merged[field]]));

  return { ...patch, ...settled };
}
