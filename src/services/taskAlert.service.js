import User from '../models/User.js';
import { findHandoff } from '../config/handoffs.js';
import { deskMates, findDepartment } from '../config/modules.js';
import { env } from '../config/env.js';
import { sendPush } from './push.service.js';
import { sendEmailToStaff, staffEmailOn } from './notification.service.js';

/**
 * A new task rings the team it is for, the moment it is raised [models/Todo.js post-save].
 *
 * Every member of the department — their main department or an extra one, and the desk-mates
 * who work that queue [config/modules.js DESK_GROUPS] — gets a push on every device they have
 * allowed [push.service.js] and an email, plus whoever the task was handed to by name. Not the
 * person who raised it: they know. Sent after the transaction commits, so a task that is rolled
 * back rings nobody, and never awaited by the request that raised the task.
 *
 * Without SMTP the emails are not written out one by one (a plant of twenty would drown the
 * log): one line says who would have been told.
 */

/** The last alerts sent, newest last — read by the tests, and by nobody else. */
export const recentAlerts = [];
const KEEP = 50;

/** Everyone who works the department's queue. */
export async function membersOf(department) {
  const mates = deskMates(department);
  const keys = mates.length ? mates : [department];
  return User.find({
    isActive: { $ne: false },
    $or: [{ department: { $in: keys } }, { extraDepartments: { $in: keys } }],
  }).select('name email department').lean();
}

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Tells the team about a task just raised for it. Never throws. */
export async function alertNewTask(task) {
  try {
    if (!task?.department || task.completed) return null;
    const handoff = findHandoff(task.kind);
    if (!handoff) return null;
    const team = findDepartment(task.department)?.label || task.department;
    const raiser = String(task.createdBy || '');
    const people = await membersOf(task.department);
    if (task.user && !people.some((person) => String(person._id) === String(task.user))) {
      const named = await User.findById(task.user).select('name email department').lean();
      if (named) people.push(named);
    }
    const told = people.filter((person) => String(person._id) !== raiser);
    if (!told.length) return null;

    const by = task.system ? null : await User.findById(task.createdBy).select('name').lean();
    const link = task.link || '/departments/mine';
    const title = `New task for ${team}: ${handoff.label}`;
    const what = `${task.title}${task.notes ? ` — ${task.notes}` : ''}`;
    const body = `${what.slice(0, 160)}${by?.name ? ` · raised by ${by.name}` : ''}${task.priority === 'high' ? ' · HIGH priority' : ''}`;
    const alert = { task: String(task._id), department: task.department, title, body, link, to: told.map((person) => String(person._id)) };
    recentAlerts.push(alert);
    if (recentAlerts.length > KEEP) recentAlerts.splice(0, recentAlerts.length - KEEP);

    await sendPush(alert.to, { title, body, link, kind: 'task', taskId: String(task._id) });

    const withEmail = told.filter((person) => person.email);
    /* Staff email off, or no mail server: the push and the task on their list are how it reaches them. */
    if (!staffEmailOn() || !env.smtp.host) {
      if (withEmail.length) console.log(`[task-alert] ${title} — ${staffEmailOn() ? 'would email' : 'staff email is off, not emailing'} ${withEmail.map((person) => person.name).join(', ')}`);
      return alert;
    }
    const url = `${env.appUrl}${link}`;
    await Promise.all(withEmail.map((person) => sendEmailToStaff({
      to: person.email,
      subject: `${task.priority === 'high' ? 'HIGH: ' : ''}${title}`,
      text: `${task.title}\n\n${task.notes || ''}\n\n${by?.name ? `Raised by ${by.name}. ` : ''}${task.dueDate ? `Due ${new Date(task.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}. ` : ''}\nOpen it: ${url}`,
      html: `<p><strong>${escapeHtml(title)}</strong></p>`
        + `<p>${escapeHtml(task.title)}</p>`
        + (task.notes ? `<blockquote style="border-left:3px solid #ccc;margin:8px 0;padding:4px 10px;color:#333">${escapeHtml(task.notes)}</blockquote>` : '')
        + `<p style="color:#475569">${by?.name ? `Raised by ${escapeHtml(by.name)}. ` : ''}${task.dueDate ? `Due ${escapeHtml(new Date(task.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }))}.` : ''}</p>`
        + `<p><a href="${escapeHtml(url)}">Open the task</a></p>`,
    }).catch((error) => console.error(`[task-alert] email to ${person.email} not sent: ${error.message}`))));
    return alert;
  } catch (error) {
    console.error(`[task-alert] not sent: ${error.message}`);
    return null;
  }
}
