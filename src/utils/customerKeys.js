import { normalisePhone } from './phone.js';

/**
 * What makes two customers the same one — GST, then each phone number — as the lock keys every
 * way of creating a customer holds while it checks and saves [operationLock.service
 * `withCreateLocks`]: the customers screen, an IndiaMART lead and a confirmed card all queue on
 * the same number, so none of them makes a twin of what another is making.
 */
export const customerKeys = ({ gstin, mobile, whatsapp } = {}) => [
  gstin && `customer:gst:${String(gstin).trim().toUpperCase()}`,
  ...[normalisePhone(mobile), normalisePhone(whatsapp)].filter(Boolean).map((number) => `customer:phone:${number}`),
];
