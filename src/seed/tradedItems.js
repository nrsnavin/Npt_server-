import TradedItem from '../models/TradedItem.js';
import { QUOTE_SHEET } from './quoteSheet.js';

/**
 * The trading master, from the five models the 26-27 sheet marks as traded.
 *
 * Their inward price is the sheet's own cost build-up for the row — grams at the rate, plus job
 * work, hook, clips, printing and packing — because the sheet does not carry a purchase price.
 * That is a demonstration figure for the screens, and the first thing to replace with the
 * supplier's real price list through the upload.
 *
 * Seeded after the quotations, so the sheet's transcribed costings keep their own build-up
 * rather than being matched to an item and costed twice.
 */
export async function seedTradedItems() {
  await TradedItem.deleteMany({});
  const traded = QUOTE_SHEET.filter((row) => row.procurement === 'trade');
  const seen = new Set();
  let created = 0;
  for (const row of traded) {
    if (seen.has(row.model)) continue;
    seen.add(row.model);
    const price =
      ((row.gram || 0) * (row.rate || 0)) / 1000 +
      (row.jobWork || 0) + (row.hook || 0) + (row.clips || 0) + (row.printPrice || 0) + (row.packing || 0);
    const inwardPrice = Math.round(price * 100) / 100;
    const at = new Date();
    await TradedItem.create({
      modelNumber: row.model,
      colour: row.colour?.split(':').pop().trim() || undefined,
      material: row.colour?.includes(':') ? row.colour.split(':')[0].trim() : undefined,
      supplier: 'Demo supplier — replace with the real price list',
      inwardPrice,
      priceUpdatedAt: at,
      priceHistory: [{ price: inwardPrice, at, source: 'manual', note: 'From the 26-27 sheet cost build-up' }],
      notes: 'Demonstration price from the 26-27 sheet; replace by uploading the supplier list.',
    });
    created += 1;
  }
  return { created };
}
