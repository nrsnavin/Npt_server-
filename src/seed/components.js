import Component from '../models/Component.js';

/**
 * The hook, clip and print registers.
 *
 * Rates are the ones the 26-27 sheet works to — ₹0.70 a hook, ₹1.20 for metal clips, ₹0.50 for
 * a single-colour print — so a costing built off these registers reproduces the plant's own
 * figures rather than a plausible imitation of them.
 *
 * The print entries are worth a note: the sheet writes "1 COLOUR" and "2 COLOUR" as a property
 * of the job, and the rate doubles between them. Holding each as its own row means a costing
 * names the one it is actually paying for, instead of a clerk remembering to double a number.
 */
const COMPONENTS = [
  /* Hooks. */
  { kind: 'hook', name: 'Fixed PP hook', code: 'HK-FIX', ratePerPiece: 0.45, supplier: 'Moulded in-house' },
  { kind: 'hook', name: 'Swivel metal hook', code: 'HK-SWV', colour: 'Nickel', ratePerPiece: 0.7, supplier: 'Sakthi Wire Products, Coimbatore' },
  { kind: 'hook', name: 'Swivel metal hook — black', code: 'HK-SWB', colour: 'Black', ratePerPiece: 0.78, supplier: 'Sakthi Wire Products, Coimbatore' },
  { kind: 'hook', name: 'Heavy swivel hook', code: 'HK-HVY', colour: 'Nickel', ratePerPiece: 1.1, supplier: 'Sakthi Wire Products, Coimbatore', notes: 'For coat and suit hangers — 2.3mm wire.' },

  /* Clips. */
  { kind: 'clip', name: 'Metal clip pair', code: 'CL-MTL', colour: 'Nickel', ratePerPiece: 1.2, supplier: 'Anand Clips, Tiruppur' },
  { kind: 'clip', name: 'PP moulded clip pair', code: 'CL-PPM', colour: 'Natural', ratePerPiece: 0.55, supplier: 'Moulded in-house' },
  { kind: 'clip', name: 'Soft-grip clip pair', code: 'CL-SFT', colour: 'Black', ratePerPiece: 1.65, supplier: 'Anand Clips, Tiruppur', notes: 'Rubberised jaw — for delicate fabrics.' },

  /* Printing, charged per piece per job. */
  { kind: 'print', name: '1 colour screen', code: 'PR-1C', ratePerPiece: 0.5, supplier: 'In-house screen line' },
  { kind: 'print', name: '2 colour screen', code: 'PR-2C', ratePerPiece: 1, supplier: 'In-house screen line' },
  { kind: 'print', name: 'Hot foil', code: 'PR-FOIL', colour: 'Gold', ratePerPiece: 1.4, supplier: 'Sri Vari Printers, Tiruppur' },
  { kind: 'print', name: 'Pad print — small logo', code: 'PR-PAD', ratePerPiece: 0.65, supplier: 'In-house screen line' },
];

export async function seedComponents() {
  await Component.deleteMany({});

  const created = await Component.create(
    COMPONENTS.map((row) => ({ ...row, rateUpdatedAt: new Date(), isActive: true }))
  );

  const count = (kind) => created.filter((row) => row.kind === kind).length;
  return { hooks: count('hook'), clips: count('clip'), prints: count('print') };
}
