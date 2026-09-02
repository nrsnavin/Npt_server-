/**
 * Seeds one account per department, each with that department's default module access,
 * plus an admin. Enough to exercise sign-in, the profile and user administration.
 *
 * Usage: npm run seed
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import User from '../models/User.js';
import OtpToken from '../models/OtpToken.js';
import Todo from '../models/Todo.js';
import StickyNote from '../models/StickyNote.js';
import Announcement from '../models/Announcement.js';
import { defaultAccessFor, DEPARTMENTS } from '../config/modules.js';
import { seedPipeline } from './pipeline.js';
import { seedMoulds } from './moulds.js';
import { seedMaterials } from './materials.js';
import { seedComponents } from './components.js';
import { seedPricing } from './pricing.js';
import { seedRegisterCostings } from './registerCostings.js';

/** Dates relative to today, so the reminder feed always has something to show. */
const days = (offset, hour = 17) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/** One account per department, so every default grant set can be exercised. */
const PEOPLE = [
  { name: 'Navin R', email: 'admin@npthangers.com', password: 'Admin@12345', role: 'admin', department: 'management', phone: '9876500001' },
  { name: 'Nandhini S', email: 'marketing@npthangers.com', password: 'Mktg@123456', department: 'marketing', phone: '9876500002' },
  // A second marketing account, so the ownership rule [§29] is visible: neither of them
  // can open the other's customers or enquiries.
  { name: 'Arun K', email: 'marketing2@npthangers.com', password: 'Mktg@654321', department: 'marketing', phone: '9876500004' },
  { name: 'Meera Sampling', email: 'sampling@npthangers.com', password: 'Sample@1234', department: 'sampling', phone: '9876500003' },
  { name: 'Priya Orders', email: 'orders@npthangers.com', password: 'Orders@1234', department: 'order_confirmation', phone: '9876500005' },
  { name: 'Ramesh Plant', email: 'production@npthangers.com', password: 'Prod@123456', department: 'production', phone: '9876500006' },
  { name: 'Sunil Quality', email: 'quality@npthangers.com', password: 'Qual@123456', department: 'quality', phone: '9876500007' },
  { name: 'Anita Despatch', email: 'despatch@npthangers.com', password: 'Desp@123456', department: 'despatch', phone: '9876500008' },
  { name: 'Kiran Accounts', email: 'accounts@npthangers.com', password: 'Accts@12345', department: 'accounts', phone: '9876500009' },
];

async function seed() {
  await connectDatabase();
  console.log('Connected. Clearing existing data...');
  await Promise.all([
    User.deleteMany({}),
    OtpToken.deleteMany({}),
    Todo.deleteMany({}),
    StickyNote.deleteMany({}),
    Announcement.deleteMany({}),
  ]);

  const created = await User.create(
    PEOPLE.map((person) => ({
      ...person,
      role: person.role || 'member',
      emailVerified: true,
      // Admins need no grants; everyone else starts on their department's template.
      moduleAccess: person.role === 'admin' ? [] : defaultAccessFor(person.department),
    }))
  );

  const byEmail = Object.fromEntries(created.map((user) => [user.email, user]));
  const admin = byEmail['admin@npthangers.com'];
  const despatch = byEmail['despatch@npthangers.com'];

  console.log('Adding sample tasks, notes and announcements...');

  await Todo.create([
    // Deliberately spread across overdue, today and tomorrow so the reminder is populated.
    { user: admin._id, title: 'Approve velvet hanger sample for Trendline', dueDate: days(-2), priority: 'high' },
    { user: admin._id, title: 'Sign off October production plan', dueDate: days(-1), priority: 'high' },
    { user: admin._id, title: 'Review PP resin quotes from Southern Polymers', dueDate: days(0, 12), priority: 'high', notes: 'Compare against Bharat Wire landed cost.' },
    { user: admin._id, title: 'Call Sunrise Exports about the 25,000 pc order', dueDate: days(0, 16), priority: 'normal' },
    { user: admin._id, title: 'Check mould M-201 maintenance log', dueDate: days(0, 18), priority: 'normal' },
    { user: admin._id, title: 'Interview shift supervisor candidate', dueDate: days(1, 11), priority: 'normal' },
    { user: admin._id, title: 'Renew GRS certification paperwork', dueDate: days(6), priority: 'low' },
    { user: admin._id, title: 'Update hanger price list for Q4', priority: 'low', notes: 'No fixed date — pick up when the resin price settles.' },
    { user: admin._id, title: 'Send Diwali greetings to key buyers', dueDate: days(-4), priority: 'normal', completed: true, completedAt: days(-4) },
    { user: admin._id, title: 'Reconcile September despatch register', dueDate: days(-3), priority: 'normal', completed: true, completedAt: days(-3) },

    { user: despatch._id, title: 'Pack 12,000 shirt hangers for Metro Wholesale', dueDate: days(0, 14), priority: 'high' },
    { user: despatch._id, title: 'Book transport for Tiruppur delivery', dueDate: days(0, 15), priority: 'high' },
    { user: despatch._id, title: 'Print e-way bills for tomorrow', dueDate: days(1, 9), priority: 'normal' },
  ]);

  await StickyNote.create([
    { user: admin._id, content: 'Mould M-101 cycle time crept to 31s — ask Ramesh to check the cooling line.', colour: 'amber', pinned: true },
    { user: admin._id, content: 'Trendline wants matte finish on the 400mm white. Costing +₹0.40/pc.', colour: 'sky' },
    { user: admin._id, content: 'Bank: cheque book reorder before the 15th.', colour: 'lime' },
    { user: admin._id, content: 'Recycled PP supplier trial — 500kg sample arriving next week.', colour: 'violet' },
    { user: despatch._id, content: 'Carton stock low — 1,800 left, reorder at 500.', colour: 'rose', pinned: true },
  ]);

  await Announcement.create([
    {
      title: 'Plant shutdown for annual maintenance',
      body: 'Both moulding lines will be down from the 12th to the 14th for annual maintenance. Please plan despatch commitments around this and inform buyers with pending orders.',
      category: 'urgent',
      pinned: true,
      publishedAt: days(-1, 9),
      author: admin._id,
      readBy: [admin._id],
    },
    {
      title: 'GRS certification renewed for FY 2026-27',
      body: 'Our Global Recycled Standard certification has been renewed. Recycled PP hangers can continue to be quoted as GRS certified. Updated certificates are with the accounts team.',
      category: 'general',
      publishedAt: days(-3, 11),
      author: admin._id,
      readBy: [admin._id],
    },
    {
      title: 'New quality checklist for velvet hangers',
      body: 'A revised inspection checklist covering flocking coverage and hook alignment takes effect from Monday. Quality and production teams should review it before the next batch.',
      category: 'quality',
      departments: ['quality', 'production'],
      publishedAt: days(-4, 15),
      author: admin._id,
      readBy: [admin._id],
    },
    {
      title: 'Despatch cut-off moves to 4pm',
      body: 'From this week the daily despatch cut-off is 4pm instead of 5pm, to match the new transport pickup schedule. Anything after that ships the following morning.',
      category: 'production',
      departments: ['despatch', 'order_confirmation'],
      publishedAt: days(-6, 10),
      author: admin._id,
      readBy: [admin._id],
    },
    {
      title: 'Provident fund statements available',
      body: 'Annual PF statements for all staff are now available from the accounts department. Please collect yours before the end of the month.',
      category: 'people',
      publishedAt: days(-9, 12),
      author: admin._id,
      readBy: [admin._id],
    },
  ]);

  console.log('Adding the product master, customers, leads and enquiries...');
  const counts = await seedPipeline({
    nandhini: byEmail['marketing@npthangers.com'],
    arun: byEmail['marketing2@npthangers.com'],
    meera: byEmail['sampling@npthangers.com'],
  });

  console.log('Adding the material and mould registers...');
  const materials = await seedMaterials();
  const parts = await seedComponents();
  const moulds = await seedMoulds();

  console.log("Adding the costings and quotations from the plant's own 26-27 sheet...");
  const pricing = await seedPricing({
    admin: byEmail['admin@npthangers.com'],
    nandhini: byEmail['marketing@npthangers.com'],
  });

  /*
   * After `seedPricing`, which clears the collection — and after the registers, which these read.
   * The sheet's costings are transcribed figures against models with no tool; these are built the
   * way the app builds one, so a freshly seeded database actually shows the registers working.
   */
  console.log('Costing the moulded models off the registers...');
  const derived = await seedRegisterCostings({
    admin: byEmail['admin@npthangers.com'],
    nandhini: byEmail['marketing@npthangers.com'],
  });

  const labels = Object.fromEntries(DEPARTMENTS.map((d) => [d.key, d.label]));

  console.log('\nSeed complete. Sign in with a password:\n');
  for (const person of PEOPLE) {
    const grants = person.role === 'admin' ? 'all modules' : `${defaultAccessFor(person.department).length} modules`;
    console.log(
      `  ${person.email.padEnd(28)} ${person.password.padEnd(13)} ${(labels[person.department] || '').padEnd(26)} ${grants}`
    );
  }
  console.log('\n  Sample data: 13 tasks, 5 sticky notes, 5 announcements.');
  console.log(
    `  Phase 1: ${counts.products} products, ${counts.customers} customers, ` +
      `${counts.leads} leads, ${counts.enquiries} enquiries, ${counts.samples} samples.`
  );
  console.log(
    `  Materials: ${materials.materials} resins on the register — ${materials.uplifted} of them ` +
      `carrying a grammage uplift over PP.`
  );
  console.log(
    `  Parts: ${parts.hooks} hooks, ${parts.clips} clips and ${parts.prints} print jobs, ` +
      `all priced per piece.`
  );
  console.log(
    `  Moulds: ${moulds.moulds} tools on the register — runner is ${moulds.runnerShare}% of a ` +
      `shot on average, ${moulds.blocked} running short a cavity, ${moulds.customerOwned} owned ` +
      `by the customer.`
  );
  console.log(
    `  Phase 3: ${pricing.pricings} costings across ${pricing.productsAdded} more models, and ` +
      `the sheet's own ${pricing.quotations} quotations carrying ${pricing.quotedLines} lines ` +
      `between them — ${pricing.belowFloor} priced under their own floor, holding ` +
      `${pricing.heldForApproval} whole document(s) on §9 approval.`
  );
  console.log(
    `  Registers: ${derived.costings} more costings built off a mould and a resin — ` +
      `${derived.uplifted} of them in a resin heavier than PP. Heaviest is ` +
      `${derived.heaviest?.modelNumber} at ${derived.heaviest?.cost.gramWeight}g a piece.`
  );
  console.log('\nOr sign in with a code sent to any of those emails or phone numbers.');
  console.log('Without SMTP/Twilio configured the code is printed to the API console.');

  await disconnectDatabase();
}

seed().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.connection.close();
  process.exit(1);
});
