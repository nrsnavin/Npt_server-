/**
 * The plant's own 26-27 quotation sheet, as data.
 *
 * Every row is transcribed from "26-27-QUOTE / For Navin" — the model, the cost lines and what
 * was actually quoted. It is here rather than invented because seed data that does not look
 * like the real thing tests the wrong system: made-up costings all round to sensible numbers,
 * all sit above their floor, and never include the case that matters, which is the buyer quoted
 * at less than half the minimum because the relationship is worth more than the piece.
 *
 * The costing engine is checked against these rows: net total and all three tiers reproduce the
 * sheet on 25 of 25.
 *
 * Sizes and categories are *inferred* from the model code — "MAU-35" reads as 350mm, "AR-8\"" as
 * 8 inches — because the sheet does not carry them. They are a starting catalogue for testing,
 * not the plant's own classification, and are the first thing to correct against the real one.
 */
export const QUOTE_SHEET = [
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'MAU-35 WB', colour: 'PP : WHITE', quoted: 3.6, procurement: 'trade', gram: 30.0, rate: 160.0, jobWork: 0.75, hook: 0.7, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'CRF-30', colour: 'PP : WHITE', quoted: 4.2, procurement: 'manufacture', gram: 13.0, rate: 160.0, jobWork: 0.75, hook: 0.7, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.1 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'CRF-25 WB', colour: 'PP : WHITE', quoted: 6.0, procurement: 'trade', gram: 19.0, rate: 160.0, jobWork: undefined, hook: 0.7, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: undefined },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'CRF-30 WB', colour: 'PP : WHITE', quoted: 6.6, procurement: 'trade', gram: 18.0, rate: 160.0, jobWork: 0.7, hook: 0.7, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.15 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'RW-236', colour: 'HIPS : PRIME BLACK', quoted: 7.4, procurement: 'manufacture', gram: 47.5, rate: 90.0, jobWork: 1.35, hook: 0.75, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.25 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'CRF-40 WB', colour: 'PP : WHITE', quoted: 7.8, procurement: 'trade', gram: 28.0, rate: 160.0, jobWork: 0.75, hook: 0.7, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'AR-8"', colour: 'PP : WHITE', quoted: 6.8, procurement: 'manufacture', gram: 15.0, rate: 160.0, jobWork: 0.8, hook: 0.7, clips: 1.2, printing: '1 COLOUR', printPrice: 0.5, packing: 0.15 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'WM-230', colour: 'PP : WHITE', quoted: 7.2, procurement: 'manufacture', gram: 28.0, rate: 160.0, jobWork: 0.8, hook: undefined, clips: undefined, printing: undefined, printPrice: undefined, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'ARP-14"', colour: 'PP : BLACK', quoted: undefined, procurement: 'trade', gram: 35.0, rate: 70.0, jobWork: 0.9, hook: undefined, clips: 1.2, printing: undefined, printPrice: undefined, packing: 0.15 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'MAU-35', colour: 'PP : NATURAL', quoted: undefined, procurement: 'manufacture', gram: 18.0, rate: 160.0, jobWork: 0.7, hook: 0.7, clips: undefined, printing: undefined, printPrice: undefined, packing: 0.15 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'MKB-17', colour: 'PP : WHITE', quoted: undefined, procurement: 'manufacture', gram: 27.5, rate: 160.0, jobWork: 0.8, hook: undefined, clips: 1.35, printing: undefined, printPrice: undefined, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'MKB-23', colour: 'PP : WHITE', quoted: undefined, procurement: 'manufacture', gram: 32.0, rate: 160.0, jobWork: 0.8, hook: undefined, clips: 1.35, printing: undefined, printPrice: undefined, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'FCP-25', colour: 'PP : NATURAL', quoted: undefined, procurement: 'manufacture', gram: 31.0, rate: 160.0, jobWork: 1.4, hook: undefined, clips: undefined, printing: undefined, printPrice: undefined, packing: 0.35 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'RMC-322', colour: 'HIPS : WHITE', quoted: undefined, procurement: 'manufacture', gram: 40.4, rate: 195.0, jobWork: 0.8, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'RMC-326', colour: 'HIPS : WHITE', quoted: undefined, procurement: 'manufacture', gram: 42.8, rate: 195.0, jobWork: 1.35, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.2 },
  { quote: 'NP/26-27/1', date: '01-Apr-2026', party: 'Yorker knit', model: 'RMC-326 A', colour: 'PP : NATURAL', quoted: undefined, procurement: 'manufacture', gram: 35.0, rate: 160.0, jobWork: 1.0, hook: undefined, clips: undefined, printing: undefined, printPrice: undefined, packing: 0.2 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'NCP-25', colour: 'PP : WHITE', quoted: 4.9, procurement: 'manufacture', gram: 13.5, rate: 160.0, jobWork: 0.7, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.1 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'NCP-27', colour: 'PP : WHITE', quoted: 5.0, procurement: 'manufacture', gram: 13.5, rate: 160.0, jobWork: 0.7, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.1 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'NCP-30', colour: 'PP : WHITE', quoted: 5.3, procurement: 'manufacture', gram: 20.0, rate: 160.0, jobWork: 0.7, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.15 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'PB-224 (Twin Hanger)', colour: 'PP : WHITE', quoted: 5.6, procurement: 'manufacture', gram: 18.0, rate: 160.0, jobWork: 0.7, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.15 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'CB-802', colour: 'PP : WHITE', quoted: 6.2, procurement: 'manufacture', gram: 17.0, rate: 160.0, jobWork: 0.75, hook: undefined, clips: 1.2, printing: '1 COLOUR', printPrice: 0.5, packing: 0.15 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'PBH-05B', colour: 'PP : WHITE', quoted: 6.9, procurement: 'manufacture', gram: 19.0, rate: 160.0, jobWork: 1.0, hook: undefined, clips: undefined, printing: '1 COLOUR', printPrice: 0.5, packing: 0.15 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'TP-125A', colour: 'HIPS : PRIME BLACK', quoted: undefined, procurement: 'manufacture', gram: 19.0, rate: 90.0, jobWork: 0.75, hook: undefined, clips: undefined, printing: undefined, printPrice: undefined, packing: 0.15 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'RKT-40', colour: 'HIPS : BLACK', quoted: undefined, procurement: 'manufacture', gram: 42.8, rate: 75.0, jobWork: 2.7, hook: 0.7, clips: 1.2, printing: undefined, printPrice: undefined, packing: 0.25 },
  { quote: 'NP/26-27/2', date: '03-Apr-2026', party: 'Samara Exports', model: 'D-23', colour: '', quoted: undefined, procurement: 'manufacture', gram: 16.6, rate: undefined, jobWork: 0.65, hook: 0.7, clips: undefined, printing: undefined, printPrice: undefined, packing: 0.1 },
];

/** The catalogue behind those rows, one entry per distinct model. */
export const SHEET_PRODUCTS = [
  {
    'modelCode': 'MAU-35 WB',
    'category': 'shirt',
    'sizeMm': 350,
    'material': 'pp',
    'standardWeightGrams': 30.0,
    'colour': 'White',
    'procurement': 'trade'
  },
  {
    'modelCode': 'CRF-30',
    'category': 'shirt',
    'sizeMm': 300,
    'material': 'pp',
    'standardWeightGrams': 13.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'CRF-25 WB',
    'category': 'shirt',
    'sizeMm': 250,
    'material': 'pp',
    'standardWeightGrams': 19.0,
    'colour': 'White',
    'procurement': 'trade'
  },
  {
    'modelCode': 'CRF-30 WB',
    'category': 'shirt',
    'sizeMm': 300,
    'material': 'pp',
    'standardWeightGrams': 18.0,
    'colour': 'White',
    'procurement': 'trade'
  },
  {
    'modelCode': 'RW-236',
    'category': 'suit',
    'sizeMm': 236,
    'material': 'hips',
    'standardWeightGrams': 47.5,
    'colour': 'Prime Black',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'CRF-40 WB',
    'category': 'shirt',
    'sizeMm': 400,
    'material': 'pp',
    'standardWeightGrams': 28.0,
    'colour': 'White',
    'procurement': 'trade'
  },
  {
    'modelCode': 'AR-8\'',
    'category': 'trouser',
    'sizeMm': 203,
    'material': 'pp',
    'standardWeightGrams': 15.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'WM-230',
    'category': 'shirt',
    'sizeMm': 230,
    'material': 'pp',
    'standardWeightGrams': 28.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'ARP-14\'',
    'category': 'trouser',
    'sizeMm': 356,
    'material': 'pp',
    'standardWeightGrams': 35.0,
    'colour': 'Black',
    'procurement': 'trade'
  },
  {
    'modelCode': 'MAU-35',
    'category': 'shirt',
    'sizeMm': 350,
    'material': 'pp',
    'standardWeightGrams': 18.0,
    'colour': 'Natural',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'MKB-17',
    'category': 'multi',
    'sizeMm': 170,
    'material': 'pp',
    'standardWeightGrams': 27.5,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'MKB-23',
    'category': 'multi',
    'sizeMm': 230,
    'material': 'pp',
    'standardWeightGrams': 32.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'FCP-25',
    'category': 'skirt',
    'sizeMm': 250,
    'material': 'pp',
    'standardWeightGrams': 31.0,
    'colour': 'Natural',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'RMC-322',
    'category': 'suit',
    'sizeMm': 322,
    'material': 'hips',
    'standardWeightGrams': 40.4,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'RMC-326',
    'category': 'suit',
    'sizeMm': 326,
    'material': 'hips',
    'standardWeightGrams': 42.8,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'RMC-326 A',
    'category': 'suit',
    'sizeMm': 326,
    'material': 'pp',
    'standardWeightGrams': 35.0,
    'colour': 'Natural',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'NCP-25',
    'category': 'shirt',
    'sizeMm': 250,
    'material': 'pp',
    'standardWeightGrams': 13.5,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'NCP-27',
    'category': 'shirt',
    'sizeMm': 270,
    'material': 'pp',
    'standardWeightGrams': 13.5,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'NCP-30',
    'category': 'shirt',
    'sizeMm': 300,
    'material': 'pp',
    'standardWeightGrams': 20.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'PB-224 (Twin Hanger)',
    'category': 'kids',
    'sizeMm': 224,
    'material': 'pp',
    'standardWeightGrams': 18.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'CB-802',
    'category': 'shirt',
    'sizeMm': 802,
    'material': 'pp',
    'standardWeightGrams': 17.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'PBH-05B',
    'category': 'kids',
    'sizeMm': 50,
    'material': 'pp',
    'standardWeightGrams': 19.0,
    'colour': 'White',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'TP-125A',
    'category': 'accessory',
    'sizeMm': 125,
    'material': 'hips',
    'standardWeightGrams': 19.0,
    'colour': 'Prime Black',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'RKT-40',
    'category': 'multi',
    'sizeMm': 400,
    'material': 'hips',
    'standardWeightGrams': 42.8,
    'colour': 'Black',
    'procurement': 'manufacture'
  },
  {
    'modelCode': 'D-23',
    'category': 'accessory',
    'sizeMm': 230,
    'material': 'pp',
    'standardWeightGrams': 16.6,
    'colour': 'White',
    'procurement': 'manufacture'
  }
];
