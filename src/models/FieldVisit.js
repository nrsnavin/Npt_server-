import mongoose from 'mongoose';
import { protectWrites } from '../utils/concurrency.js';
import { CATEGORY_KEYS, VISIT_STATUSES } from '../config/fieldVisits.js';

/**
 * One visit out of the office [config/fieldVisits.js; services/fieldVisit.service.js].
 *
 * Planned for a person on a date — from an enquiry's task, a customer's team task, or on its own
 * (the bank, a cash withdrawal, linked to a buyer or an enquiry later if at all). Checked into at
 * the place with the phone's fix, pinged every five minutes while there, checked out of with the
 * outcome the category asks for. Put off, it becomes another visit on the new date, and the two
 * keep each other's reference so the chain reads whole on the report.
 *
 * The check-in is also recorded on the task as a visit [taskVisit.service `recordVisit`] — the
 * satellite picture and the notice to Admin and marketing live there; `checkIn.taskVisit` says
 * which one. A visit with no task keeps its own words and written-up report here.
 */
const fix = () => ({
  at: Date,
  lat: { type: Number, min: -90, max: 90 },
  lng: { type: Number, min: -180, max: 180 },
  accuracyM: Number,
  /* Within 10 m and taken live: the gate, not the street and not a guess. */
  verified: Boolean,
  place: { name: String, state: String, distanceKm: Number },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  _id: false,
});

const flagSchema = new mongoose.Schema({ key: { type: String, required: true }, label: String, detail: String, at: { type: Date, default: Date.now } }, { _id: false });

const fieldVisitSchema = new mongoose.Schema(
  {
    /** Who makes the visit. */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    category: { type: String, enum: CATEGORY_KEYS, required: true },
    purpose: { type: String, trim: true, maxlength: 300, required: true },
    /** The day planned, as the person's calendar reads it (IST): YYYY-MM-DD. */
    plannedDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, required: true, index: true },
    /** A time if one was given, HH:MM. */
    plannedTime: { type: String, match: /^\d{2}:\d{2}$/ },
    status: { type: String, enum: VISIT_STATUSES, default: 'planned', index: true },

    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },

    checkIn: {
      ...fix(),
      /* How good the fix was [config/fieldVisits.js]: precise (verified), approximate, rough (with why), none (with why). */
      grade: { type: String, enum: ['precise', 'approximate', 'rough', 'none'] },
      /* A later precise fix while there verified a rough check-in after the fact; `anchor` is the place as best known. */
      verifiedLaterAt: Date,
      anchor: { lat: Number, lng: Number, accuracyM: Number },
      /* The visit on the task this check-in was recorded as [Todo `visits`]. */
      taskVisit: mongoose.Schema.Types.ObjectId,
      /* Typed after the fact rather than pressed at the gate — never verified. */
      enteredLater: Boolean,
      reason: String,
      device: String,
    },
    checkOut: { ...fix(), distanceFromCheckInM: Number },
    /** The fixes while checked in, every five minutes [FIELD_RULES.pingEveryMs]. */
    pings: {
      type: [new mongoose.Schema({ at: Date, lat: Number, lng: Number, accuracyM: Number, distanceM: Number, poor: Boolean }, { _id: false })],
      default: undefined,
    },

    outcome: {
      key: String,
      label: String,
      completes: Boolean,
      amount: Number,
      mode: String,
      reference: String,
      committedDate: String,
      reason: String,
      receivedBy: String,
      metWhom: String,
      summary: String,
      nextFollowUp: String,
      /* The visitor's own few words, and the report written up from them [visitNote.llm.js]. */
      words: { met: String, happened: String, response: String },
      report: { text: String, outcome: String, writtenBy: String, at: Date },
      /* The receipt a collected payment was logged on, for Accounts to confirm [paymentGates.service]. */
      receivable: { type: mongoose.Schema.Types.ObjectId, ref: 'Receivable' },
      at: Date,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },

    /** Put off: the visit that took its place, and the one it took the place of. */
    rescheduledTo: { type: mongoose.Schema.Types.ObjectId, ref: 'FieldVisit' },
    rescheduledFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'FieldVisit' },
    /** How many times this chain has been put off so far. */
    reschedules: { type: Number, default: 0 },
    /** A planned visit closed without a check-in: not completed, put off or cancelled, with why. */
    settled: { reason: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: Date },

    flags: { type: [flagSchema], default: () => [] },
    reminders: { afterHours: Date, evening: Date },
    /**
     * The five-minute fixes judged [fieldVisit.service `ping`]: strikes so far, the last one
     * that strayed and whether the person has been asked to re-check, when they confirmed the
     * place, and when the strikes reached the limit and Admin was told.
     */
    tracking: {
      strikes: { type: Number, default: 0 },
      /* Unjudged fixes in a row — poor GPS here. */
      poorRun: { type: Number, default: 0 },
      pendingRecheck: Boolean,
      lastDiscrepancy: { kind: String, detail: String, distanceM: Number, at: Date },
      recheckedAt: Date,
      suspectAt: Date,
      _id: false,
    },
    history: {
      type: [new mongoose.Schema({
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        action: { type: String, required: true },
        note: String,
        from: mongoose.Schema.Types.Mixed,
        to: mongoose.Schema.Types.Mixed,
      }, { _id: false })],
      default: () => [],
    },
  },
  { timestamps: true },
);

fieldVisitSchema.index({ user: 1, plannedDate: 1, status: 1 });
fieldVisitSchema.index({ status: 1, 'checkIn.at': 1 });

protectWrites(fieldVisitSchema);
export default mongoose.model('FieldVisit', fieldVisitSchema);
