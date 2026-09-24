import crypto from 'node:crypto';
import PasswordToken from '../models/PasswordToken.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { company } from '../config/company.js';
import { findDepartment } from '../config/modules.js';
import { moduleAccessFor } from './access.service.js';
import { sendEmail } from './notification.service.js';

/**
 * Password links: how a new person gets in, and how a forgotten password is replaced.
 *
 * There is no public sign-up. An administrator creates the account and the person receives a
 * welcome email saying what they have been given — department, role, each module and whether
 * they may change it or only read it — with a link to choose their own password. Nobody types a
 * temporary password for them, reads it out, or leaves it on a sticky note.
 *
 * A forgotten password works the same way: a link to the address on the account, valid for an
 * hour, good once. Setting a password through either ends every earlier session.
 */

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

const lifetimeMs = (purpose) =>
  purpose === 'invite'
    ? env.passwordLinks.inviteHours * 60 * 60 * 1000
    : env.passwordLinks.resetMinutes * 60 * 1000;

export const linkFor = (token) => `${env.appUrl}/reset-password?token=${token}`;

/**
 * A fresh link, replacing any unused one of the same kind. Only the newest link works, so an
 * old email found later in somebody's inbox is a dead link rather than a live one.
 */
export async function issueLink(user, purpose, { by } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await PasswordToken.deleteMany({ user: user._id, purpose, usedAt: { $exists: false } });
  const row = await PasswordToken.create({
    user: user._id,
    tokenHash: hash(token),
    purpose,
    expiresAt: new Date(Date.now() + lifetimeMs(purpose)),
    issuedBy: by?._id,
  });
  return { token, url: linkFor(token), expiresAt: row.expiresAt };
}

/** The live row behind a token, or nothing. Does not use it up. */
async function liveRow(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  return PasswordToken.findOne({
    tokenHash: hash(token),
    usedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });
}

const DEAD_LINK = 'This link has expired or has already been used. Ask for a new one.';

/** What the set-password page needs to greet the person, without using the link up. */
export async function inspectLink(token) {
  const row = await liveRow(token);
  const user = row && (await User.findById(row.user));
  if (!row || !user || !user.isActive) throw ApiError.badRequest(DEAD_LINK);
  return { purpose: row.purpose, name: user.name, email: user.email, expiresAt: row.expiresAt };
}

/**
 * Sets the password and spends the link, in that order of claim: the link is marked used by
 * the same update that finds it, so a double press cannot set two passwords.
 */
export async function redeemLink(token, password) {
  if (typeof token !== 'string' || token.length < 20) throw ApiError.badRequest(DEAD_LINK);
  const row = await PasswordToken.findOneAndUpdate(
    { tokenHash: hash(token), usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  if (!row) throw ApiError.badRequest(DEAD_LINK);

  const user = await User.findById(row.user).select('+password');
  if (!user || !user.isActive) throw ApiError.badRequest(DEAD_LINK);

  user.password = password;
  /* The link arrived at this address and was opened, which is what verifying it means. */
  user.emailVerified = true;
  await user.save();

  /* Any other outstanding link for this person is now moot. */
  await PasswordToken.deleteMany({ user: user._id, usedAt: { $exists: false } });
  return user;
}

/* ------------------------------ The emails ------------------------------ */

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const whenItEnds = (date) =>
  date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** What the person was given, in the words the Profile screen uses. */
function accessLines(user) {
  if (user.role === 'admin') return [['Every module', 'Read & write (administrator)']];
  return moduleAccessFor(user)
    .filter((module) => module.canRead)
    .map((module) => [module.label, module.canWrite ? 'Read & write' : module.canQuote ? 'Quote' : 'Read only']);
}

function layout({ heading, intro, rows, button, url, footer }) {
  const table = rows?.length
    ? `<table style="border-collapse:collapse;margin:16px 0;font-size:14px">${rows
        .map(
          ([label, value]) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#555">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(value)}</td></tr>`
        )
        .join('')}</table>`
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#1d1d1f;line-height:1.5">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
${intro.map((line) => `<p style="margin:0 0 10px">${escapeHtml(line)}</p>`).join('')}
${table}
<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:#c2410c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(button)}</a></p>
<p style="font-size:12px;color:#666;margin:0 0 6px">Or paste this address into your browser:<br>${escapeHtml(url)}</p>
<p style="font-size:12px;color:#666;margin:12px 0 0">${escapeHtml(footer)}</p>
</div>`;
}

const textOf = ({ intro, rows, url, footer }) =>
  [...intro, '', ...(rows || []).map(([label, value]) => `  ${label}: ${value}`), '', url, '', footer].join('\n');

/**
 * The welcome invitation. Returns whether it was delivered and, when it was not, the link — so
 * the administrator who created the account can pass it on by hand rather than leave the new
 * person with no way in. The link is never returned when the email went.
 */
export async function sendWelcome(user, { by } = {}) {
  const link = await issueLink(user, 'invite', { by });
  const department = findDepartment(user.department)?.label || user.department || 'Not set yet';
  const content = {
    heading: `Welcome to ${company.name}`,
    intro: [
      `Hello ${user.name},`,
      `${by?.name || 'An administrator'} has created your account on the ${company.name} system. ` +
        'Your sign-in is this email address. Choose your password with the button below.',
    ],
    rows: [
      ['Sign-in email', user.email],
      ['Department', department],
      ['Role', user.role === 'admin' ? 'Administrator' : 'Member'],
      ...accessLines(user),
    ],
    button: 'Set your password',
    url: link.url,
    footer:
      `This link works once and expires on ${whenItEnds(link.expiresAt)}. ` +
      'If it has expired, use "Forgot password" on the sign-in page, or ask your administrator to resend it.',
  };

  return deliver(user, `Your ${company.name} account is ready`, content, link);
}

export async function sendReset(user) {
  const link = await issueLink(user, 'reset');
  const content = {
    heading: 'Reset your password',
    intro: [
      `Hello ${user.name},`,
      `Somebody asked to reset the password for your ${company.name} account. If that was you, choose a new one below. ` +
        'Doing so signs you out on every other device.',
    ],
    button: 'Choose a new password',
    url: link.url,
    footer:
      `This link works once and expires on ${whenItEnds(link.expiresAt)}. ` +
      'If you did not ask for it, ignore this email — your password stays as it is.',
  };
  return deliver(user, `Reset your ${company.name} password`, content, link);
}

async function deliver(user, subject, content, link) {
  try {
    const sent = await sendEmail({ to: user.email, subject, text: textOf(content), html: layout(content) });
    return sent.delivered
      ? { delivered: true, expiresAt: link.expiresAt }
      : { delivered: false, expiresAt: link.expiresAt, link: link.url };
  } catch (error) {
    console.error(`[password-link] ${subject} to ${user.email} not sent: ${error.message}`);
    return { delivered: false, expiresAt: link.expiresAt, link: link.url };
  }
}
