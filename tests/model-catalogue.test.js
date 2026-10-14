/**
 * Matching what a buyer wrote to the plant's model codes [services/modelCatalogue.service.js].
 *
 *   node --test tests/model-catalogue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asMatch, codeKey, exactly, shortlist, toRows } from '../src/services/modelCatalogue.service.js';
import { tidyModels } from '../src/services/buyerCard.llm.js';

const rows = toRows([
  { _id: 'a1', mouldCode: 'NCP-25', name: '25cm shirt hanger', category: 'shirt', sizeMm: 250 },
  { _id: 'a2', mouldCode: 'NCP-27', name: '27cm shirt hanger', category: 'shirt', sizeMm: 270 },
  { _id: 'a3', mouldCode: 'VS-450', name: '450mm velvet suit hanger', category: 'suit', sizeMm: 450 },
  { _id: 'a4', mouldCode: 'VS-400', name: '400mm velvet suit hanger', category: 'suit', sizeMm: 400 },
], [{ _id: 't1', modelNumber: 'MAU-35 WB', code: 'TR-MAU35', description: 'Wooden look trouser' }]);

test('a code is a code whatever the spacing, dashes or case', () => {
  assert.equal(codeKey('ncp - 25 b'), 'NCP25B');
  for (const asked of ['NCP-25', 'ncp 25', 'NCP25', 'ncp25 black', 'Ncp 25 white 5000 pcs']) {
    assert.equal(exactly(asked, rows)?.code, 'NCP-25', asked);
  }
  assert.equal(exactly('mau 35 wb', rows)?.code, 'MAU-35 WB', 'the trading master too');
  assert.equal(exactly('tr mau35', rows)?.code, 'MAU-35 WB', 'by its other code');
});

test('the digits must agree: a near code with another number is never offered', () => {
  const offered = shortlist('ncp 25', rows).map((entry) => entry.row.code);
  assert.deepEqual(offered, ['NCP-25']);
  assert.ok(!shortlist('velvet 450', rows).some((entry) => entry.row.code === 'VS-400'));
});

test('words that name no code outright are shortlisted for the model to choose from', () => {
  assert.equal(exactly('400mm velvet suit hanger', rows), null);
  assert.equal(shortlist('400mm velvet suit hanger', rows)[0].row.code, 'VS-400');
  assert.deepEqual(shortlist('XYZ-999', rows), [], 'nothing like it: nothing offered');
});

test('a match names its register: a tool, or a bought-in item', () => {
  assert.deepEqual(asMatch(rows.find((row) => row.code === 'NCP-25')), { code: 'NCP-25', mould: 'a1', name: '25cm shirt hanger' });
  assert.equal(asMatch(rows.find((row) => row.kind === 'traded')).tradedItem, 't1');
});

test('the models read are tidied: quantities in pieces, no repeats, ten at most', () => {
  const tidy = tidyModels([
    { asked: ' NCP 25 ', quantity: '5k', colour: 'Black' },
    { asked: 'ncp 25', quantity: '', colour: '' },
    { asked: '', quantity: '10', colour: '' },
    ...Array.from({ length: 12 }, (_, n) => ({ asked: `M-${n}`, quantity: '', colour: '' })),
  ]);
  assert.deepEqual(tidy[0], { asked: 'NCP 25', quantity: 5000, colour: 'Black' });
  assert.equal(tidy.length, 10);
});
