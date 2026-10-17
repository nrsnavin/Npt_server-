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
  /** The task's due date, when the person raising it names one. */
  requiredDate: z.string().trim().max(40).optional().or(z.literal('')),
  /** Which of the enquiry's sales orders the task is for, when it has several; else its newest. */
  order: z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id').optional().or(z.literal('')).transform((value) => value || undefined),
});

/** A department task raised for a team without an enquiry; a customer may be named. */
export const teamTaskSchema = z.object({
  kind: z.enum(HANDOFF_KEYS),
  note: z.string().trim().max(2000).optional(),
  brief: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  requiredDate: z.string().trim().max(40).optional().or(z.literal('')),
  customer: z.string().trim().max(40).optional().or(z.literal('')),
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
});

/** The expected delivery date, given from the Production / Assembly / Printing task [handoff.service `setTaskEdd`]. */
export const taskEddSchema = z.object({
  date: z.string().trim().min(10, 'Give the EDD as a calendar date').max(10),
  note: z.string().trim().max(2000).optional(),
});

/** Another department asked from this task — Dispatch's "Ask Production"; checked by the service. */
export const taskAskSchema = z.object({
  kind: z.string().trim().min(1).max(40),
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

export const handoffRescheduleSchema = z.object({
  dueDate: z.coerce.date(),
  reason: z.string().trim().min(5, 'Say why the date is moving').max(500),
});
