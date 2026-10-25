import mongoose from 'mongoose';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { findHandoff } from '../config/handoffs.js';
import { inDepartment, isManagement } from '../utils/departments.js';

/**
 * The PDFs on department tasks, for the records those tasks are about [web: TaskPdfs] — so a PDF
 * attached to a Sample Request shows on the sample, one on a Create Quotation on the quotation,
 * one on the PO & SO on the sales order, one on the Production request on the production pages.
 * Two kinds: the PDF sent with the task (`attachment`: the buyer's PO, a drawing) and the PDF the
 * department finished it with (`resultFile`: the SO, the LR copy).
 *
 * Only what the person may open is listed — the same rule the file download keeps
 * [attachment.controller `downloadAttachment`]: Admin, the task's department, whoever it was for
 * or raised it, and the enquiry's marketing person.
 */

const ids = (list) => [...new Set((list || []).map(String))].filter((id) => mongoose.isValidObjectId(id));

const fileOf = (task, file, role) => {
  const handoff = findHandoff(task.kind);
  const label = handoff?.label || 'Task';
  return {
    key: file.key, filename: file.filename || null, size: file.size || null, mimeType: file.mimeType || null,
    role, kind: task.kind, task: String(task._id),
    title: role === 'result' ? (handoff?.form?.resultTitle || `${label} PDF`) : `${label} — attached`,
    at: file.createdAt || task.createdAt,
  };
};

/**
 * PDFs on the tasks of these enquiries (and/or these tasks), of these kinds: `{ byEnquiry, byTask }`,
 * each id to its files, newest first.
 */
export async function taskPdfs(user, { enquiries = [], tasks = [], kinds = [] } = {}) {
  const enquiryIds = ids(enquiries).slice(0, 200);
  const taskIds = ids(tasks).slice(0, 200);
  if (!enquiryIds.length && !taskIds.length) return { byEnquiry: {}, byTask: {} };
  const scope = [...(enquiryIds.length ? [{ enquiry: { $in: enquiryIds } }] : []), ...(taskIds.length ? [{ _id: { $in: taskIds } }] : [])];
  const found = await Todo.find({
    $and: [{ $or: scope }, { $or: [{ attachment: { $exists: true, $ne: null } }, { resultFile: { $exists: true, $ne: null } }] }],
    ...(kinds.length ? { kind: { $in: kinds } } : {}),
  })
    .select('kind title department user createdBy enquiry attachment resultFile createdAt')
    .populate([{ path: 'attachment', select: 'key filename size mimeType createdAt' }, { path: 'resultFile', select: 'key filename size mimeType createdAt' }])
    .sort({ createdAt: -1 })
    .lean();
  const me = String(user._id);
  const owners = new Map((await Enquiry.find({ _id: { $in: [...new Set(found.map((task) => String(task.enquiry || '')).filter(Boolean))] } }).select('assignedTo').lean())
    .map((enquiry) => [String(enquiry._id), String(enquiry.assignedTo || '')]));
  const mayRead = (task) => isManagement(user) || inDepartment(user, task.department)
    || [task.user, task.createdBy].some((id) => id && String(id) === me)
    || (task.enquiry && owners.get(String(task.enquiry)) === me);
  const byEnquiry = {};
  const byTask = {};
  for (const task of found.filter(mayRead)) {
    const files = [
      ...(task.attachment?.key ? [fileOf(task, task.attachment, 'sent')] : []),
      ...(task.resultFile?.key ? [fileOf(task, task.resultFile, 'result')] : []),
    ];
    if (!files.length) continue;
    byTask[String(task._id)] = files;
    if (task.enquiry) (byEnquiry[String(task.enquiry)] ||= []).push(...files);
  }
  return { byEnquiry, byTask };
}
