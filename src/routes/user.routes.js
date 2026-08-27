import { Router } from 'express';
import {
  catalogue,
  list,
  getOne,
  create,
  update,
  setAccess,
  resetAccessToDepartment,
  remove,
  workload,
} from '../controllers/user.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createUserSchema,
  updateUserSchema,
  setAccessSchema,
} from '../validators/schemas.js';

const router = Router();

router.use(authenticate);

// Reading the catalogue needs read on the users module; changing anyone needs write.
router.get('/catalogue', requireModule('users'), catalogue);
router.get('/', requireModule('users'), list);
router.post('/', requireModule('users', 'write'), validate(createUserSchema), create);
router.get('/:id', requireModule('users'), getOne);
router.patch('/:id', requireModule('users', 'write'), validate(updateUserSchema), update);
router.put('/:id/access', requireModule('users', 'write'), validate(setAccessSchema), setAccess);
router.post('/:id/access/reset', requireModule('users', 'write'), resetAccessToDepartment);
router.get('/:id/workload', requireModule('users'), workload);
router.delete('/:id', requireModule('users', 'write'), remove);

export default router;
