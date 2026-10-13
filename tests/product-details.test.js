/**
 * The product details the enquiry asks for only on a new development — category and packing
 * beside the hook and clip — travel onto the quotation's line, may be confirmed on the costing
 * sheet, and carry on to the sales order booked from it [controllers/quotation.controller.js
 * `linesForEnquiry`, validators/pricing.schemas.js, validators/order.schemas.js].
 *
 *   node --test tests/product-details.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { linesForEnquiry } from '../src/controllers/quotation.controller.js';
import { quotationCostSchema } from '../src/validators/pricing.schemas.js';
import { orderFromQuotationSchema } from '../src/validators/order.schemas.js';

const id = (n) => `${String(n).padStart(24, '0')}`;

test('an enquiry’s items become quotation lines with their category and packing', () => {
  const lines = linesForEnquiry({
    number: 'ENQ-1',
    items: [
      { mould: id(1), materialRef: id(2), hookRef: id(3), category: 'shirt', packing: '200 pcs per carton', colour: 'Black' },
      { modelNumber: 'NEW-1', isNewDevelopment: true, sizeMm: 420, category: 'trouser' },
    ],
  });
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].category, lines[0].packing, lines[0].hookRef], ['shirt', '200 pcs per carton', id(3)]);
  assert.deepEqual([lines[1].category, lines[1].packing], ['trouser', undefined]);
});

test('the costing sheet may fill or clear the category and packing', () => {
  const ok = quotationCostSchema.safeParse({ expectedUpdatedAt: new Date().toISOString(), category: 'shirt', packing: '200 pcs per carton' });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const cleared = quotationCostSchema.safeParse({ expectedUpdatedAt: new Date().toISOString(), category: null, packing: '' });
  assert.ok(cleared.success);
  const wrong = quotationCostSchema.safeParse({ expectedUpdatedAt: new Date().toISOString(), category: 'sock' });
  assert.equal(wrong.success, false);
});

test('booking from the quotation may say the category where the PO does', () => {
  const parsed = orderFromQuotationSchema.safeParse({
    lines: [{ quotationLine: id(9), quantity: 5000, category: 'kids', packing: '100 pcs' }],
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.lines[0].category, 'kids');
});
