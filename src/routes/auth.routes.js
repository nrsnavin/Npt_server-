import { Router } from 'express';
import {
  register,
  login,
  me,
  updateProfile,
  changePassword,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { registerSchema, loginSchema, changePasswordSchema } from '../validators/schemas.js';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.get('/me', authenticate, me);
router.patch('/me', authenticate, updateProfile);
router.post('/change-password', authenticate, validate(changePasswordSchema), changePassword);

export default router;
