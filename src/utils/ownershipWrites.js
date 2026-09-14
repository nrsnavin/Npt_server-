import User from '../models/User.js';
import { acquireOperationLock } from '../services/operationLock.service.js';
import ApiError from './ApiError.js';

/** Fence new ownership against offboarding; ordinary edits use the document version guard. */
export function protectOwnership(schema, fields = ['assignedTo']) {
  async function release(doc) {
    const releases = doc.$locals.ownerLocks || [];
    doc.$locals.ownerLocks = [];
    for (const unlock of releases.reverse()) await unlock();
  }
  schema.pre('save', async function () {
    const ids = [...new Set(fields.filter(field => this.isNew || this.isModified(field))
      .map(field => this.get(field)).filter(Boolean).map(value => String(value._id || value)))].sort();
    this.$locals.ownerLocks = [];
    try {
      for (const id of ids) {
        this.$locals.ownerLocks.push(await acquireOperationLock(`owner:${id}`, { retryMs: 2000 }));
        const user = await User.findById(id).select('isActive');
        if (user?.isActive === false) throw ApiError.conflict('That owner has been deactivated. Reload and assign an active colleague.');
      }
    } catch (error) { await release(this); throw error; }
  });
  schema.post('save', async function (doc) { await release(doc); });
  schema.post('save', async function (error, doc, next) {
    try { await release(doc || this); next(error); } catch (unlockError) { next(unlockError); }
  });
}
