import { z } from 'zod';
import { HANDOFF_KEYS } from '../config/handoffs.js';

/** Sending a task about an enquiry: which button, and anything the department should know. */
const fields = z.record(z.string(), z.union([z.string(), z.number()]).transform(String)).optional();

export const handoffSchema = z.object({
  kind: z.enum(HANDOFF_KEYS),
  note: z.string().trim().max(2000).optional(),
  /** What the department that had it records about its work, when this moves it on. */
  fields,
  /** The answers to the form the department task opens with [config/departmentTaskForms.js]; checked by the service. */
  brief: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  /** Add to the department's open task of this kind instead of refusing the second one. */
  addToOpen: z.boolean().optional(),
  /** Sent knowing the enquiry's order is in production: that production stops and the order is revised [handoff.service `sendHandoff`]. */
  revise: z.boolean().optional(),
  /** The models' details changed on the form are written onto the enquiry too [itemDetails.service]. */
  updateEnquiry: z.boolean().optional(),
  /** The task's due date, when the person raising it names one. */
  requiredDate: z.string().trim().max(40).optional().or(z.literal('')),
  /** Which of the enquiry's sales orders the task is for, when it has several; else its newest. */
  order: z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id').optional().or(z.literal('')).transform((value) => value || undefined),
  /** Marketing's EDD, given on the form of a task the queues run by [services/eddAsk.service.js]. */
  edd: z.string().trim().max(10).optional().or(z.literal('')),
});

/** A department task raised for a team without an enquiry; a customer may be named. */
export const teamTaskSchema = z.object({
  kind: z.enum(HANDOFF_KEYS),
  note: z.string().trim().max(2000).optional(),
  brief: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  requiredDate: z.string().trim().max(40).optional().or(z.literal('')),
  customer: z.string().trim().max(40).optional().or(z.literal('')),
  /** The job's EDD, marketing's [services/eddAsk.service.js]. */
  edd: z.string().trim().max(10).optional().or(z.literal('')),
  /** Raised beside the same ask already open for the buyer and model, said so [handoff.service `sameOpenJob`]. */
  allowDuplicate: z.boolean().optional(),
});

/** A job raised from the customer: its EDD, set by marketing or Admin from any of its tasks. */
export const jobEddSchema = z.object({
  date: z.string().trim().min(1, 'Give the EDD').max(10),
  note: z.string().trim().max(500).optional(),
});

/** Done: what was done, and the details the button asks for [config/handoffs.js]. */
export const handoffDoneSchema = z.object({
  note: z.string().trim().min(2, 'Say what was done').max(2000),
  fields,
  /** Where the enquiry goes next — required when this task is the one holding the enquiry. */
  next: z.enum(HANDOFF_KEYS).optional(),
});

/** An update without moving the enquiry on. */
export const handoffUpdateSchema = z.object({
  note: z.string().trim().min(2, 'Say what the update is').max(2000),
  fields,
});

/** A department's own status on its task [config/departmentTaskForms.js `statuses`]. */
export const taskStatusSchema = z.object({
  status: z.string().trim().min(1).max(40),
  note: z.string().trim().max(2000).optional(),
  date: z.string().trim().max(10).optional(),
  /* …or a date for each model moving [Todo `modelDates`]. */
  dates: z.array(z.object({ model: z.string().trim().min(1).max(120), date: z.string().trim().min(10).max(10) })).max(60).optional(),
  /* What a status asks for beside the remark [departmentTaskForms `statuses[].fields`] — who collected a sample, how many pieces. */
  fields: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
  /* Only these of the task's models move [Todo `modelStatuses`]; none named, every model does. */
  models: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  /*
   * Production's move, carried to the floor [productionStep.service]: the press each model is
   * planned on or running on, the pieces made, whether to call the press in — or `skip`.
   */
  floor: z.object({
    skip: z.boolean().optional(),
    presses: z.array(z.object({ model: z.string().trim().min(1).max(120), machine: z.string().trim().regex(/^[0-9a-f]{24}$/i), counterStart: z.union([z.number().min(0), z.literal('')]).optional() })).max(60).optional(),
    made: z.array(z.object({ model: z.string().trim().min(1).max(120), goodPieces: z.number().min(0).max(1e8), rejectedPieces: z.number().min(0).max(1e8).optional(), counterEnd: z.union([z.number().min(0), z.literal('')]).optional() })).max(60).optional(),
    stop: z.boolean().optional(),
    models: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  }).optional(),
});

/** The expected delivery date, given from the Production / Assembly / Printing task [handoff.service `setTaskEdd`]. */
export const taskEddSchema = z.object({
  /* One date for every model on the task… */
  date: z.string().trim().max(10).optional(),
  /* …or a date for each model [Todo `modelDates`]. */
  models: z.array(z.object({
    model: z.string().trim().min(1).max(120),
    date: z.string().trim().min(10, 'Give each model’s date as a calendar date').max(10),
  })).max(60).optional(),
  note: z.string().trim().max(2000).optional(),
}).refine((body) => (body.date && body.date.length === 10) || body.models?.length, { message: 'Give the EDD as a calendar date', path: ['date'] });

/** Production's call, model by model: printed, assembled, both or neither [handoff.service `decideRouting`]. */
export const taskRoutingSchema = z.object({
  models: z.array(z.object({
    model: z.string().trim().min(1).max(120),
    printing: z.boolean().optional(),
    assembly: z.boolean().optional(),
  })).min(1, 'Name at least one model').max(60),
});

/** Production adds its task to the production queue: printing and assembly per model (unless decided), an EDD, a remark. */
export const productionQueueAddSchema = z.object({
  models: taskRoutingSchema.shape.models.optional(),
  date: z.string().trim().max(10).optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional(),
});

/** Printing or Assembly takes goods that came into its work queue: the models (all in hand when none), a remark. */
export const workQueueAddSchema = z.object({
  models: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Another department asked from this task — Dispatch's "Ask Production"; checked by the service. */
export const taskAskSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  updateEnquiry: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
  brief: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  requiredDate: z.string().trim().max(40).optional().or(z.literal('')),
});

/** Correcting what the task was told — only the questions marked `editable`; checked by the service. */
export const taskBriefSchema = z.object({
  brief: z.record(z.string(), z.unknown()),
});

export const handoffReturnSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it is being sent back').max(500),
});

export const deliveryUrgencySchema = z.object({
  urgency: z.enum(['top_urgent', 'today_morning', 'today_evening', 'today', 'tomorrow']),
  note: z.string().trim().max(500).optional(),
});

export const handoffAdminCloseSchema = z.object({
  reason: z.string().trim().min(5, 'Say why the task is being closed').max(500),
});

export const handoffEscalateSchema = z.object({
  reason: z.string().trim().min(5, 'Say what the issue is').max(2000),
});

export const handoffEscalationResolveSchema = z.object({
  note: z.string().trim().min(2, 'Say what was decided').max(2000),
});

export const handoffRescheduleSchema = z.object({
  dueDate: z.coerce.date(),
  reason: z.string().trim().min(5, 'Say why the date is moving').max(500),
});
