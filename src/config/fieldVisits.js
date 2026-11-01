/**
 * Field visits: the module that follows a person out of the office [services/fieldVisit.service.js].
 *
 * A visit is planned (from an enquiry's task, from a customer's team task, or on its own — the
 * bank, a cash withdrawal), checked into at the gate with the phone's fix, pinged every five
 * minutes while the person is there, and checked out of with what came of it. The day round the
 * visits is kept too: Field Duty Start and End, lunch, or the office Punch In / Punch Out on a
 * day in the office. Everything here is the vocabulary of that: the categories, what each asks
 * for at check-out, the rules the checks run by, and the flags they raise for Admin.
 */

export const VISIT_CATEGORIES = [
  { key: 'marketing', label: 'Marketing' },
  { key: 'payment_collection', label: 'Payment Collection' },
  { key: 'prt_collection', label: 'PRT Collection' },
  { key: 'sample_delivery', label: 'Sample Delivery' },
  /* The general visit with no buyer: the bank, cash, a courier, a purchase. */
  { key: 'bank_cash', label: 'Bank / Cash' },
  { key: 'others', label: 'Others' },
];
export const CATEGORY_KEYS = VISIT_CATEGORIES.map((category) => category.key);
export const categoryLabel = (key) => VISIT_CATEGORIES.find((category) => category.key === key)?.label || 'Visit';

/** The task kinds a visit is planned from, and the category each one is. */
export const CATEGORY_FOR_KIND = Object.freeze({
  sample_request: 'sample_delivery',
  prt_recovery: 'prt_collection',
  request_prt_visit: 'prt_collection',
  team_payment_followup: 'payment_collection',
  my_payment_followup: 'payment_collection',
});
export const VISIT_TASK_KINDS = Object.keys(CATEGORY_FOR_KIND);
/** The task kinds a collected payment is logged on, for Accounts to confirm [paymentGates.service]. */
export const PAYMENT_TASK_KINDS = ['prt_recovery', 'request_prt_visit', 'team_payment_followup', 'my_payment_followup'];

const PERSON_UNAVAILABLE = { key: 'person_unavailable', label: 'Person Unavailable', fields: [], completes: false };
const COLLECTION_OUTCOMES = [
  { key: 'collected', label: 'Collected', fields: ['amount', 'mode', 'reference'], required: ['amount', 'mode'], completes: true },
  { key: 'promised', label: 'Promised', fields: ['committedDate'], required: ['committedDate'], completes: true },
  { key: 'refused', label: 'Refused', fields: ['reason'], required: ['reason'], completes: false },
  PERSON_UNAVAILABLE,
];

/**
 * What a check-out must say, by category — one outcome, and the details that outcome needs.
 * `completes` decides whether the visit reads Completed or Not Completed on the day's report.
 */
export const OUTCOMES = Object.freeze({
  payment_collection: COLLECTION_OUTCOMES,
  prt_collection: COLLECTION_OUTCOMES,
  sample_delivery: [
    { key: 'delivered', label: 'Delivered', fields: ['receivedBy', 'receivedByPhone', 'pieces'], required: ['receivedBy'], completes: true },
    { key: 'not_accepted', label: 'Not accepted', fields: ['reason'], required: ['reason'], completes: false },
    PERSON_UNAVAILABLE,
  ],
  marketing: [
    { key: 'met', label: 'Met', fields: ['metWhom', 'summary', 'nextFollowUp'], required: ['metWhom'], completes: true },
    PERSON_UNAVAILABLE,
  ],
  bank_cash: [
    { key: 'done', label: 'Done', fields: ['summary'], required: [], completes: true },
    { key: 'not_done', label: 'Not done', fields: ['reason'], required: ['reason'], completes: false },
  ],
  others: [
    { key: 'done', label: 'Done', fields: ['summary'], required: [], completes: true },
    { key: 'not_done', label: 'Not done', fields: ['reason'], required: ['reason'], completes: false },
  ],
});
export const outcomesFor = (category) => OUTCOMES[category] || OUTCOMES.others;

export const OUTCOME_FIELDS = Object.freeze({
  amount: { label: 'Amount collected (₹)', type: 'number' },
  mode: { label: 'How paid', type: 'select', options: ['cash', 'cheque', 'upi', 'neft', 'rtgs', 'other'] },
  reference: { label: 'Cheque / UTR / receipt number', type: 'text' },
  committedDate: { label: 'Committed date', type: 'date' },
  reason: { label: 'Reason', type: 'text' },
  receivedBy: { label: 'Received by', type: 'text' },
  receivedByPhone: { label: 'Their phone', type: 'text' },
  pieces: { label: 'Pieces handed over', type: 'number' },
  metWhom: { label: 'Who was met', type: 'text' },
  summary: { label: 'What happened', type: 'text' },
  nextFollowUp: { label: 'Next follow-up', type: 'date' },
});

/**
 * How each outcome moves the task the visit was planned from [services/fieldVisit.service.js
 * `linkOutcome`] — the task's own status [config/departmentTaskForms.js], so the desk, the
 * receivable's chase log and Accounts read the visit as they read a move made from the task.
 *   PRT (prt_recovery, request_prt_visit): Visit Planned → Visited → Cheque Collected / Payment
 *   Received → Promised; Payment Collection: Contacted → Payment Received / Promised / Not Reachable;
 *   Sampling has no statuses of its own: Delivered is the sample's hand-over [sampling.service
 *   `recordHandover`], which closes the Sample Request. Refused is logged, not a status.
 *   Marketing: the enquiry's next follow-up and an activity.
 */
export const TASK_STATUS_FOR = Object.freeze({
  prt_recovery: { planned: 'visit_planned', visited: 'visited', collected: 'collected', cheque: 'cheque_collected', promised: 'promised' },
  request_prt_visit: { planned: 'visit_planned', visited: 'visited', collected: 'collected', cheque: 'cheque_collected', promised: 'promised' },
  team_payment_followup: { visited: 'contacted', collected: 'payment_inward', cheque: 'payment_inward', promised: 'promised', unavailable: 'not_reachable' },
  my_payment_followup: { visited: 'contacted', promised: 'promised', unavailable: 'not_reachable' },
});
/** The money's mode as the task's form spells it [departmentTaskForms MONEY_FIELDS]. */
export const MODE_LABELS = Object.freeze({ cash: 'Cash', cheque: 'Cheque', upi: 'UPI', neft: 'NEFT', rtgs: 'RTGS', other: 'Other' });

/** The statuses a visit moves through. */
export const VISIT_STATUSES = ['planned', 'checked_in', 'completed', 'not_completed', 'rescheduled', 'cancelled'];
export const OPEN_VISIT_STATUSES = ['planned', 'checked_in'];

/**
 * The rules the checks run by. Metres and minutes, in one place, so the report's words and the
 * checks agree — and so Admin's question "why was this flagged" has one answer.
 */
export const FIELD_RULES = Object.freeze({
  /** A fix within this is the gate, not the street [taskVisit.service PRECISE_M]: verified. */
  preciseM: 10,
  /**
   * The phone cannot always get under 10 m — indoors, under a roof, in a lane between tall
   * buildings. A fix within this is kept as approximate: the visit is not flagged and Admin is
   * not told; a later precise fix while there verifies it after the fact [fieldVisit.service `ping`].
   */
  acceptableM: 50,
  /** Beyond this the fix is rough: the person says why (indoors, basement) and the check-in is kept unverified, Admin told. */
  roughM: 100,
  /** A fix worse than this is not judged at all — a strike from a ±300 m fix would be the phone's, not the person's. */
  judgeMaxAccuracyM: 100,
  /** This many unjudged fixes in a row: the place has poor GPS, said on the report (never a strike). */
  poorPings: 4,
  /** The phone sends a fix this often while checked in [web: pages/FieldDay.jsx]. */
  pingEveryMs: 5 * 60_000,
  /** No fix for this long while checked in is a gap in the record — the app was closed or the phone asleep. */
  pingGapMs: 15 * 60_000,
  /** Two fixes in a row further than this from the check-in point: the person left the place while checked in. */
  leftSiteM: 150,
  leftSitePings: 2,
  /** A check-in further than this from the buyer's pinned gate is said so. */
  farFromBuyerM: 300,
  /** Checked out further than this from where they checked in. */
  checkOutAwayM: 200,
  /** In and out within this is a drive-by, not a visit. */
  tooShortMs: 3 * 60_000,
  /** Faster than this between two fixes is not a person travelling. */
  implausibleKmh: 120,
  /** A fix stamped this far from the server's clock. */
  clockSkewMs: 2 * 60_000,
  /** This many fixes in a row with the very same coordinates and accuracy: a real GPS wanders; a fed one does not. */
  stalePings: 3,
  /** A field day longer than this, start to end. */
  longDayHours: 14,
  lunchMaxMinutes: 60,
  /** A gap between two recorded events longer than this is unrecorded time, not travel. */
  travelMaxMinutes: 90,
  /** Checked in this long: a reminder to check out. */
  remindAfterMs: 2 * 60 * 60_000,
  /** And again at this hour (IST) to the person and Admin. */
  remindAtHourIST: 18,
  /** The same visit put off this many times is Admin's to look at. */
  maxReschedules: 3,
  /** The most fixes kept on one visit — eight hours at five minutes. */
  maxPings: 120,
  /**
   * A fix that strays — away from the check-in point, frozen, or an impossible jump — is a
   * strike: the person is told and may re-check the GPS on the spot. This many strikes on one
   * visit, and Admin and whoever planned it are told something is wrong with it.
   */
  suspectStrikes: 5,
});

/** What each flag means, in the words the report shows. */
export const FLAGS = Object.freeze({
  gps_not_verified: 'GPS not verified',
  entered_later: 'Entered later',
  far_from_buyer: 'Far from the buyer’s pinned gate',
  left_site: 'Left the place while checked in',
  checked_out_elsewhere: 'Checked out away from the check-in point',
  too_short: 'Too short to be a visit',
  implausible_travel: 'Implausible movement',
  clock_skew: 'Phone clock off',
  stale_fix: 'GPS not updating — possible fed location',
  tracking_gaps: 'Gaps in tracking',
  office_and_field: 'Office punch and field duty on the same day',
  long_day: 'Very long field day',
  long_lunch: 'Lunch over an hour',
  overnight: 'Checked in overnight',
  incomplete_report: 'Day not ended — report incomplete',
  rescheduled_often: 'Rescheduled many times',
  times_edited: 'Times edited by Admin',
  receipt_not_logged: 'Collected money not on a payment task',
  no_outcome_report: 'Visit words not written up',
  suspect_tracking: 'Something wrong in this visit — the GPS strayed repeatedly',
  poor_gps: 'GPS poor at this place',
  gps_verified_later: 'GPS verified later, at the place',
});
export const flagLabel = (key) => FLAGS[key] || String(key || '').replace(/_/g, ' ');
