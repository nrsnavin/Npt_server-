import Customer from '../models/Customer.js';
import CustomerMessage from '../models/CustomerMessage.js';
import ApiError from '../utils/ApiError.js';
import { normalisePhone } from '../utils/phone.js';
import { isWhatsAppConfigured, sendWhatsApp, whatsappTemplate } from '../providers/whatsapp.js';
import { isProduction } from '../config/env.js';

/**
 * The buyer's gate, from the buyer: Dispatch or marketing asks on WhatsApp, the buyer shares their
 * location, and the next location they send is pinned on the customer — so the planner groups
 * nearby deliveries by real distance and the driver goes to the gate, not the town.
 *
 * Asked or not, a location a buyer sends stays in the WhatsApp thread. It is only pinned when it was
 * asked for (within two weeks), or when the buyer has no pin yet; a pin somebody set from the gate is
 * never replaced by a location nobody asked for.
 */

const ASK_KEPT_MS = 14 * 86400000;

export async function askForLocation(customer, user) {
  const phone = normalisePhone(customer.whatsapp || customer.mobile || '');
  const body = `Dear ${customer.name || 'Sir/Madam'}, to deliver your goods straight to your gate, please share your delivery location here on WhatsApp: tap 📎 (attach) → Location → Send your current location. Thank you — Navin Plastic Tech.`;
  const base = { customer: customer._id, event: 'location_ask', channel: 'whatsapp', body, sentBy: user._id };
  let message;
  if (customer.notifications?.whatsapp === false) message = await CustomerMessage.create({ ...base, status: 'skipped', skipReason: 'opted_out' });
  else if (!phone) message = await CustomerMessage.create({ ...base, status: 'skipped', skipReason: 'no_address' });
  else if (!isWhatsAppConfigured()) {
    if (isProduction) message = await CustomerMessage.create({ ...base, recipient: phone, status: 'skipped', skipReason: 'no_provider' });
    else {
      console.log(`\n[whatsapp] to ${phone}\n${body}\n`);
      message = await CustomerMessage.create({ ...base, recipient: phone, status: 'sent', providerStatus: 'logged' });
    }
  } else {
    try {
      const template = whatsappTemplate('location');
      const sent = await sendWhatsApp({ to: phone, body, ...(template ? { template, variables: { 1: customer.name || '' } } : {}) });
      message = await CustomerMessage.create({ ...base, recipient: phone, status: 'sent', providerId: sent.id, providerStatus: sent.status, usedTemplate: Boolean(template) });
    } catch (error) {
      message = await CustomerMessage.create({ ...base, recipient: phone, status: 'failed', error: error.message });
    }
  }
  if (message.status === 'sent') await Customer.updateOne({ _id: customer._id }, { $set: { locationAskedAt: new Date() } }, { keepVersion: true });
  if (message.status !== 'sent') {
    const why = { opted_out: 'They have opted out of WhatsApp messages', no_address: 'There is no WhatsApp or mobile number on the customer', no_provider: 'WhatsApp is not set up' }[message.skipReason] || message.error || 'It could not be sent';
    throw ApiError.badRequest(why);
  }
  return message;
}

/** A location in a thread: pinned on the thread's customer when asked for, or when they have none. */
export async function pinSharedLocation(thread, message) {
  if (!thread.customer || !message?.location) return null;
  const customer = await Customer.findById(thread.customer).select('site locationAskedAt assignedTo');
  if (!customer) return null;
  const asked = customer.locationAskedAt && Date.now() - new Date(customer.locationAskedAt).getTime() < ASK_KEPT_MS;
  if (customer.site?.lat != null && !asked) return null;
  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        site: {
          lat: message.location.lat, lng: message.location.lng,
          place: message.location.name || message.location.address ? { name: message.location.name || message.location.address } : undefined,
          source: 'whatsapp', setBy: customer.assignedTo, setAt: new Date(), fromThread: thread._id, fromMessage: message._id,
        },
      },
      $unset: { locationAskedAt: 1 },
    },
    { keepVersion: true, runValidators: true }
  );
  return true;
}
