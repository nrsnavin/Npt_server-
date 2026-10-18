/**
 * Why a press stopped, and why a piece was thrown out — one fixed list each, so a month of runs
 * can be added up by reason rather than read line by line [models/MouldRun.js `downtime`,
 * `rejects`; services/oee.service.js].
 *
 * `planned` downtime is time the plant chose to spend (a mould or colour change, a scheduled
 * service). OEE counts it out of the time the press was meant to run; unplanned stops count
 * against availability.
 */
export const DOWNTIME_REASONS = [
  { key: 'mould_change', label: 'Mould change', planned: true },
  { key: 'colour_change', label: 'Colour / material change', planned: true },
  { key: 'planned_maintenance', label: 'Planned maintenance', planned: true },
  { key: 'machine_breakdown', label: 'Machine breakdown' },
  { key: 'mould_problem', label: 'Mould problem (stuck, cooling, ejector)' },
  { key: 'heater_band', label: 'Heater band / temperature' },
  { key: 'material_shortage', label: 'No material' },
  { key: 'material_wet', label: 'Material wet / drying' },
  { key: 'power_cut', label: 'Power cut' },
  { key: 'no_operator', label: 'No operator' },
  { key: 'waiting_qc', label: 'Waiting for QC approval' },
  { key: 'hook_clip_shortage', label: 'Hooks / clips not available' },
  { key: 'other', label: 'Other' },
];

export const REJECT_REASONS = [
  { key: 'flash', label: 'Flash' },
  { key: 'short_shot', label: 'Short shot' },
  { key: 'sink_mark', label: 'Sink mark' },
  { key: 'warpage', label: 'Warpage / bend' },
  { key: 'black_spot', label: 'Black spot / contamination' },
  { key: 'colour_variation', label: 'Colour variation' },
  { key: 'flow_mark', label: 'Flow mark / silver streak' },
  { key: 'weld_line', label: 'Weld line / crack' },
  { key: 'burn_mark', label: 'Burn mark' },
  { key: 'hook_defect', label: 'Hook / clip defect' },
  { key: 'startup', label: 'Start-up scrap' },
  { key: 'other', label: 'Other' },
];

export const DOWNTIME_KEYS = DOWNTIME_REASONS.map((reason) => reason.key);
export const REJECT_KEYS = REJECT_REASONS.map((reason) => reason.key);
export const PLANNED_DOWNTIME = DOWNTIME_REASONS.filter((reason) => reason.planned).map((reason) => reason.key);
export const reasonLabel = (list, key) => list.find((reason) => reason.key === key)?.label || key || 'Not coded';
