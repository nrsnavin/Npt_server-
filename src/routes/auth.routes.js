import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  register,
  login,
  me,
  updateProfile,
  changePassword,
  requestLoginOtp,
  verifyLoginOtp,
  requestVerificationOtp,
  confirmVerificationOtp,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  requestOtpSchema,
  verifyOtpSchema,
  requestVerificationSchema,
  confirmVerificationSchema,
} from '../validators/schemas.js';

const router = Router();

/**
 * Sending a code costs money and can be used to spam someone else's inbox, so
 * requests are capped per IP on top of the per-identifier limits in the OTP service.
 */
const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many code requests from this device. Try again later.' },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many verification attempts. Try again later.' },
});

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);

router.post('/otp/request', otpRequestLimiter, validate(requestOtpSchema), requestLoginOtp);
router.post('/otp/verify', otpVerifyLimiter, validate(verifyOtpSchema), verifyLoginOtp);

router.get('/me', authenticate, me);
router.patch('/me', authenticate, updateProfile);
router.post('/change-password', authenticate, validate(changePasswordSchema), changePassword);

router.post(
  '/verify/request',
  authenticate,
  otpRequestLimiter,
  validate(requestVerificationSchema),
  requestVerificationOtp
);
router.post(
  '/verify/confirm',
  authenticate,
  otpVerifyLimiter,
  validate(confirmVerificationSchema),
  confirmVerificationOtp
);

export default router;
