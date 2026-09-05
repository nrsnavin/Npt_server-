import { z } from 'zod';
import { DISPATCH_ACTION_KEYS } from '../services/dispatchActions.js';
import { objectId } from './schemas.js';
import { versioned } from './pipeline.schemas.js';

/**
 * What a consignment accepts [BLUEPRINT §18–19].
 *
 * The shape worth noticing is the line: it carries an **order line id and a quantity**, and
 * nothing else that describes the goods. The model, the tool and the colour are copied off the
 * order in the controller rather than accepted here, because a delivery note that described the
 * goods differently from the order it ships against is a dispute waiting for a buyer to find
 * it — and the way that happens is a screen sending its own idea of what is on the line.
 */

const pieces = z.number().int().positive('A dispatch line is for at least one piece');

const dispatchLine = z.object({
  orderLine: objectId,
  quantity: pieces,
  /** Cartons, when despatch counts them. Nothing derives from it; it goes on the delivery note. */
  cartons: z.number().int().nonnegative().optional(),
  remarks: z.string().max(500).optional(),
});

const destination = z.object({
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
  pincode: z.string().max(12).optional(),
  contactName: z.string().max(120).optional(),
  contactMobile: z.string().max(40).optional(),
});

const invoice = z.object({
  number: z.string().max(60).optional(),
  date: z.coerce.date().optional(),
  /** Redacted on the way out from anyone who may not see what the order is worth [§8 by extension]. */
  value: z.number().nonnegative().optional(),
});

/** The paperwork, shared by creation and correction: all of it arrives at different moments. */
const paperwork = {
  destination: destination.optional(),
  ownVehicle: z.boolean().optional(),
  transporter: z.string().max(200).optional(),
  vehicleNumber: z.string().max(40).optional(),
  invoice: invoice.optional(),
  lrNumber: z.string().max(60).optional(),
  ewayBillNumber: z.string().max(60).optional(),
  dispatchDate: z.coerce.date().optional(),
  expectedDeliveryDate: z.coerce.date().optional(),
  remarks: z.string().max(2000).optional(),
};

export const dispatchSchema = z.object({
  order: objectId,
  lines: z.array(dispatchLine).min(1, 'Say what is going on the lorry'),
  ...paperwork,
});

/**
 * Correcting a consignment.
 *
 * Strict, so a screen posting a status here is refused rather than quietly ignored: the ladder
 * has its own door and that door carries §19's gate. A patch that silently dropped a status
 * change would look like it worked.
 */
export const dispatchUpdateSchema = z
  .strictObject({
    /** Accepted only before the lorry is loaded — the controller holds that rule. */
    lines: z.array(dispatchLine).min(1).optional(),
    deliveredAt: z.coerce.date().optional(),
    ...paperwork,
    ...versioned,
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), {
    message: 'Nothing to change',
  });

/**
 * Doing something to a consignment.
 *
 * The paperwork rides along, because the moment somebody presses "Dispatched" is the moment
 * they have the invoice and the LR in front of them. Sending them with the action means §19's
 * gate can be satisfied by the same request that would otherwise trip it, rather than making
 * the person save a form, read a refusal, and save it again.
 */
export const dispatchActionSchema = z.object({
  action: z.enum(DISPATCH_ACTION_KEYS),
  note: z.string().max(2000).optional(),
  cancellationReason: z.string().max(500).optional(),
  ...paperwork,
});
