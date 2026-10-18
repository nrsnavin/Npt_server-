import { DOWNTIME_KEYS, REJECT_KEYS } from '../config/productionReasons.js';
import { z } from 'zod';
import { DEFECT_KEYS } from '../models/Inspection.js';
import { MOULDING_TYPE_KEYS, PRINT_TYPE_KEYS, QC_STAGE_KEYS, QC_VERDICTS, SHIFTS } from '../models/QcRecord.js';
import { MACHINE_STATUSES } from '../models/Machine.js';
import { MAINTENANCE_TYPE_KEYS } from '../models/MaintenanceRecord.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id');
const optionalId = objectId.optional().or(z.literal('')).transform((value) => value || undefined);
const text = (max) => z.string().trim().max(max).optional().or(z.literal('')).transform((value) => value || undefined);
const num = (max = 1e7) => z.number().min(0).max(max).nullable().optional().transform((value) => value ?? undefined);
const passFail = z.enum(['pass', 'fail', 'not_tested']).optional();
const date = z.coerce.date().optional();

export const qcRecordSchema = z.object({
  stage: z.enum(QC_STAGE_KEYS),
  enquiry: optionalId, order: optionalId, orderLine: optionalId, task: optionalId, run: optionalId,
  mould: optionalId, modelNumber: text(80), size: text(40), mouldingType: z.enum(MOULDING_TYPE_KEYS).optional(),
  cavities: text(60), machine: optionalId, shift: z.enum(SHIFTS).optional(), operator: text(80), producedOn: date,
  resin: z.object({
    material: optionalId, name: text(80), grade: text(60), batch: text(60), supplier: text(80), colour: text(60),
    masterbatch: text(60), masterbatchPercent: num(100), regrindPercent: num(100),
  }).optional(),
  hook: z.object({ type: text(60), finish: text(60), pullRequiredKg: num(1000), pullActualKg: num(1000), result: passFail }).optional(),
  clip: z.object({ type: text(60), gripRequiredKg: num(1000), gripActualKg: num(1000), result: passFail }).optional(),
  print: z.object({ type: z.enum(PRINT_TYPE_KEYS).optional(), colour: text(60), artwork: text(120), adhesion: passFail, registration: passFail }).optional(),
  weight: z.object({ target: num(10000), tolerance: num(10000), actual: num(10000), result: passFail }).optional(),
  measurements: z.array(z.object({ name: z.string().trim().min(1).max(60), unit: text(10), target: num(100000), tolerance: num(100000), actual: num(100000), result: passFail })).max(20).optional(),
  breaking: z.object({ requiredKg: num(10000), samplesKg: z.array(z.number().min(0).max(10000)).max(50).optional(), result: passFail }).optional(),
  hangLoad: z.object({ loadKg: num(10000), hours: num(1000), deflectionMm: num(10000), allowedDeflectionMm: num(10000), result: passFail }).optional(),
  drop: z.object({ heightCm: num(10000), drops: num(1000), result: passFail }).optional(),
  colourMatch: z.object({ against: text(120), result: passFail }).optional(),
  hookTurns: z.object({ required: num(1e7), achieved: num(1e7), result: passFail }).optional(),
  uv: z.object({ hours: num(10000), result: passFail }).optional(),
  shrinkage: z.object({ mouldMm: num(100000), partMm: num(100000), maxPercent: num(100), result: passFail }).optional(),
  resinChecks: z.object({
    moisturePercent: num(100), moistureMaxPercent: num(100), moistureResult: passFail,
    mfi: num(1000), mfiMin: num(1000), mfiMax: num(1000), mfiResult: passFail,
  }).optional(),
  packing: z.object({ piecesPerCarton: num(100000), piecesFound: num(100000), cartonsChecked: num(100000), labels: passFail, result: passFail }).optional(),
  cartonDrop: z.object({ heightCm: num(10000), drops: num(1000), result: passFail }).optional(),
  aql: z.union([z.literal(0.65), z.literal(1), z.literal(1.5), z.literal(2.5), z.literal(4), z.literal(6.5)]).optional(),
  standardsFrom: text(200),
  lotSize: num(), sampleSize: num(), accepted: num(), rejected: num(),
  defects: z.array(z.object({ type: z.enum(DEFECT_KEYS), count: z.number().int().min(1), note: text(300) })).max(30).optional(),
  verdict: z.enum(QC_VERDICTS),
  remarks: text(2000),
  inspectedAt: date,
});

export const machineSchema = z.object({
  code: z.string().trim().min(1, 'The machine number').max(20),
  name: text(80), make: text(80), tonnage: num(5000), year: z.number().int().min(1950).max(2100).nullable().optional(),
  shotCapacityGrams: num(100000), location: text(80), status: z.enum(MACHINE_STATUSES).optional(),
  serviceEveryDays: num(3650), notes: text(1000), active: z.boolean().optional(), expectedUpdatedAt: z.string().optional(),
});
export const machineUpdateSchema = machineSchema.partial();

export const maintenanceSchema = z.object({
  asset: z.enum(['machine', 'mould']),
  machine: optionalId, mould: optionalId, onMachine: optionalId,
  type: z.enum(MAINTENANCE_TYPE_KEYS),
  doneOn: date,
  problem: text(1000),
  workDone: z.string().trim().min(3, 'Say what was done').max(2000),
  parts: z.array(z.object({ name: z.string().trim().min(1).max(120), quantity: num(100000), cost: num(10000000) })).max(30).optional(),
  doneBy: text(120), vendor: text(120), downtimeHours: num(10000), labourCost: num(10000000),
  shotCount: num(1e10), nextDueOn: date, nextDueShots: num(1e10),
  backInService: z.boolean().optional(),
});

export const runStartSchema = z.object({
  mould: optionalId, workOrder: optionalId, machine: optionalId, enquiry: optionalId, order: optionalId, orderLine: optionalId,
  modelNumber: text(80), colour: text(60), plannedQuantity: num(1e9),
  startedAt: date, shift: z.enum(SHIFTS).optional(), operator: text(80),
  counterStart: num(1e10), cavitiesRunning: num(1000), cycleTimeSeconds: num(10000),
  resin: z.object({ material: optionalId, name: text(80), batch: text(60), usedKg: num(1e7) }).optional(),
}).refine((body) => body.mould || body.workOrder, { message: 'Pick the mould, or start it from a work order', path: ['mould'] });

const downtimeEntry = z.object({ reason: z.enum(DOWNTIME_KEYS), minutes: z.number().min(0).max(100000), note: text(300) });
const rejectEntry = z.object({ reason: z.enum(REJECT_KEYS), pieces: z.number().int().min(0).max(1e9) });

/** A line on a running job: the counter read, a stop with its reason, or rejects by defect. */
export const runLogSchema = z.object({
  counter: num(1e10),
  downtime: downtimeEntry.optional(),
  rejects: rejectEntry.optional(),
}).refine((body) => body.counter != null || body.downtime || body.rejects, { message: 'Log a counter reading, a stop or rejects' });

export const runFinishSchema = z.object({
  downtime: z.array(downtimeEntry).max(50).optional(),
  rejects: z.array(rejectEntry).max(50).optional(),
  counterEnd: num(1e10), goodPieces: num(1e9), rejectedPieces: num(1e9), regrindKg: num(1e7),
  downtimeMinutes: num(1e6), downtimeReason: text(300), issues: text(2000),
  cycleTimeSeconds: num(10000), cavitiesRunning: num(1000), operator: text(80), shift: z.enum(SHIFTS).optional(),
  resin: z.object({ material: optionalId, name: text(80), batch: text(60), usedKg: num(1e7) }).optional(),
  endedAt: date, aborted: z.boolean().optional(),
});

export const stockMovementSchema = z.object({
  kind: z.enum(['receipt', 'adjust']),
  kg: z.number().min(-1e7).max(1e7).refine((value) => value !== 0, 'Say how many kilograms'),
  reference: text(120),
  note: text(500),
}).refine((body) => body.kind !== 'receipt' || body.kg > 0, { message: 'A receipt adds stock — the kilograms received', path: ['kg'] });


/** A work order planned or moved [workOrder.service `planWorkOrder`]. */
export const workOrderPlanSchema = z.object({
  machine: objectId.nullable().optional(),
  plannedStart: z.coerce.date().nullable().optional(),
  sequence: z.number().int().min(0).max(100000).nullable().optional(),
  move: z.enum(['release', 'pause', 'resume', 'complete', 'cancel', 'replan']).optional(),
  note: text(500),
  updatedAt: z.string().optional(),
});
