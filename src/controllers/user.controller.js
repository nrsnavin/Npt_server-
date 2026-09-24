import { withOwnerLocks } from '../services/operationLock.service.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  accessCatalogue,
  moduleAccessFor,
  normaliseGrants,
} from '../services/access.service.js';
import { defaultAccessFor, findDepartment } from '../config/modules.js';
import { resolveIdentifier } from '../services/otp.service.js';
import { transferBook, workloadOf } from '../services/offboarding.service.js';
import { recordChange } from '../services/audit.service.js';
import { listParams } from '../utils/query.js';
import { sendWelcome } from '../services/passwordLink.service.js';

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  department: user.department,
  phone: user.phone,
  emailVerified: user.emailVerified,
  phoneVerified: user.phoneVerified,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt,
  lastLoginMethod: user.lastLoginMethod,
  createdAt: user.createdAt,
  moduleAccess: user.moduleAccess,
  modules: moduleAccessFor(user),
  /* Read off a document loaded with the hash selected; the hash itself never leaves here. */
  hasPassword: Boolean(user.password),
  /** Invited and not yet in: no password chosen and never signed in. */
  invitationPending: !user.password && !user.lastLoginAt,
});

/** The module and department catalogue an admin screen needs to build its form. */
export const catalogue = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: accessCatalogue() });
});

/**
 * What the people list will order by.
 *
 * `lastLoginAt` is the reason this screen needed a sort at all. Ascending — with the never-
 * signed-in at the end, which `chooseSort` leaves to Mongo and Mongo puts first for a null —
 * is the dormant-account list, and a dormant account holding module grants is the one piece of
 * housekeeping an access screen exists to make visible.
 *
 * `moduleAccess` is not sortable and could not usefully be: it is an array of grants, and the
 * column draws a summary of it. The department and role filters are how that question is
 * actually asked.
 *
 * `password` is not on the list, and the allow-list is why that sentence is worth writing: an
 * ordering is information about the field it orders by, and a hash ranked lexicographically
 * would leak its first characters a page at a time.
 */
const USER_SORTABLE = ['name', 'email', 'department', 'role', 'lastLoginAt', 'isActive', 'createdAt'];

export const list = asyncHandler(async (req, res) => {
  /*
   * On the shared plumbing rather than its own copy of it. This list hand-rolled paging, the
   * limit clamp and the regex escape — three things every other list in the app gets from
   * `listParams`, and three places for the copies to drift.
   */
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['name', 'email', 'phone'],
    defaultSort: 'name',
    sortable: USER_SORTABLE,
  });

  if (req.query.department) filter.department = req.query.department;
  if (req.query.role) filter.role = req.query.role;
  if (req.query.isActive === 'true' || req.query.isActive === 'false') {
    filter.isActive = req.query.isActive === 'true';
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('+password')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: users.map(publicUser),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

export const getOne = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: publicUser(user) });
});

/**
 * Creates an account. When no grants are supplied the department's defaults are applied,
 * so allocating someone to a team is enough to get them working; the admin can then
 * adjust. What is stored is always the resulting explicit grant list.
 */
export const create = asyncHandler(async (req, res) => {
  const { name, email, password, role, department, phone, moduleAccess } = req.body;

  if (await User.findOne({ email: email.toLowerCase() })) {
    throw ApiError.conflict('An account with this email already exists');
  }

  if (phone) {
    const { identifier } = resolveIdentifier(phone);
    if (await User.findOne({ phone: identifier })) {
      throw ApiError.conflict('An account with this phone number already exists');
    }
  }

  const grants = moduleAccess?.length
    ? normaliseGrants(moduleAccess)
    : defaultAccessFor(department);

  const user = await User.create({
    name,
    email,
    password,
    phone,
    department,
    role: role || 'member',
    // An admin's access is implicit, so storing grants for one would only mislead.
    moduleAccess: role === 'admin' ? [] : grants,
  });

  /*
   * The welcome email: what they have been given, and a link to choose their own password.
   * Sent whether or not a password was typed here — the email is also how they learn their
   * access. If it could not go, the link comes back so the administrator can pass it on.
   */
  const invitation = await sendWelcome(user, { by: req.user });

  res.status(201).json({ success: true, data: publicUser(user), invitation });
});

/**
 * Sending the welcome email again — it expired, went to spam, or the address was corrected.
 * A new link replaces the old one, so only the latest email works.
 */
export const resendInvitation = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');
  if (!user.isActive) throw ApiError.badRequest('This account is deactivated — reactivate it first');

  const invitation = await sendWelcome(user, { by: req.user });
  res.json({ success: true, data: publicUser(user), invitation });
});

export const update = asyncHandler(async (req, res) => withOwnerLocks([req.params.id, req.query.transferTo || req.body?.transferTo], async () => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  const { name, department, role, isActive, phone } = req.body;

  // An admin must not be able to lock every admin out of the system.
  if ((role && role !== 'admin') || isActive === false) {
    if (user.role === 'admin') {
      const otherAdmins = await User.countDocuments({
        _id: { $ne: user._id },
        role: 'admin',
        isActive: true,
      });
      if (otherAdmins === 0) {
        throw ApiError.badRequest('This is the last active admin — promote another first');
      }
    }
  }

  if (isActive === false && (await workloadOf(user._id)).open > 0) throw ApiError.badRequest('Use offboarding and choose a colleague to receive this person’s work.');
  if (name) user.name = name;
  if (department) user.department = department;
  if (role) user.role = role;
  if (isActive !== undefined) user.isActive = isActive;

  if (phone !== undefined) {
    const next = phone ? resolveIdentifier(phone).identifier : undefined;
    if (next !== user.phone) {
      if (next && (await User.findOne({ phone: next, _id: { $ne: user._id } }))) {
        throw ApiError.conflict('An account with this phone number already exists');
      }
      user.phone = next;
      user.phoneVerified = false;
    }
  }

  if (user.role === 'admin') user.moduleAccess = [];

  await user.save();
  res.json({ success: true, data: publicUser(user) });
}));

/** Replaces a user's grants wholesale, so the request is the complete intended state. */
export const setAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  if (user.role === 'admin') {
    throw ApiError.badRequest('Admins already have access to every module');
  }

  user.moduleAccess = normaliseGrants(req.body.moduleAccess);
  await user.save();

  res.json({ success: true, data: publicUser(user) });
});

/** Re-applies the department template, discarding any manual adjustments. */
export const resetAccessToDepartment = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  if (user.role === 'admin') {
    throw ApiError.badRequest('Admins already have access to every module');
  }
  if (!findDepartment(user.department)) {
    throw ApiError.badRequest('Allocate this user to a department first');
  }

  user.moduleAccess = defaultAccessFor(user.department);
  await user.save();

  res.json({ success: true, data: publicUser(user) });
});

/** What this person is holding, so an offboarding warning is a sentence with numbers in it. */
export const workload = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  res.json({ success: true, data: await workloadOf(user._id) });
});

/**
 * Offboards somebody: hands their book to a colleague and deactivates the account.
 *
 * Deliberately not a deletion. Ownership is what decides whose screen a live record appears
 * on, so an owner nobody can resolve makes that record vanish from every marketing view
 * without erroring — and eighteen fields across the models name a user as the person who did
 * something, which stays true after they leave. See `offboarding.service.js`.
 *
 * Somebody holding open work cannot be removed without saying where it goes. Anyone with
 * nothing open can be deactivated on the spot.
 */
export const remove = asyncHandler(async (req, res) => withOwnerLocks([req.params.id, req.query.transferTo || req.body?.transferTo], async () => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  if (String(user._id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot remove your own account');
  }
  if (user.role === 'admin') {
    const otherAdmins = await User.countDocuments({
      _id: { $ne: user._id },
      role: 'admin',
      isActive: true,
    });
    if (otherAdmins === 0) throw ApiError.badRequest('This is the last active admin');
  }

  const transferTo = req.query.transferTo || req.body?.transferTo;
  const held = await workloadOf(user._id);

  if (held.open > 0 && !transferTo) {
    throw ApiError.badRequest(
      `${user.name} still owns ${held.open} open ${held.open === 1 ? 'record' : 'records'}. ` +
        'Name a colleague to transfer them to, or the work stops appearing on anybody’s screen.'
    );
  }

  let moved = null;
  if (transferTo) {
    if (String(transferTo) === String(user._id)) {
      throw ApiError.badRequest('Transfer the work to somebody else');
    }

    const successor = await User.findById(transferTo);
    if (!successor) throw ApiError.badRequest('That colleague does not exist');
    if (successor.isActive === false) {
      throw ApiError.badRequest(`${successor.name} is not active, so the work would go nowhere`);
    }

    user.isActive = false;
    await user.save();
    moved = await transferBook(user._id, successor._id);

    // A whole book changing hands is the single largest ownership event the system has, and
    // the one somebody will ask about later.
    await recordChange({
      model: 'User',
      doc: user,
      by: req.user,
      action: 'transferred',
      label: user.name,
      note: `Book transferred to ${successor.name}: ${JSON.stringify(moved)}`,
    });
  }

  user.isActive = false;
  await user.save();

  res.json({ success: true, data: { ...publicUser(user), transferred: moved } });
}));
