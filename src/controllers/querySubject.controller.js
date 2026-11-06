import asyncHandler from '../utils/asyncHandler.js';
import { isManagement } from '../utils/departments.js';
import { ensureSubject, listSubjects, renameSubject, setSubjectHidden } from '../services/querySubjects.service.js';

/** The queries' subject drop-down [services/querySubjects.service.js]. */
export const getSubjects = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listSubjects({ withHidden: req.query.all === 'true' && isManagement(req.user) }) });
});

/** Anybody adds a subject — for everyone. */
export const addSubject = asyncHandler(async (req, res) => {
  const name = await ensureSubject(req.body.name, req.user);
  res.status(201).json({ success: true, data: { name } });
});

/** Admin: rename, or take off / put back on the list. */
export const editSubject = asyncHandler(async (req, res) => {
  let row = null;
  if (req.body.name !== undefined) row = await renameSubject(req.params.id, req.body.name);
  if (req.body.hidden !== undefined) row = await setSubjectHidden(req.params.id, req.body.hidden);
  res.json({ success: true, data: row });
});
