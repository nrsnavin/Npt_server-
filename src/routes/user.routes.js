import { Router } from 'express';
import User from '../models/User.js';
import crudController from '../controllers/crud.factory.js';
import { authenticate, authorize } from '../middleware/auth.js';

const users = crudController(User, {
  searchFields: ['name', 'email'],
  defaultSort: 'name',
});

const router = Router();

router.use(authenticate);
router.get('/', users.list);
router.post('/', authorize('admin'), users.create);
router.get('/:id', users.getOne);
router.patch('/:id', authorize('admin'), users.update);
router.delete('/:id', authorize('admin'), users.remove);

export default router;
