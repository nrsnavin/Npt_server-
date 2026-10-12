import mongoose from 'mongoose';

/**
 * Where a register record is used — every model whose schema points at it, found from the
 * schemas rather than listed by hand, so a reference added next month is counted without anybody
 * remembering this file. What a delete asks before it removes a mould or a bought-in item: a
 * record an enquiry, a quotation or a run points at is retired, never deleted, or the history
 * reads "—" where the model was.
 */

/** The paths of a schema (and its nested lists) holding an id of `target`. */
function pathsTo(schema, target, prefix = '') {
  const found = [];
  schema.eachPath((name, type) => {
    const path = `${prefix}${name}`;
    if (type.options?.ref === target) found.push(path);
    else if (type.caster?.options?.ref === target) found.push(path);
    if (type.schema) found.push(...pathsTo(type.schema, target, `${path}.`));
  });
  return found;
}

/** One and many, as a sentence wants them. */
const LABELS = {
  Enquiry: ['enquiry', 'enquiries'], Quotation: ['quotation', 'quotations'], Sample: ['sample', 'samples'],
  SalesOrder: ['sales order', 'sales orders'], MouldRun: ['mould run', 'mould runs'], QcRecord: ['QC record', 'QC records'],
  Inspection: ['inspection', 'inspections'], Dispatch: ['dispatch', 'dispatches'],
  MaintenanceRecord: ['maintenance record', 'maintenance records'],
};

/**
 * `[{ model, label, count }]` for each model using the record, the record's own files left out
 * (they go with it). `ignore` names further models not to count.
 */
export async function usageOf(target, id, { ignore = [] } = {}) {
  const skip = new Set(['Attachment', target, ...ignore]);
  const uses = [];
  for (const name of mongoose.modelNames()) {
    if (skip.has(name)) continue;
    const Model = mongoose.model(name);
    const paths = pathsTo(Model.schema, target);
    if (!paths.length) continue;
    const count = await Model.countDocuments({ $or: paths.map((path) => ({ [path]: id })) });
    if (count) {
      const [one, many] = LABELS[name] || [name, name];
      uses.push({ model: name, label: count === 1 ? one : many, count });
    }
  }
  return uses;
}

/** "3 enquiries, 1 quotation" — the uses, said. */
export const describeUsage = (uses) => uses.map(({ label, count }) => `${count} ${label}`).join(', ');
