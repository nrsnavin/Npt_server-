import Attachment from '../models/Attachment.js';
import ApiError from '../utils/ApiError.js';
import { nearestTown } from '../data/places.js';
import { put, remove } from './storage.service.js';
import { mayWorkOnHandoff, noticeStatus } from './handoff.service.js';
import { findHandoff } from '../config/handoffs.js';

/**
 * A visit to the buyer's place, recorded from the phone on the spot [web: components/TaskVisits.jsx]:
 * Sampling at the buyer's for a sample, Payment Collection or the Payment Recovery Team calling
 * for the money. The person presses Record location; the phone's fix — where, how sure, when — is
 * kept on the task with the nearest town, and a satellite picture of the spot is fetched and kept
 * as an attachment, so whoever reads the task or the enquiry sees the visit was made, where and
 * when. Admin and the enquiry's marketing person hear of it under "Needs your action".
 *
 * The picture comes from Esri's World Imagery service — no key, one request for one JPEG. When
 * it cannot be fetched (no internet from the server, the service down) the visit is still
 * recorded, with why there is no picture.
 */

/** The tasks a visit is recorded on. */
export const VISIT_KINDS = ['sample_request', 'team_payment_followup', 'my_payment_followup', 'prt_recovery'];

/** A task's visits, short — how many, and the last one's when and where — for the queues and cards that offer the button. */
export const visitSummary = (task) => {
  const visits = task?.visits || [];
  const last = visits.at(-1);
  return {
    task: task?._id || null,
    count: visits.length,
    last: last ? { at: last.capturedAt || last.at, place: last.place?.name || null } : null,
  };
};

/**
 * The Sampling task each enquiry's samples are visited under: its open Sample Request, else its
 * latest — the same task the bench's moves are told on [handoff.service `noticeSampleMove`].
 */
export async function samplingTasksFor(enquiryIds) {
  const { default: Todo } = await import('../models/Todo.js');
  const ids = [...new Set((enquiryIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const tasks = await Todo.find({ enquiry: { $in: ids }, kind: 'sample_request' }).select('enquiry completed createdAt visits').sort({ completed: 1, createdAt: -1 }).lean();
  const byEnquiry = new Map();
  for (const task of tasks) if (!byEnquiry.has(String(task.enquiry))) byEnquiry.set(String(task.enquiry), task);
  return byEnquiry;
}

export const mayRecordVisit = (user, task) => VISIT_KINDS.includes(task?.kind) && mayWorkOnHandoff(user, task);

/* About 500 m across at the equator — a street and its neighbours, not a town. */
const SPAN_LNG = 0.0025;
const SPAN_LAT = 0.0016;
export const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';

/** The satellite view of a spot as a JPEG, or null with why not. */
export async function satelliteImage({ lat, lng }, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const bbox = [lng - SPAN_LNG, lat - SPAN_LAT, lng + SPAN_LNG, lat + SPAN_LAT].map((value) => value.toFixed(6)).join(',');
  const url = `${IMAGERY_URL}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=640,400&format=jpg&f=image`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { buffer: null, problem: `the imagery service answered ${response.status}` };
    const type = String(response.headers.get('content-type') || '');
    if (!type.startsWith('image/')) return { buffer: null, problem: 'the imagery service did not return a picture' };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { buffer: null, problem: 'the imagery service returned an empty picture' };
    return { buffer, mimeType: type.startsWith('image/png') ? 'image/png' : 'image/jpeg', problem: null };
  } catch (error) {
    return { buffer: null, problem: error.name === 'AbortError' ? 'the imagery service did not answer in time' : `the imagery service could not be reached (${error.message})` };
  } finally {
    clearTimeout(timer);
  }
}

const coords = (lat, lng) => `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
const placeWords = (place) => (place?.name ? `${place.distanceKm < 3 ? '' : `${Math.round(place.distanceKm)} km from `}${place.name}` : null);

/**
 * Records the fix on the task, with the picture. Returns the visit as kept. The fix is the
 * phone's: the person on the spot pressed the button — nothing here guesses a location.
 */
export async function recordVisit(task, user, { lat, lng, accuracyM, capturedAt, note } = {}, { fetchImpl } = {}) {
  if (!VISIT_KINDS.includes(task.kind)) throw ApiError.badRequest('A visit is recorded on a Sampling or payment follow-up task');
  if (!mayWorkOnHandoff(user, task)) throw ApiError.forbidden('Only whoever works this task records a visit on it');
  /* A task done — the sample handed over, say — still takes the visit that went with it: the fix is the evidence, whenever it is pressed. */
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw ApiError.badRequest('The phone gave no usable location — try again outside');

  const town = nearestTown({ lat: latitude, lng: longitude });
  const place = town ? { name: town.name, state: town.state || undefined, distanceKm: Math.round(town.distanceKm * 10) / 10 } : undefined;
  const picture = await satelliteImage({ lat: latitude, lng: longitude }, { fetchImpl });
  let image = null;
  let key = null;
  if (picture.buffer) {
    key = await put({ buffer: picture.buffer, mimeType: picture.mimeType });
    try {
      image = await Attachment.create({
        key, filename: `visit-${new Date().toISOString().slice(0, 10)}.${picture.mimeType === 'image/png' ? 'png' : 'jpg'}`, mimeType: picture.mimeType, size: picture.buffer.length,
        uploadedBy: user._id, task: task._id, enquiry: task.enquiry?._id || task.enquiry || undefined, customer: task.customer?._id || task.customer || undefined,
        docType: 'visit_satellite', title: 'Satellite view of the visit',
      });
    } catch (error) {
      await remove(key).catch(() => null);
      throw error;
    }
  }
  const visit = {
    lat: latitude, lng: longitude, accuracyM: Number.isFinite(Number(accuracyM)) ? Math.round(Number(accuracyM)) : undefined,
    place, image: image?._id, imageProblem: picture.problem ? `Satellite picture not kept: ${picture.problem}` : undefined,
    note: String(note || '').trim() || undefined, capturedAt: capturedAt ? new Date(capturedAt) : new Date(), by: user._id, at: new Date(),
  };
  task.visits = [...(task.visits || []), visit];
  const where = [placeWords(place), coords(latitude, longitude), visit.accuracyM != null && `±${visit.accuracyM} m`].filter(Boolean).join(' · ');
  const said = `Visited — ${where}${visit.note ? `: ${visit.note}` : ''}`;
  task.updates = [...(task.updates || []), { kind: 'note', statusLabel: 'Visited', text: visit.note, note: said, by: user._id, at: new Date() }];
  if (!task.user) task.user = user._id;
  await task.save();
  /* Admin and the enquiry's marketing person see the visit was made, where and when. */
  await noticeStatus(task, user, {
    step: { key: 'visited', label: `${findHandoff(task.kind)?.label || 'Task'}: visited${place?.name ? ` near ${place.name}` : ''}` },
    note: `${where}${visit.note ? ` — ${visit.note}` : ''}`,
    toAdminAndMarketing: true,
  });
  return task.visits.at(-1);
}
