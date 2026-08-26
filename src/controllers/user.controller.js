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
});

/** The module and department catalogue an admin screen needs to build its form. */
export const catalogue = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: accessCatalogue() });
});

export const list = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);

  const filter = {};
  if (req.query.department) filter.department = req.query.department;
  if (req.query.role) filter.role = req.query.role;
  if (req.query.isActive === 'true' || req.query.isActive === 'false') {
    filter.isActive = req.query.isActive === 'true';
  }
  if (req.query.search) {
    const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filter.$or = [{ name: regex }, { email: regex }, { phone: regex }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort('name')
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
  const user = await User.findById(req.params.id);
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

  res.status(201).json({ success: true, data: publicUser(user) });
});

export const update = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
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
});

/** Replaces a user's grants wholesale, so the request is the complete intended state. */
export const setAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
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
  const user = await User.findById(req.params.id);
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

export const remove = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  if (String(user._id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot delete your own account');
  }
  if (user.role === 'admin') {
    const otherAdmins = await User.countDocuments({
      _id: { $ne: user._id },
      role: 'admin',
      isActive: true,
    });
    if (otherAdmins === 0) throw ApiError.badRequest('This is the last active admin');
  }

  await User.deleteOne({ _id: user._id });
  res.json({ success: true, data: { id: user._id } });
});
