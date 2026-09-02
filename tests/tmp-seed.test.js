import test from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
process.env.JWT_SECRET = 'seed-check-secret-value-here';

test('seed', async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const { default: User } = await import('../src/models/User.js');
  const { seedPipeline } = await import('../src/seed/pipeline.js');
  const { seedMoulds } = await import('../src/seed/moulds.js');
  const { seedPricing } = await import('../src/seed/pricing.js');
  const { default: Quotation } = await import('../src/models/Quotation.js');
  const { renderQuotationPdf } = await import('../src/services/quotationPdf.js');
  const fs = await import('node:fs');

  const p = {};
  for (const [k, d] of [['nandhini','marketing'],['arun','marketing'],['meera','sampling'],['admin','management']]) {
    p[k] = await User.create({ name: k, email: `${k}@x.com`, password: 'Passw0rd@123', department: d, ...(k==='admin'?{role:'admin'}:{}), moduleAccess: [] });
  }
  await seedPipeline(p);
  await seedMoulds();
  const out = await seedPricing({ admin: p.admin, nandhini: p.nandhini });
  console.log('seedPricing:', JSON.stringify(out));

  for (const q of await Quotation.find().populate('customer','name').sort('number')) {
    console.log(`\n${q.number}  ${q.customer.name}  [${q.status}]  ${q.lines.length} lines  net ₹${q.netValue.toLocaleString('en-IN')}  total ₹${q.totalValue.toLocaleString('en-IN')}`);
    for (const l of q.lines) console.log(`   ${l.modelNumber.padEnd(22)} ${String(l.quantity).padStart(7)} × ₹${l.unitPrice}  = ₹${l.lineValue.toLocaleString('en-IN')}`);
  }

  const doc = await Quotation.findOne({ status: 'approval_pending' })
    .populate('customer','code name address city state gstin mobile email')
    .populate('assignedTo','name').populate('lines.product','modelCode name sizeMm material');
  const pdf = await renderQuotationPdf(doc);
  fs.writeFileSync('/tmp/claude-0/-home-user/e5903df5-8dfe-506d-a8f0-019393b8810c/scratchpad/quote.pdf', pdf);
  console.log('\nPDF bytes:', pdf.length, 'for', doc.number, `(${doc.lines.length} lines)`);

  await mongoose.connection.close();
  await mongo.stop();
});
