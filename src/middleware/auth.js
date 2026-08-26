import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { accessLevel } from '../services/access.service.js';
import { findModule, levelSatisfies } from '../config/modules.js';

export const signToken = (user) =>
  jwt.sign({ sub: user._id.toString(), role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Authentication token missing');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw ApiError.unauthorized('Account is no longer active');

  req.user = user;
  return next();
});

/**
 * Gates a route on a module grant. `requireModule('orders')` needs read; passing
 * 'write' needs write. Admins pass everything.
 *
 * Every module route must use this — it is the only thing standing between a grant and
 * the data, and it is the same function the profile screen reports from, so what a user
 * is shown always matches what the API allows.
 */
export const requireModule =
  (moduleKey, required = 'read') =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!findModule(moduleKey)) {
      return next(new ApiError(500, `Unknown module: ${moduleKey}`));
    }

    const held = accessLevel(req.user, moduleKey);
    if (levelSatisfies(held, required)) return next();

    const label = findModule(moduleKey).label;
    return next(
      ApiError.forbidden(
        held
          ? `You have read-only access to ${label}.`
          : `You do not have access to ${label}.`
      )
    );
  };

/** Restricts a route to the listed roles; admin always passes. */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'admin' || roles.length === 0 || roles.includes(req.user.role)) {
      return next();
    }
    return next(ApiError.forbidden(`Requires one of the roles: ${roles.join(', ')}`));
  };
