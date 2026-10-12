/**
 * The price sheet onto the registers [services/mouldSheet.service.js, scripts/import-mould-sheet.js]:
 * Manufacture rows become moulds (30 s cycle by default), Trade rows bought-in items with their
 * build-up and an estimated inward price; photos come from the links — a folder link's zip
 * gives the picture named for the code — and a second run neither doubles a record nor fetches
 * a photo again.
 *
 *   node --test tests/mould-sheet-import.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'mould-sheet-import-test-secret';

let mongo;
let photoServer;
let base;
let sheet;
let Mould;
let TradedItem;
let Attachment;
let User;

/* A real enough JPEG: the magic bytes are what the importer reads. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);

/** A zip of the files given, deflated, with a central directory — what a Dropbox folder link sends. */
function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let fetched = 0;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: Mould } = await import('../src/models/Mould.js'));
  ({ default: TradedItem } = await import('../src/models/TradedItem.js'));
  ({ default: Attachment } = await import('../src/models/Attachment.js'));
  ({ default: User } = await import('../src/models/User.js'));
  const { default: Material } = await import('../src/models/Material.js');
  await Material.create({ name: 'PP Natural', type: 'pp', ratePerKg: 100 });

  const folder = zipOf({ 'MAU.jpg': PNG, 'MAUWB.jpg': JPEG, 'notes.txt': Buffer.from('x') });
  photoServer = createServer((req, res) => {
    fetched += 1;
    if (req.url.startsWith('/mau.jpeg')) return res.end(JPEG);
    if (req.url.startsWith('/folder')) return res.end(folder);
    if (req.url.startsWith('/page')) return res.end('<html>not a picture</html>');
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((resolve) => photoServer.listen(0, resolve));
  base = `http://127.0.0.1:${photoServer.address().port}`;
  sheet = [
    'CODE\tPHOTO LINK\tPHOTO\tTRADE / MANUFACTURE\tGRAMMAGE AS PP\tRUNNER GRAMMAGE\tJOB WORK COST\tPACKING COST\tCATEGORY\tHOOK\tCLIPS\tIP-14/2/26\t',
    `MAU-30\t${base}/mau.jpeg?dl=1\t\tTrade\t14\t2\t0.75\t0.1\t\t0.70\t\t\t`,
    `D-30\t${base}/mau.jpeg?dl=1\t\tManufacture\t14.5\t2\t0.70\t0.15\t\t0.70\t\tBhavni mould\t`,
    `MAU-30\t${base}/mau.jpeg?dl=1\t\tManufacture\t14\t2\t0.70\t0.1\t\t0.70\t\t\t`,
    `MAU-25 WB\t${base}/folder?dl=1\t\tTrade\t\t2\t0.70\t0.15\t\t0.70\t\t\t`,
    `B-31\t${base}/page?dl=1\t\tManufacture\t\t2\t0.75\t..2\t\t0.75\t1.65\t\t`,
    `TP-224\t\t\tManufacture\t22\t2\t0.70\t0.15\t\t\t\t\t`,
    'TP-224\t\t\tManufacture\t22\t1\t0.70\t0.15\t\t\t\t\t',
    '"RWP-330\n"\t\t\t\t\t\t\t\t\t\t\t\t',
  ].join('\n');
});

test.after(async () => {
  photoServer?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the bundled sheet reads: 402 rows, the scratch column and the IP note kept as notes', async () => {
  const { parseSheet, readSheet } = await import('../src/services/mouldSheet.service.js');
  const read = readSheet(parseSheet(readFileSync(new URL('../data/mould-sheet-ip-14-02-26.tsv', import.meta.url), 'utf8')));
  assert.equal(read.entries.length, 402);
  assert.equal(read.entries.filter((entry) => entry.supply === 'trade').length, 113);
  const d30 = read.entries.find((entry) => entry.code === 'D-30');
  assert.deepEqual(d30.notes, ['IP-14/2/26: Bhavni mould']);
  assert.equal(d30.numbers.partWeightGrams, 14.5);
  assert.equal(read.entries.find((entry) => entry.code === 'NMC-23').photoUrl.startsWith('https://www.dropbox.com/'), true, 'a code with a line break inside its cell');
});

test('Manufacture → moulds at 30 s, Trade → the trading master with its build-up and an estimated price; photos from the links', async () => {
  const { applySheet, parseSheet, planSheet, readSheet } = await import('../src/services/mouldSheet.service.js');
  const { photoFetcher } = await import('../src/services/recordPhoto.service.js');
  const by = await User.create({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', role: 'admin', department: 'management' });

  const plan = await planSheet(readSheet(parseSheet(sheet)).entries);
  const action = (code, register) => plan.find((entry) => entry.code === code && (!register || entry.register === register));
  assert.equal(action('MAU-30', 'traded').action, 'create');
  assert.equal(action('MAU-30', 'mould').action, 'create', 'the same code as Trade and Manufacture is on both registers');
  assert.match(action('MAU-30', 'mould').warnings.join(), /both Trade and Manufacture/);
  assert.equal(plan.filter((entry) => entry.code === 'TP-224')[1].action, 'skip', 'a second row for a code is not a second record');
  assert.equal(action('RWP-330').action, 'skip');
  assert.match(action('B-31').warnings.join(), /"\.\.2" read as 0\.2/);

  const result = await applySheet(plan, { by, ppRate: 100, fetchPhoto: photoFetcher() });
  assert.deepEqual(result.moulds, { created: 4, updated: 0 });
  assert.deepEqual(result.traded, { created: 2, updated: 0 });
  assert.equal(result.photos.added, 4);
  assert.deepEqual(result.photos.failed.map((miss) => [miss.code, miss.reason]), [['B-31', 'the link is not a picture']]);

  const d30 = await Mould.findOne({ mouldCode: 'D-30' }).populate('photo');
  assert.equal(d30.cycleTimeSeconds, 30);
  assert.equal(d30.partWeightGrams, 14.5);
  assert.equal(d30.hookCost, 0.7);
  assert.equal(d30.cavities, 1);
  assert.match(d30.notes, /Bhavni mould/);
  assert.equal(d30.photo.mimeType, 'image/jpeg');
  assert.equal(String(d30.photo.mould), String(d30._id));
  assert.equal((await Mould.findOne({ mouldCode: 'B-31' })).packingCost, 0.2);
  assert.equal((await Mould.findOne({ mouldCode: 'TP-224' })).runnerWeightGrams, 2, 'the first row wins');

  const traded = await TradedItem.findOne({ modelNumber: 'MAU-30' }).populate('photo');
  assert.equal(traded.buildUp.partWeightGrams, 14);
  assert.equal(traded.buildUp.jobWorkCost, 0.75);
  /* (14 + 2) g at ₹100/kg = 1.60, + 0.75 job + 0.70 hook + 0.10 packing. */
  assert.equal(traded.inwardPrice, 3.15);
  assert.match(traded.priceHistory[0].note, /Estimated from .* build-up at ₹100\/kg PP/);
  assert.equal(String(traded.photo.tradedItem), String(traded._id));

  const folder = await TradedItem.findOne({ modelNumber: 'MAU-25 WB' }).populate('photo');
  assert.equal(folder.photo.filename, 'MAUWB.jpg', 'the folder picture named for the family, not MAU.jpg');
  assert.equal(folder.photo.mimeType, 'image/jpeg');
});

test('running it again updates in place and fetches no photo twice', async () => {
  const { applySheet, parseSheet, planSheet, readSheet } = await import('../src/services/mouldSheet.service.js');
  const { photoFetcher } = await import('../src/services/recordPhoto.service.js');
  await Mould.updateOne({ mouldCode: 'D-30' }, { $set: { cycleTimeSeconds: 24 } });
  await TradedItem.updateOne({ modelNumber: 'MAU-30' }, { $set: { inwardPrice: 2.9 } });
  const before = fetched;
  const attachments = await Attachment.countDocuments();

  const plan = await planSheet(readSheet(parseSheet(sheet)).entries);
  const result = await applySheet(plan, { by: await User.findOne(), ppRate: 100, fetchPhoto: photoFetcher() });
  assert.deepEqual(result.moulds, { created: 0, updated: 4 });
  assert.deepEqual(result.traded, { created: 0, updated: 2 });
  assert.equal(result.photos.kept, 4);
  assert.equal(fetched - before, 1, 'only the link that failed is tried again');
  assert.equal(await Attachment.countDocuments(), attachments);
  assert.equal((await Mould.findOne({ mouldCode: 'D-30' })).cycleTimeSeconds, 24, 'the tool room’s cycle time stands');
  assert.equal((await TradedItem.findOne({ modelNumber: 'MAU-30' })).inwardPrice, 2.9, 'a price already set stands');
  assert.equal((await Mould.countDocuments()), 4);
});
