import { z } from 'zod';
import { objectId } from './schemas.js';
import { enquiryCore } from './pipeline.schemas.js';
import { THREAD_STATUSES } from '../models/WhatsappThread.js';

/**
 * What a person may change about a conversation, and what they may not.
 *
 * Everything the *integration* decides is absent: the number, the messages, the match, the
 * counts. Those are facts about what arrived, and a field somebody can type over is a fact that
 * stops being one. What is here is the judgement — who works it, which queue it sits in, and
 * which record it actually belongs to.
 */
export const threadUpdateSchema = z
  .object({
    assignedTo: objectId,
    status: z.enum(THREAD_STATUSES),
    notes: z.string().max(2000),
    customer: objectId,
    lead: objectId,
  })
  .partial();

/**
 * Converting a conversation into an enquiry [§41.4].
 *
 * Built from the enquiry module's own field list rather than a copy of it, so a field added to
 * an enquiry tomorrow can be supplied here without anybody remembering this file exists — the
 * whole promise of §41.4 is that converting does not mean re-entering, and a schema that
 * drifted behind the enquiry's would quietly start dropping what somebody typed.
 *
 * Four fields are deliberately *not* accepted. The customer, the owner, the source and the
 * conversation reference all come off the thread, and taking them from the request would let a
 * caller raise a `whatsapp` enquiry against somebody else's customer through a route whose
 * whole justification is that it already knows whose conversation this is.
 */
const { source, conversation, ...fromTheBuyer } = enquiryCore;

export const threadEnquirySchema = z.object(fromTheBuyer);
