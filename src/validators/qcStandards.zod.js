import { z } from 'zod';

/** A model's or a buyer's test standards [models/qcStandards.schema.js]; blanks and nulls clear a figure. */
const figure = (max = 100000) => z.number().min(0).max(max).nullable().optional().transform((value) => value ?? undefined);

export const qcStandardsInput = z.object({
  breakingMinKg: figure(), hookPullMinKg: figure(), clipGripMinKg: figure(),
  hangLoadKg: figure(), hangHours: figure(1000), allowedDeflectionMm: figure(),
  weightToleranceG: figure(), widthToleranceMm: figure(), dropHeightCm: figure(), drops: figure(1000),
  moistureMaxPercent: figure(100), mfiMin: figure(1000), mfiMax: figure(1000), shrinkageMaxPercent: figure(100),
  hookTurns: figure(1000000), uvHours: figure(10000), cartonDropCm: figure(), piecesPerCarton: figure(100000),
  aql: z.union([z.literal(0.65), z.literal(1), z.literal(1.5), z.literal(2.5), z.literal(4), z.literal(6.5)]).nullable().optional().transform((value) => value ?? undefined),
  notes: z.string().trim().max(500).optional(),
}).nullable().optional();
