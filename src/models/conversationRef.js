import mongoose from 'mongoose';

/**
 * A pointer to the conversation a record came out of [BLUEPRINT §8, §41.6].
 *
 * Null on every record today, and that is the point. §41.6 requires conversation history to
 * stay linked to the lead, the contact, the customer and the enquiry; §8 asks for the field
 * now rather than after there are live records to migrate, because retrofitting an origin
 * across a year of enquiries is the migration nobody wants.
 *
 * Two fields rather than one string. `provider` is which system the thread lives in, so a
 * second channel later — email threading, a different WhatsApp vendor — does not have to be
 * decoded out of the reference's shape. `reference` is that system's own id for the thread,
 * whatever form it takes.
 *
 * Deliberately not a `ref` to a Conversation collection: there is no such collection, and
 * inventing its schema before the integration exists would be guessing at somebody else's
 * API. When the thread is stored locally this becomes the id of that record and nothing
 * else here changes.
 */
export const conversationRefSchema = new mongoose.Schema(
  {
    provider: { type: String, trim: true },
    reference: { type: String, trim: true },
    /** When the thread was attached, which is not when the record was created. */
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Applies the field and the lookup index to a schema.
 *
 * Indexed sparsely because it is null on almost everything, and the integration's first move
 * on an inbound message is to look for the record already carrying that thread [§41.2].
 */
export function withConversationRef(schema) {
  schema.add({ conversation: { type: conversationRefSchema, default: undefined } });
  schema.index({ 'conversation.reference': 1 }, { sparse: true });
  return schema;
}
