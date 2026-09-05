import { Router } from 'express';
import {
  listOrders, orderBoard, getOrder, exportOrders,
  createOrder, orderFromQuotation, updateOrder,
  setOrderCheck, applyOrderAction, listOrderActions, setOrderPo,
} from '../controllers/order.controller.js';
import {
  listOrderQueries, listQueryQueue, raiseOrderQuery, answerOrderQuery, closeOrderQuery,
} from '../controllers/orderQuery.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { singleDocument } from '../middleware/upload.js';
import {
  orderSchema, orderUpdateSchema, orderFromQuotationSchema,
  orderCheckSchema, orderActionSchema,
  orderQuerySchema, orderAnswerSchema, orderQueryCloseSchema,
} from '../validators/order.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Sales orders [§12–13].
 *
 * On the `orders` grant throughout, which order confirmation holds at write and marketing,
 * production, despatch and accounts hold at read. That split is the module doing its job: the
 * people who verify an order are not the people who sold it, and §13's whole purpose is that
 * the second check is made by somebody other than the person in a hurry to ship.
 *
 * Record ownership then narrows what a *marketing* reader sees to their own [§29], and that is
 * applied inside the controller because it varies by department — see ownership.service.js.
 */

/* Above `/:id` so the literal segments win; both on the read grant, because a board and an
   export are both ways of reading a list. */
router.get('/orders/export', requireModule('orders'), exportOrders);
router.get('/orders/board', requireModule('orders'), orderBoard);

/*
 * The query queue: what is being asked of a department, across every order. Above `/orders`
 * only for tidiness — it is its own path — but above `/orders/:id` for the usual reason.
 */
router.get('/order-queries', requireModule('orders'), listQueryQueue);

router.get('/orders', requireModule('orders'), listOrders);
router.post('/orders', requireModule('orders', 'write'), validate(orderSchema), createOrder);
router.get('/orders/:id', requireModule('orders'), getOrder);
router.patch('/orders/:id', requireModule('orders', 'write'), validate(orderUpdateSchema), updateOrder);

/*
 * The customer's own paperwork. A document rather than an image: a PO arrives as a PDF far
 * more often than as a photo, though both go through the same door.
 */
router.put('/orders/:id/po', requireModule('orders', 'write'), singleDocument('file'), setOrderPo);

/*
 * The §13 checklist, and the actions the order can take.
 *
 * Reading the list of either is a read; ticking a check or taking an action is a write. The
 * gate itself lives in the controller, not here — it is a rule about the record's state, and a
 * route can only ever know about the caller.
 */
router.post('/orders/:id/checks', requireModule('orders', 'write'), validate(orderCheckSchema), setOrderCheck);
router.get('/orders/:id/actions', requireModule('orders'), listOrderActions);
router.post('/orders/:id/actions', requireModule('orders', 'write'), validate(orderActionSchema), applyOrderAction);

/*
 * Questions about an order [§25 for the clock].
 *
 * All on the *read* grant, and that is deliberate rather than lax. Raising a query writes a
 * query, not the order — and marketing, the department this feature exists for, holds orders at
 * read. Gating it on write would leave the asking to order confirmation, who are not the people
 * with questions. Nothing on these routes changes an order, and the order's own ownership check
 * runs inside every one of them: a question about an order you may not open is refused the same
 * way the order is.
 *
 * Closing is restricted in the controller instead, because the rule is about *who asked* rather
 * than about which grant they hold — and a route cannot know that.
 */
router.get('/orders/:id/queries', requireModule('orders'), listOrderQueries);
router.post('/orders/:id/queries', requireModule('orders'), validate(orderQuerySchema), raiseOrderQuery);
router.post('/orders/:id/queries/:queryId/answers', requireModule('orders'), validate(orderAnswerSchema), answerOrderQuery);
router.post('/orders/:id/queries/:queryId/close', requireModule('orders'), validate(orderQueryCloseSchema), closeOrderQuery);

/*
 * An accepted quotation becoming an order.
 *
 * Both grants, because it reads one module and writes another — and the quotations half is a
 * read: raising the order does not change the quote. Marketing holds quotations at write and
 * orders at read, so in practice this is order confirmation's door, which is the right answer:
 * the person who sold it is not the person who books it.
 */
router.post(
  '/quotations/:id/order',
  requireModule('quotations'),
  requireModule('orders', 'write'),
  validate(orderFromQuotationSchema),
  orderFromQuotation
);

export default router;
