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
 * The picture comes from Esri's World Imagery service — no key, 50 × 35 m around the fix at the
 * finest the service has there [satelliteImage]. When it cannot be fetched (no internet from the server, the service down) the visit is still
 * recorded, with why there is no picture.
 */

/** A fix within this is the buyer's gate, not the street. */
export const PRECISE_M = 10;

/** The tasks a visit is recorded on. */
export const VISIT_KINDS = ['sample_request', 'team_payment_followup', 'my_payment_followup', 'prt_recovery', 'request_prt_visit'];

/** A task's visits, short — how many, and the last one's when and where — for the queues and cards that offer the button. */
export const visitSummary = (task) => {
  const visits = task?.visits || [];
  const last = visits.at(-1);
  return {
    task: task?._id || null,
    count: visits.length,
    last: last ? { at: last.capturedAt || last.at, place: last.place?.name || null, accuracyM: last.accuracyM ?? null } : null,
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

/*
 * The picture covers the spot itself: 50 m across and 35 m high, centred on the fix — the buyer's
 * gate and building, not the street. Esri serves its imagery no finer than it has it — about
 * 0.3 m a pixel in Indian towns, coarser in the country — and refuses (HTTP 500) a request finer
 * than that. So the same 50 × 35 m is asked at 640 pixels wide first, then at fewer pixels each
 * time, and the first picture the service gives is the sharpest there is of that spot.
 */
export const IMAGE_SPAN_M = { width: 50, height: 35 };
export const IMAGE_WIDTHS_PX = [640, 480, 320, 256, 200, 180, 170, 160, 150, 128, 100, 80, 64];
export const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
const EARTH_R = 6378137;

/** The request for the box around a spot, in Web Mercator — square metres stay square, whatever the latitude. */
export function imageryUrl({ lat, lng }, widthPx) {
  const x = (EARTH_R * lng * Math.PI) / 180;
  const y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  /* A Mercator metre is a ground metre stretched by 1 / cos(latitude). */
  const stretch = 1 / Math.cos((lat * Math.PI) / 180);
  const halfW = (IMAGE_SPAN_M.width / 2) * stretch;
  const halfH = (IMAGE_SPAN_M.height / 2) * stretch;
  const heightPx = Math.round((widthPx * IMAGE_SPAN_M.height) / IMAGE_SPAN_M.width);
  const bbox = [x - halfW, y - halfH, x + halfW, y + halfH].map((value) => value.toFixed(2)).join(',');
  return { url: `${IMAGERY_URL}?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${widthPx},${heightPx}&format=jpg&f=image`, heightPx };
}

/**
 * The satellite view of a spot as a JPEG — the 50 × 35 m around it at the finest the service has
 * there — or null with why not. A refusal (finer than the imagery) tries fewer pixels; no answer
 * at all (no internet, the service down) stops at once.
 */
export async function satelliteImage({ lat, lng }, { fetchImpl = fetch, timeoutMs = 8000, budgetMs = 25000 } = {}) {
  const started = Date.now();
  let refused = null;
  for (const widthPx of IMAGE_WIDTHS_PX) {
    if (Date.now() - started > budgetMs) return { buffer: null, problem: 'the imagery service did not answer in time' };
    /* The last tries get what is left of the budget, not a full timeout each. */
    const wait = Math.max(1000, Math.min(timeoutMs, budgetMs - (Date.now() - started)));
    const { url, heightPx } = imageryUrl({ lat, lng }, widthPx);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), wait);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const type = String(response.headers.get('content-type') || '');
      if (!response.ok || !type.startsWith('image/')) {
        await response.arrayBuffer?.().catch(() => null);
        refused = response.status;
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) { refused = 'an empty picture'; continue; }
      return {
        buffer, mimeType: type.startsWith('image/png') ? 'image/png' : 'image/jpeg', problem: null,
        span: { widthM: IMAGE_SPAN_M.width, heightM: IMAGE_SPAN_M.height, widthPx, heightPx, metresPerPixel: Math.round((IMAGE_SPAN_M.width / widthPx) * 100) / 100 },
      };
    } catch (error) {
      /* A slow answer is tried again at the next size, inside the budget; no answer at all stops here. */
      if (error.name === 'AbortError') { refused = 'nothing in time'; continue; }
      return { buffer: null, problem: `the imagery service could not be reached (${error.message})` };
    } finally {
      clearTimeout(timer);
    }
  }
  if (refused === 'nothing in time') return { buffer: null, problem: 'the imagery service did not answer in time' };
  return { buffer: null, problem: `the imagery service has no picture of this spot${refused ? ` (it answered ${refused})` : ''}` };
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
    place, image: image?._id, imageSpan: picture.span || undefined, imageProblem: picture.problem ? `Satellite picture not kept: ${picture.problem}` : undefined,
    note: String(note || '').trim() || undefined, capturedAt: capturedAt ? new Date(capturedAt) : new Date(), by: user._id, at: new Date(),
  };
  task.visits = [...(task.visits || []), visit];
  /* Within 10 m is the buyer's gate; a rougher fix is said as approximate [web: hooks/usePreciseLocation.js]. */
  const where = [placeWords(place), coords(latitude, longitude), visit.accuracyM != null && `±${visit.accuracyM} m${visit.accuracyM > PRECISE_M ? ' (approximate)' : ''}`].filter(Boolean).join(' · ');
  const said = `Visited — ${where}${visit.note ? `: ${visit.note}` : ''}`;
  task.updates = [...(task.updates || []), { kind: 'note', statusLabel: 'Visited', text: visit.note, note: said, by: user._id, at: new Date() }];
  if (!task.user) task.user = user._id;
  await task.save();
  /* Admin and the enquiry's marketing person see the visit was made, where and when. */
  /* A task given without an enquiry — a PRT job on the buyer's dues: the buyer's marketing person is told too, as the enquiry's would be. */
  let buyerOwner = null;
  if (!task.enquiry && task.customer) {
    const { default: Customer } = await import('../models/Customer.js');
    buyerOwner = (await Customer.findById(task.customer?._id || task.customer).select('assignedTo').lean())?.assignedTo || null;
  }
  await noticeStatus(task, user, {
    step: { key: 'visited', label: `${findHandoff(task.kind)?.label || 'Task'}: visited${place?.name ? ` near ${place.name}` : ''}` },
    note: `${where}${visit.note ? ` — ${visit.note}` : ''}`,
    toAdminAndMarketing: true,
    also: buyerOwner ? [buyerOwner] : [],
  });
  return task.visits.at(-1);
}
