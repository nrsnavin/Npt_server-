import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

const RESERVED_QUERY_KEYS = new Set(['page', 'limit', 'sort', 'search', 'fields']);

/** Turns query-string params into a mongo filter, supporting `field[gte]=value` style operators. */
export function buildFilter(query, { searchFields = [] } = {}) {
  const filter = {};

  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(key) || value === '' || value === undefined) continue;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const operators = {};
      for (const [op, opValue] of Object.entries(value)) {
        if (['gt', 'gte', 'lt', 'lte', 'ne', 'in'].includes(op)) {
          operators[`$${op}`] = op === 'in' ? String(opValue).split(',') : opValue;
        }
      }
      if (Object.keys(operators).length) filter[key] = operators;
      continue;
    }

    if (typeof value === 'string' && value.includes(',')) {
      filter[key] = { $in: value.split(',') };
    } else if (value === 'true' || value === 'false') {
      filter[key] = value === 'true';
    } else {
      filter[key] = value;
    }
  }

  if (query.search && searchFields.length) {
    const regex = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = searchFields.map((field) => ({ [field]: regex }));
  }

  return filter;
}

/**
 * Builds the standard REST handlers for a model.
 * `populate` is applied on list and detail reads, `searchFields` powers `?search=`.
 */
export default function crudController(Model, options = {}) {
  const {
    searchFields = [],
    populate = '',
    defaultSort = '-createdAt',
    beforeCreate,
    beforeUpdate,
    afterWrite,
  } = options;

  const list = asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const sort = req.query.sort || defaultSort;
    const filter = buildFilter(req.query, { searchFields });

    const [data, total] = await Promise.all([
      Model.find(filter)
        .populate(populate)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit),
      Model.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  });

  const getOne = asyncHandler(async (req, res) => {
    const doc = await Model.findById(req.params.id).populate(populate);
    if (!doc) throw ApiError.notFound(`${Model.modelName} not found`);
    res.json({ success: true, data: doc });
  });

  const create = asyncHandler(async (req, res) => {
    const payload = beforeCreate ? await beforeCreate(req.body, req) : req.body;
    const doc = await Model.create(payload);
    if (afterWrite) await afterWrite(doc, req);
    const populated = populate ? await doc.populate(populate) : doc;
    res.status(201).json({ success: true, data: populated });
  });

  const update = asyncHandler(async (req, res) => {
    const payload = beforeUpdate ? await beforeUpdate(req.body, req) : req.body;
    const doc = await Model.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).populate(populate);
    if (!doc) throw ApiError.notFound(`${Model.modelName} not found`);
    if (afterWrite) await afterWrite(doc, req);
    res.json({ success: true, data: doc });
  });

  const remove = asyncHandler(async (req, res) => {
    const doc = await Model.findByIdAndDelete(req.params.id);
    if (!doc) throw ApiError.notFound(`${Model.modelName} not found`);
    res.json({ success: true, data: { id: doc._id } });
  });

  return { list, getOne, create, update, remove };
}
