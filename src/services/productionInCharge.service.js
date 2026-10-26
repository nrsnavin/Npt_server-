import User from '../models/User.js';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import { raiseTask, resolveTasks } from './task.service.js';
import { MANAGEMENT_QUERY } from '../utils/departments.js';

/**
 * The Production in charge's own to-dos [models/User.js `productionInCharge`]:
 *
 *   Give the EDD      raised when a Production task arrives; closed once its date is given (EDD
 *                     or hand-over), or the task ends. Nobody marked in charge: Admin is asked,
 *                     and told to mark someone.
 *   Confirm the EDD   raised when Printing or Assembly — the last team in the chain — gives the
 *                     EDD; closed when the in charge confirms it or gives their own.
 *   Told              when Admin plans in their place (the EDD, printing / assembly, the queue).
 */

export const planKey = (task) => `production-plan:${task._id}`;
export const confirmKey = (task) => `production-confirm:${task._id}`;

/** Everyone marked Production in charge and still working here. Admin is not listed: Admin plans by role. */
export const productionInCharge = () => User.find({ productionInCharge: true, isActive: { $ne: false }, role: { $ne: 'admin' } })
  .select('name department').sort({ name: 1 }).lean();

/** Who is asked to plan: the in charge — or, when nobody is marked, Admin. */
async function planners() {
  const people = await productionInCharge();
  if (people.length) return { people, nobody: false };
  return { people: await User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('name').lean(), nobody: true };
}

/** "ENQ-2026-0012 · Aruna Knits · NPT-400S" — or "Team task · …" for a job with no enquiry. */
async function about(task) {
  const enquiry = task.enquiry ? await Enquiry.findById(task.enquiry?._id || task.enquiry).select('number customer').populate('customer', 'name').lean() : null;
  /* A team task names its buyer itself — as an id until it is looked up. */
  const buyer = !enquiry && task.customer ? (task.customer.name ? task.customer : await Customer.findById(task.customer).select('name').lean()) : null;
  const customer = enquiry?.customer?.name || buyer?.name || null;
  const model = task.brief?.models || task.brief?.model || null;
  return [enquiry?.number || 'Team task', customer, model].filter(Boolean).join(' · ');
}

/** The Production workflow page of the job this task belongs to. */
async function workflowLink(task) {
  if (task.kind === 'ask_edd') return `/production/workflow/${task._id}`;
  const scope = task.enquiry ? { enquiry: task.enquiry?._id || task.enquiry } : { chain: task.chain };
  const production = scope.enquiry || scope.chain ? await Todo.findOne({ ...scope, kind: 'ask_edd' }).sort({ createdAt: -1 }).select('_id').lean() : null;
  return production ? `/production/workflow/${production._id}` : '/production/queue';
}

/** A Production task arrived: the in charge is asked for its EDD (Admin, when nobody is in charge). */
export async function askToPlan(task) {
  if (!task || task.kind !== 'ask_edd' || task.completed) return 0;
  const { people, nobody } = await planners();
  const what = await about(task);
  const link = await workflowLink(task);
  for (const person of people) {
    await raiseTask({
      user: person._id,
      title: `Give the EDD — ${what}`,
      notes: nobody
        ? 'Nobody is marked Production in charge. Give the EDD yourself, or tick someone in Masters & Access → Module access.'
        : 'Decide printing / assembly for each model, then give the EDD (or the hand-over date).',
      priority: 'high',
      dueDate: task.dueDate || new Date(),
      link,
      originKey: planKey(task),
    });
  }
  return people.length;
}

/** Production's date is given, or its task has ended: the "Give the EDD" to-dos close. */
export const planned = (task) => resolveTasks(planKey(task));

/**
 * The last team in the chain (Printing or Assembly) gave the EDD: the in charge confirms it or
 * gives their own. Their own date needs no confirming.
 */
export async function askToConfirm(task, by, day) {
  const { people } = await planners();
  const what = await about(task);
  const link = await workflowLink(task);
  const team = task.kind === 'ask_printing' ? 'Printing' : 'Assembly';
  for (const person of people) {
    if (String(person._id) === String(by?._id || by)) continue;
    await raiseTask({
      user: person._id,
      title: `Confirm the EDD ${team} gave — ${what}: ${day}`,
      notes: `${by?.name || team} gave ${day}. Confirm it, or give the EDD yourself.`,
      priority: 'high',
      dueDate: new Date(),
      link,
      originKey: confirmKey(task),
    });
  }
}

export const confirmed = (task) => resolveTasks(confirmKey(task));

export const pressKey = (task) => `production-presses:${task._id}`;

/**
 * The auto-planner proposed a press for models of a Production task [floorPlanning.service
 * `proposeTaskPlan`]: the in charge confirms the plan, or changes it. One open to-do a task.
 */
export async function askToConfirmPresses(task, models = []) {
  const { people } = await planners();
  const what = await about(task);
  const link = await workflowLink(task);
  for (const person of people) {
    await raiseTask({
      user: person._id,
      title: `Confirm the press plan — ${what}`,
      notes: `The planner proposed a press for ${models.join(', ') || 'the routed models'}. Confirm it, or change the press.`,
      priority: 'high',
      dueDate: new Date(),
      link,
      originKey: pressKey(task),
    });
  }
}

/** Nothing of the task waits on a proposal any more: its "Confirm the press plan" to-dos close. */
export const pressesConfirmed = (task) => resolveTasks(pressKey(task));

/** Who is told when Admin plans in the in charge's place: everyone in charge. */
export async function inChargeIds() {
  return (await productionInCharge()).map((person) => person._id);
}

/**
 * A model planned on a press whose start has come, with no run on it yet: the in charge is asked
 * to confirm it is running there — one tap on the task starts the run [productionStep.service].
 */
export const startKey = (wo) => `confirm-start:${wo._id}`;
export async function askToConfirmStart(task, wo, machineCode) {
  const { people } = await planners();
  const what = await about(task);
  const link = await workflowLink(task);
  for (const person of people) {
    await raiseTask({
      user: person._id,
      title: `Confirm production on ${machineCode} — ${wo.model || wo.modelNumber || what}`,
      notes: `${what}: planned on ${machineCode} from now. Confirm it is running (Production Started on the task), or move the plan.`,
      priority: 'high',
      dueDate: new Date(),
      link,
      originKey: startKey(wo),
    });
  }
}
export const startConfirmed = (wo) => resolveTasks(startKey(wo));
