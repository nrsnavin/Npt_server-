import SavedView, { MAX_VIEWS } from '../models/SavedView.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { canRead } from '../services/access.service.js';

/** The module a page belongs to — a view on a list the person cannot open is no view at all. */
const MODULE_OF = {
  queries: 'queries', enquiries: 'enquiries', leads: 'enquiries', samples: 'samples',
  customers: 'customers', pricings: 'pricing',
};

const shape = (view) => ({
  _id: view._id,
  page: view.page,
  name: view.name,
  params: Object.fromEntries(view.params || []),
  pinned: view.pinned,
  updatedAt: view.updatedAt,
});

/** Mine, for every page or one, on pages I can still open. */
export const listViews = asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.page) filter.page = String(req.query.page);
  const views = await SavedView.find(filter).sort({ page: 1, name: 1 });
  res.json({ success: true, data: views.filter((view) => canRead(req.user, MODULE_OF[view.page])).map(shape) });
});

export const createView = asyncHandler(async (req, res) => {
  const { page, name, params, pinned } = req.body;
  if (!canRead(req.user, MODULE_OF[page])) throw ApiError.forbidden('You cannot open that list');
  if ((await SavedView.countDocuments({ user: req.user._id })) >= MAX_VIEWS) {
    throw ApiError.badRequest(`You have ${MAX_VIEWS} saved views. Delete one to save another.`);
  }
  if (await SavedView.exists({ user: req.user._id, page, name })) {
    throw ApiError.conflict(`You already have a view called "${name}" there`);
  }
  const view = await SavedView.create({ user: req.user._id, page, name, params, pinned });
  res.status(201).json({ success: true, data: shape(view) });
});

/** Only the owner's own views are ever found — anybody else's id is simply not there. */
async function ownView(req) {
  const view = await SavedView.findOne({ _id: req.params.id, user: req.user._id });
  if (!view) throw ApiError.notFound('View not found');
  return view;
}

export const updateView = asyncHandler(async (req, res) => {
  const view = await ownView(req);
  const { name, params, pinned } = req.body;
  if (name !== undefined && name !== view.name && (await SavedView.exists({ user: req.user._id, page: view.page, name }))) {
    throw ApiError.conflict(`You already have a view called "${name}" there`);
  }
  if (name !== undefined) view.name = name;
  if (params !== undefined) view.params = params;
  if (pinned !== undefined) view.pinned = pinned;
  await view.save();
  res.json({ success: true, data: shape(view) });
});

export const deleteView = asyncHandler(async (req, res) => {
  const view = await ownView(req);
  await view.deleteOne();
  res.json({ success: true, data: { _id: view._id } });
});
