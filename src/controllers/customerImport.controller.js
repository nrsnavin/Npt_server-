import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { sheetRows } from '../services/sheetRows.js';
import { applyImport, planImport, templateBuffer } from '../services/customerImport.service.js';

/**
 * Customers from Excel [services/customerImport.service.js]: the template to fill, and the upload
 * — `commit` false answers the preview and writes nothing; true creates the new customers.
 */

export const customerImportTemplate = asyncHandler(async (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="customer-import-template.xlsx"');
  res.send(templateBuffer());
});

export const importCustomers = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach the Excel (.xlsx) or CSV file');
  const rows = sheetRows(req.file.buffer);
  if (!rows) throw ApiError.badRequest('That file could not be read as an Excel (.xlsx) or CSV sheet');
  const defaultOwner = String(req.body.defaultOwner || '').trim() || null;
  if (defaultOwner && !/^[0-9a-f]{24}$/i.test(defaultOwner)) throw ApiError.badRequest('Pick the marketing owner from the list');
  const result = await planImport(rows, { defaultOwner });
  if (result.error) throw ApiError.badRequest(result.error);
  if (String(req.body.commit || req.query.commit) !== 'true') return res.json({ success: true, data: { ...result, committed: false } });
  const written = await applyImport(result.plan);
  res.json({ success: true, data: { ...result, ...written, committed: true } });
});

/** The active delivery routes, for the customer form — anybody who opens customers reads them [defaultRoutes.service]. */
export const customerRoutes = asyncHandler(async (req, res) => {
  const { activeRoutes } = await import('../services/defaultRoutes.service.js');
  res.json({ success: true, data: await activeRoutes() });
});
