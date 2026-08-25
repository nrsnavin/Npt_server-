import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { signToken } from '../middleware/auth.js';
import { issueOtp, resolveIdentifier, verifyOtp } from '../services/otp.service.js';
import { env } from '../config/env.js';
import { maskIdentifier } from '../utils/phone.js';
import { featuresForRole } from '../config/features.js';

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  department: user.department,
  phone: user.phone,
  emailVerified: user.emailVerified,
  phoneVerified: user.phoneVerified,
  hasPassword: Boolean(user.password) || user.hasPassword?.() || false,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt,
  lastLoginMethod: user.lastLoginMethod,
  createdAt: user.createdAt,
});

/** Records the sign-in and returns the standard auth payload. */
async function completeSignIn(user, method) {
  user.lastLoginAt = new Date();
  user.lastLoginMethod = method;
  await user.save({ validateBeforeSave: false });

  return { user: publicUser(user), token: signToken(user) };
}

export const register = asyncHandler(async (req, res) => {
  const { name, email, password, role, phone, department } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  if (phone) {
    const { identifier } = resolveIdentifier(phone);
    if (await User.findOne({ phone: identifier })) {
      throw ApiError.conflict('An account with this phone number already exists');
    }
  }

  // The very first account bootstraps the system as an admin.
  const isFirstUser = (await User.estimatedDocumentCount()) === 0;
  const user = await User.create({
    name,
    email,
    password,
    phone,
    department,
    role: isFirstUser ? 'admin' : role || 'viewer',
  });

  res.status(201).json({ success: true, data: { user: publicUser(user), token: signToken(user) } });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  res.json({ success: true, data: await completeSignIn(user, 'password') });
});

/**
 * Step one of OTP sign-in: send a code to an email address or phone number.
 * The response is identical whether or not an account exists, so this endpoint
 * cannot be used to discover who is registered.
 */
export const requestLoginOtp = asyncHandler(async (req, res) => {
  const { identifier, channel, field } = resolveIdentifier(req.body.identifier);

  const user = await User.findOne({ [field]: identifier });
  const respond = (extra = {}) =>
    res.json({
      success: true,
      message: `If an account exists for ${maskIdentifier(identifier)}, a code is on its way.`,
      data: {
        identifier,
        maskedIdentifier: maskIdentifier(identifier),
        channel,
        expiresInMinutes: env.otp.ttlMinutes,
        ...extra,
      },
    });

  // Silently skip delivery for unknown or deactivated accounts.
  if (!user || !user.isActive) return respond();

  const issued = await issueOtp({
    identifier,
    channel,
    purpose: 'login',
    user,
    requestIp: req.ip,
  });

  return respond({ expiresAt: issued.expiresAt, ...(issued.devCode ? { devCode: issued.devCode } : {}) });
});

/** Step two of OTP sign-in: exchange a valid code for a token. */
export const verifyLoginOtp = asyncHandler(async (req, res) => {
  const { identifier, field } = resolveIdentifier(req.body.identifier);

  await verifyOtp({ identifier, code: req.body.code, purpose: 'login' });

  const user = await User.findOne({ [field]: identifier });
  if (!user || !user.isActive) {
    throw ApiError.unauthorized('This account is no longer active');
  }

  // Redeeming a code proves control of that address or number.
  if (field === 'email') user.emailVerified = true;
  else user.phoneVerified = true;

  res.json({
    success: true,
    data: await completeSignIn(user, field === 'email' ? 'email_otp' : 'sms_otp'),
  });
});

export const me = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { ...publicUser(req.user), features: featuresForRole(req.user.role) },
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone, department } = req.body;
  const user = await User.findById(req.user._id);

  if (name) user.name = name;
  if (department) user.department = department;

  if (phone !== undefined) {
    const next = phone ? resolveIdentifier(phone).identifier : undefined;
    if (next !== user.phone) {
      if (next && (await User.findOne({ phone: next, _id: { $ne: user._id } }))) {
        throw ApiError.conflict('An account with this phone number already exists');
      }
      user.phone = next;
      // A new number has not been proven yet.
      user.phoneVerified = false;
    }
  }

  await user.save();
  res.json({
    success: true,
    data: { ...publicUser(user), features: featuresForRole(user.role) },
  });
});

/** Sends a code to the signed-in user's own email or phone to verify it. */
export const requestVerificationOtp = asyncHandler(async (req, res) => {
  const target = req.body.target === 'phone' ? 'phone' : 'email';

  if (target === 'phone' && !req.user.phone) {
    throw ApiError.badRequest('Add a phone number to your profile first');
  }

  const { identifier, channel } = resolveIdentifier(req.user[target]);
  const issued = await issueOtp({
    identifier,
    channel,
    purpose: target === 'email' ? 'verify_email' : 'verify_phone',
    user: req.user,
    requestIp: req.ip,
  });

  res.json({
    success: true,
    message: `Code sent to ${maskIdentifier(identifier)}`,
    data: {
      maskedIdentifier: maskIdentifier(identifier),
      channel,
      expiresAt: issued.expiresAt,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    },
  });
});

/** Confirms a verification code for the signed-in user's email or phone. */
export const confirmVerificationOtp = asyncHandler(async (req, res) => {
  const target = req.body.target === 'phone' ? 'phone' : 'email';
  const { identifier } = resolveIdentifier(req.user[target]);

  await verifyOtp({
    identifier,
    code: req.body.code,
    purpose: target === 'email' ? 'verify_email' : 'verify_phone',
  });

  const user = await User.findById(req.user._id);
  if (target === 'email') user.emailVerified = true;
  else user.phoneVerified = true;
  await user.save({ validateBeforeSave: false });

  res.json({ success: true, data: publicUser(user) });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password');

  // An OTP-only account can set its first password without proving an old one.
  if (user.hasPassword()) {
    if (!currentPassword) throw ApiError.badRequest('Current password is required');
    if (!(await user.comparePassword(currentPassword))) {
      throw ApiError.badRequest('Current password is incorrect');
    }
  }

  user.password = newPassword;
  await user.save();

  res.json({ success: true, message: 'Password updated' });
});
