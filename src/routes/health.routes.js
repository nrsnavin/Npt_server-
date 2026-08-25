import { Router } from 'express';
import { live, ready } from '../controllers/health.controller.js';

const router = Router();

// Unauthenticated on purpose: load balancers and orchestrators cannot present a token.
router.get('/', live);
router.get('/live', live);
router.get('/ready', ready);

export default router;
