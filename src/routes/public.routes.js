import { Router } from 'express';
import { publicQuotationPdf } from '../controllers/quotation.controller.js';
import { publicTaskFile } from '../controllers/handoff.controller.js';
import { publicEnquiryDocument } from '../controllers/enquiryMessage.controller.js';
import { publicSamplePhoto } from '../controllers/sampleLog.controller.js';

/**
 * Documents behind signed, expiring links — what WhatsApp fetches, and what a buyer opens from
 * a message. No session: the signature is the permission [utils/signedLink.js].
 *
 * Mounted twice [app.js]: under `/api/public`, where every link made since the fix points, and
 * at `/public`, for the links already sent by a server whose PUBLIC_API_URL stopped at the host —
 * those answered "Route not found" and the buyer saw an error instead of the quotation.
 */
const router = Router();

/* A sent quotation's PDF. */
router.get('/quotations/:id/:expires/:signature/:file', publicQuotationPdf);
/* A department task's uploaded work (the LR copy). */
router.get('/files/:id/:expires/:signature/:file', publicTaskFile);
/* An enquiry's paper sent on WhatsApp [services/enquiryDocuments.service.js]. */
router.get('/documents/:id/:expires/:signature/:file', publicEnquiryDocument);
/* A sample's finished-piece photo, sent with the ready and dispatch notices [customerMessage.service]. */
router.get('/sample-photos/:id/:expires/:signature/:file', publicSamplePhoto);

export default router;
