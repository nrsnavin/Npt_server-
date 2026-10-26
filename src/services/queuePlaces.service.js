import Todo from '../models/Todo.js';

/**
 * Where each job stands in the plant's queues — Production's, Printing's and Assembly's — as each
 * queue orders itself [productionQueue.controller, finishingQueue.controller]: by the date it is
 * worked to (marketing's EDD, else the team's own date), soonest first and none last, then by
 * when the task falls due. Counted over the whole queue, whoever is reading: marketing sees its
 * buyer's job is 7th of 23, not 1st of the two it may open.
 *
 *   byTask       task id → { queue, place, of }
 *   byEnquiry    enquiry (or team job) id → the places of its open queue tasks
 */

export const QUEUES = [
  { kind: 'ask_edd', queue: 'Production', path: '/production/queue' },
  { kind: 'ask_printing', queue: 'Printing', path: '/production/queue/printing' },
  { kind: 'ask_assembling_edd', queue: 'Assembly', path: '/production/queue/assembling' },
];

const dateOf = (task) => task.enquiry?.edd?.date || task.jobEdd?.date
  || (task.modelDates || []).map((entry) => entry.date).filter(Boolean).sort().at(-1) || null;

export async function queuePlaces() {
  const tasks = await Todo.find({ kind: { $in: QUEUES.map((entry) => entry.kind) }, completed: false })
    .select('kind enquiry chain jobEdd modelDates dueDate createdAt').populate('enquiry', 'edd').lean();
  const byTask = new Map();
  const byEnquiry = new Map();
  for (const { kind, queue, path } of QUEUES) {
    const rows = tasks.filter((task) => task.kind === kind).sort((a, b) => {
      const [da, db] = [dateOf(a), dateOf(b)];
      if (da !== db) return !da ? 1 : !db ? -1 : da.localeCompare(db);
      return (new Date(a.dueDate || a.createdAt || 0) - new Date(b.dueDate || b.createdAt || 0));
    });
    rows.forEach((task, at) => {
      const place = { queue, place: at + 1, of: rows.length, path, task: task._id };
      byTask.set(String(task._id), place);
      const job = String(task.enquiry?._id || task.chain || task._id);
      byEnquiry.set(job, [...(byEnquiry.get(job) || []), place]);
    });
  }
  return { byTask, byEnquiry };
}

/** For the screens: the maps as plain objects. */
export async function queuePlacesOut() {
  const { byTask, byEnquiry } = await queuePlaces();
  return { tasks: Object.fromEntries(byTask), enquiries: Object.fromEntries(byEnquiry) };
}
