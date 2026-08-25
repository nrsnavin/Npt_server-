/**
 * Seeds a demo dataset for a hanger manufacturing business:
 * users, warehouses, suppliers, raw materials, hanger SKUs, BOMs, opening stock,
 * leads, customers and a quotation -> sales order -> production -> invoice flow.
 *
 * Usage: npm run seed
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import User from '../models/User.js';
import Warehouse from '../models/Warehouse.js';
import Supplier from '../models/Supplier.js';
import Material from '../models/Material.js';
import Product from '../models/Product.js';
import Bom from '../models/Bom.js';
import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import ProductionOrder from '../models/ProductionOrder.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Invoice from '../models/Invoice.js';
import Payment from '../models/Payment.js';
import Stock from '../models/Stock.js';
import StockMovement from '../models/StockMovement.js';
import Counter from '../models/Counter.js';
import { calculateTotals } from '../utils/money.js';
import { nextNumber } from '../services/numbering.service.js';
import { postMovement } from '../services/inventory.service.js';

const daysFromNow = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

async function clearAll() {
  await Promise.all(
    [
      User,
      Warehouse,
      Supplier,
      Material,
      Product,
      Bom,
      Customer,
      Lead,
      Quotation,
      SalesOrder,
      ProductionOrder,
      PurchaseOrder,
      Invoice,
      Payment,
      Stock,
      StockMovement,
      Counter,
    ].map((model) => model.deleteMany({}))
  );
}

async function seed() {
  await connectDatabase();
  console.log('Connected. Clearing existing data...');
  await clearAll();

  const users = await User.create([
    { name: 'Navin R', email: 'admin@npthangers.com', password: 'Admin@12345', role: 'admin' },
    { name: 'Priya Sales', email: 'sales@npthangers.com', password: 'Sales@12345', role: 'sales' },
    { name: 'Ramesh Plant', email: 'production@npthangers.com', password: 'Prod@123456', role: 'production' },
    { name: 'Anita Stores', email: 'stores@npthangers.com', password: 'Store@12345', role: 'inventory' },
    { name: 'Kiran Accounts', email: 'accounts@npthangers.com', password: 'Accts@12345', role: 'accounts' },
  ]);
  const [admin, salesUser, productionUser, storesUser] = users;

  const [rawStore, finishedStore, scrapStore] = await Warehouse.create([
    { code: 'RM-01', name: 'Raw Material Store', type: 'raw_material', address: 'Plant 1, Coimbatore' },
    { code: 'FG-01', name: 'Finished Goods Store', type: 'finished_goods', address: 'Plant 1, Coimbatore' },
    { code: 'SC-01', name: 'Scrap Yard', type: 'scrap', address: 'Plant 1, Coimbatore' },
  ]);

  const suppliers = await Supplier.create([
    {
      code: 'SUP001',
      name: 'Southern Polymers Pvt Ltd',
      category: 'resin',
      gstin: '33AABCS1429B1ZP',
      email: 'sales@southernpolymers.in',
      phone: '+91 98400 11223',
      contactPerson: 'Mahesh Kumar',
      leadTimeDays: 10,
      rating: 4,
    },
    {
      code: 'SUP002',
      name: 'Bharat Wire Industries',
      category: 'metal',
      gstin: '33AACCB7788K1Z2',
      email: 'orders@bharatwire.in',
      phone: '+91 99620 44556',
      contactPerson: 'Sunil Jain',
      leadTimeDays: 7,
      rating: 5,
    },
    {
      code: 'SUP003',
      name: 'Colourtech Masterbatch',
      category: 'paint',
      email: 'info@colourtech.co.in',
      phone: '+91 90031 77889',
      leadTimeDays: 5,
      rating: 3,
    },
    {
      code: 'SUP004',
      name: 'PackWell Cartons',
      category: 'packaging',
      email: 'sales@packwell.in',
      phone: '+91 94430 55667',
      leadTimeDays: 4,
      rating: 4,
    },
  ]);

  const materials = await Material.create([
    { code: 'RM-PP-001', name: 'Polypropylene Granules (Injection Grade)', category: 'resin', uom: 'kg', standardCost: 118, reorderLevel: 500, reorderQuantity: 2000, preferredSupplier: suppliers[0]._id },
    { code: 'RM-PS-002', name: 'HIPS Granules', category: 'resin', uom: 'kg', standardCost: 132, reorderLevel: 300, reorderQuantity: 1000, preferredSupplier: suppliers[0]._id },
    { code: 'RM-MB-003', name: 'Black Masterbatch', category: 'masterbatch', uom: 'kg', standardCost: 210, reorderLevel: 50, reorderQuantity: 200, preferredSupplier: suppliers[2]._id },
    { code: 'RM-MB-004', name: 'White Masterbatch', category: 'masterbatch', uom: 'kg', standardCost: 205, reorderLevel: 50, reorderQuantity: 200, preferredSupplier: suppliers[2]._id },
    { code: 'RM-WR-005', name: 'Galvanised Steel Hook Wire 2.3mm', category: 'metal_wire', uom: 'kg', standardCost: 96, reorderLevel: 200, reorderQuantity: 800, preferredSupplier: suppliers[1]._id },
    { code: 'RM-WD-006', name: 'Seasoned Beech Wood Blank', category: 'wood', uom: 'pcs', standardCost: 34, reorderLevel: 1000, reorderQuantity: 5000 },
    { code: 'RM-FL-007', name: 'Velvet Flocking Powder', category: 'flocking', uom: 'kg', standardCost: 380, reorderLevel: 40, reorderQuantity: 150 },
    { code: 'RM-PK-008', name: 'Corrugated Carton 5-Ply', category: 'packaging', uom: 'pcs', standardCost: 42, reorderLevel: 500, reorderQuantity: 2000, preferredSupplier: suppliers[3]._id },
  ]);
  const [pp, hips, blackMb, whiteMb, wire, wood, flock, carton] = materials;

  const products = await Product.create([
    { sku: 'HNG-SHT-380-BLK', name: 'Shirt Hanger 380mm Black', hangerType: 'shirt', material: 'plastic', sizeMm: 380, color: 'Black', finish: 'glossy', weightGrams: 42, hookType: 'metal_swivel', moldNumber: 'M-101', cavitiesPerCycle: 8, cycleTimeSeconds: 28, unitPrice: 11.5, standardCost: 6.8, reorderLevel: 5000, packSize: 100 },
    { sku: 'HNG-SHT-400-WHT', name: 'Shirt Hanger 400mm White', hangerType: 'shirt', material: 'plastic', sizeMm: 400, color: 'White', finish: 'glossy', weightGrams: 46, hookType: 'metal_swivel', moldNumber: 'M-102', cavitiesPerCycle: 8, cycleTimeSeconds: 30, unitPrice: 12.4, standardCost: 7.2, reorderLevel: 5000, packSize: 100 },
    { sku: 'HNG-TRS-330-BLK', name: 'Trouser Clip Hanger 330mm Black', hangerType: 'trouser', material: 'plastic', sizeMm: 330, color: 'Black', finish: 'matte', weightGrams: 55, hookType: 'swivel', moldNumber: 'M-201', cavitiesPerCycle: 4, cycleTimeSeconds: 34, unitPrice: 16.8, standardCost: 9.9, reorderLevel: 3000, packSize: 50 },
    { sku: 'HNG-KID-280-AST', name: 'Kids Hanger 280mm Assorted', hangerType: 'kids', material: 'plastic', sizeMm: 280, color: 'Assorted', finish: 'glossy', weightGrams: 24, hookType: 'fixed', moldNumber: 'M-301', cavitiesPerCycle: 12, cycleTimeSeconds: 22, unitPrice: 7.2, standardCost: 4.1, reorderLevel: 8000, packSize: 200 },
    { sku: 'HNG-SUT-440-WD', name: 'Suit Hanger 440mm Wooden', hangerType: 'suit', material: 'wood', sizeMm: 440, color: 'Walnut', finish: 'natural', weightGrams: 210, hookType: 'metal_swivel', cavitiesPerCycle: 1, cycleTimeSeconds: 120, unitPrice: 96, standardCost: 58, reorderLevel: 800, packSize: 25 },
    { sku: 'HNG-LNG-360-VLV', name: 'Velvet Slim Hanger 360mm', hangerType: 'lingerie', material: 'velvet', sizeMm: 360, color: 'Grey', finish: 'flocked', weightGrams: 38, hookType: 'metal_swivel', moldNumber: 'M-401', cavitiesPerCycle: 6, cycleTimeSeconds: 32, unitPrice: 24.5, standardCost: 14.6, reorderLevel: 2000, packSize: 50 },
  ]);
  const [shirtBlack, shirtWhite, trouser, kids, suitWood, velvet] = products;

  await Bom.create([
    { product: shirtBlack._id, version: 1, machine: 'Injection Press 150T', labourMinutesPerUnit: 0.12, overheadPerUnit: 0.9, components: [
      { material: pp._id, quantityPerUnit: 0.042, uom: 'kg', scrapPercent: 3 },
      { material: blackMb._id, quantityPerUnit: 0.0009, uom: 'kg', scrapPercent: 2 },
      { material: wire._id, quantityPerUnit: 0.006, uom: 'kg', scrapPercent: 1.5 },
      { material: carton._id, quantityPerUnit: 0.01, uom: 'pcs', scrapPercent: 0 },
    ] },
    { product: shirtWhite._id, version: 1, machine: 'Injection Press 150T', labourMinutesPerUnit: 0.13, overheadPerUnit: 0.95, components: [
      { material: pp._id, quantityPerUnit: 0.046, uom: 'kg', scrapPercent: 3 },
      { material: whiteMb._id, quantityPerUnit: 0.001, uom: 'kg', scrapPercent: 2 },
      { material: wire._id, quantityPerUnit: 0.006, uom: 'kg', scrapPercent: 1.5 },
      { material: carton._id, quantityPerUnit: 0.01, uom: 'pcs', scrapPercent: 0 },
    ] },
    { product: trouser._id, version: 1, machine: 'Injection Press 200T', labourMinutesPerUnit: 0.2, overheadPerUnit: 1.4, components: [
      { material: hips._id, quantityPerUnit: 0.055, uom: 'kg', scrapPercent: 4 },
      { material: blackMb._id, quantityPerUnit: 0.0011, uom: 'kg', scrapPercent: 2 },
      { material: wire._id, quantityPerUnit: 0.008, uom: 'kg', scrapPercent: 1.5 },
      { material: carton._id, quantityPerUnit: 0.02, uom: 'pcs', scrapPercent: 0 },
    ] },
    { product: kids._id, version: 1, machine: 'Injection Press 120T', labourMinutesPerUnit: 0.09, overheadPerUnit: 0.6, components: [
      { material: pp._id, quantityPerUnit: 0.024, uom: 'kg', scrapPercent: 3 },
      { material: carton._id, quantityPerUnit: 0.005, uom: 'pcs', scrapPercent: 0 },
    ] },
    { product: suitWood._id, version: 1, machine: 'Wood Line 1', labourMinutesPerUnit: 4.5, overheadPerUnit: 6, components: [
      { material: wood._id, quantityPerUnit: 1, uom: 'pcs', scrapPercent: 5 },
      { material: wire._id, quantityPerUnit: 0.012, uom: 'kg', scrapPercent: 1.5 },
      { material: carton._id, quantityPerUnit: 0.04, uom: 'pcs', scrapPercent: 0 },
    ] },
    { product: velvet._id, version: 1, machine: 'Injection Press 150T + Flocking', labourMinutesPerUnit: 0.8, overheadPerUnit: 2.2, components: [
      { material: hips._id, quantityPerUnit: 0.038, uom: 'kg', scrapPercent: 3 },
      { material: flock._id, quantityPerUnit: 0.004, uom: 'kg', scrapPercent: 6 },
      { material: wire._id, quantityPerUnit: 0.006, uom: 'kg', scrapPercent: 1.5 },
      { material: carton._id, quantityPerUnit: 0.02, uom: 'pcs', scrapPercent: 0 },
    ] },
  ]);

  console.log('Booking opening stock...');
  const openingMaterials = [
    [pp, 3200, 118],
    [hips, 1400, 132],
    [blackMb, 180, 210],
    [whiteMb, 140, 205],
    [wire, 620, 96],
    [wood, 4200, 34],
    [flock, 55, 380],
    [carton, 1800, 42],
  ];
  for (const [material, quantity, cost] of openingMaterials) {
    await postMovement({
      itemType: 'Material',
      item: material._id,
      warehouse: rawStore._id,
      quantity,
      type: 'adjustment',
      unitCost: cost,
      remarks: 'Opening stock',
      createdBy: storesUser._id,
    });
  }

  const openingProducts = [
    [shirtBlack, 12000],
    [shirtWhite, 9500],
    [trouser, 2400],
    [kids, 6200],
    [suitWood, 450],
    [velvet, 1800],
  ];
  for (const [product, quantity] of openingProducts) {
    await postMovement({
      itemType: 'Product',
      item: product._id,
      warehouse: finishedStore._id,
      quantity,
      type: 'adjustment',
      unitCost: product.standardCost,
      remarks: 'Opening stock',
      createdBy: storesUser._id,
    });
  }

  const customers = await Customer.create([
    { code: 'CUST001', name: 'Trendline Retail India Ltd', segment: 'retail_chain', gstin: '33AAACT1234C1Z5', email: 'purchase@trendline.in', phone: '+91 98410 22334', creditLimit: 1500000, paymentTermsDays: 45, owner: salesUser._id, addresses: [{ label: 'Billing', line1: 'No 42, Anna Salai', city: 'Chennai', state: 'Tamil Nadu', pincode: '600002' }], contacts: [{ name: 'Deepa Menon', designation: 'Category Buyer', email: 'deepa@trendline.in', phone: '+91 98410 22334', isPrimary: true }], tags: ['key_account'] },
    { code: 'CUST002', name: 'Sunrise Garment Exports', segment: 'garment_exporter', gstin: '33AAECS9876J1Z8', email: 'ops@sunriseexports.com', phone: '+91 99522 66778', creditLimit: 900000, paymentTermsDays: 30, owner: salesUser._id, addresses: [{ label: 'Billing', line1: 'SIDCO Industrial Estate', city: 'Tiruppur', state: 'Tamil Nadu', pincode: '641604' }], contacts: [{ name: 'Arun Prakash', designation: 'Sourcing Head', email: 'arun@sunriseexports.com', isPrimary: true }] },
    { code: 'CUST003', name: 'Metro Wholesale Distributors', segment: 'distributor', gstin: '29AAFCM4321L1ZQ', email: 'orders@metrowholesale.in', phone: '+91 80505 33445', creditLimit: 600000, paymentTermsDays: 30, owner: salesUser._id, addresses: [{ label: 'Billing', line1: 'Peenya 2nd Stage', city: 'Bengaluru', state: 'Karnataka', pincode: '560058' }] },
    { code: 'CUST004', name: 'Bella Boutique Chain', segment: 'boutique', email: 'admin@bellaboutique.in', phone: '+91 97890 11002', creditLimit: 250000, paymentTermsDays: 15, owner: salesUser._id },
  ]);

  await Lead.create([
    { company: 'Urban Threads Pvt Ltd', contactName: 'Sneha Iyer', email: 'sneha@urbanthreads.in', phone: '+91 90000 12345', city: 'Mumbai', source: 'trade_show', stage: 'qualified', estimatedValue: 850000, estimatedMonthlyVolume: 60000, expectedCloseDate: daysFromNow(25), owner: salesUser._id, interestedIn: [shirtBlack._id, velvet._id], activities: [{ type: 'meeting', summary: 'Met at Garment Tech Expo, shared velvet hanger samples', createdBy: salesUser._id }] },
    { company: 'Fabindia Sourcing Cell', contactName: 'Rahul Verma', email: 'rahul.v@sourcing.example', phone: '+91 90000 55667', city: 'Delhi', source: 'referral', stage: 'contacted', estimatedValue: 1200000, estimatedMonthlyVolume: 90000, expectedCloseDate: daysFromNow(45), owner: salesUser._id },
    { company: 'Coastal Apparels', contactName: 'Nithya Rao', email: 'nithya@coastalapparels.in', city: 'Kochi', source: 'website', stage: 'new', estimatedValue: 320000, estimatedMonthlyVolume: 25000, owner: salesUser._id },
    { company: 'ShopEase Marketplace', contactName: 'Vikram Shah', email: 'vikram@shopease.example', city: 'Ahmedabad', source: 'marketplace', stage: 'quoted', estimatedValue: 480000, estimatedMonthlyVolume: 40000, expectedCloseDate: daysFromNow(12), owner: salesUser._id },
    { company: 'Northline Uniforms', contactName: 'Gurpreet Singh', email: 'gs@northline.example', city: 'Ludhiana', source: 'cold_call', stage: 'lost', estimatedValue: 200000, lostReason: 'Price higher than incumbent supplier', owner: salesUser._id },
  ]);

  console.log('Creating sample transactions...');
  const quoteLines = calculateTotals([
    { product: shirtBlack._id, quantity: 40000, unitPrice: 11.2, taxPercent: 18 },
    { product: trouser._id, quantity: 8000, unitPrice: 16.4, discountPercent: 2, taxPercent: 18 },
  ]);
  const quotation = await Quotation.create({
    number: await nextNumber('QUO'),
    customer: customers[0]._id,
    quotationDate: new Date(),
    validUntil: daysFromNow(21),
    lines: quoteLines.lines,
    subtotal: quoteLines.subtotal,
    discountTotal: quoteLines.discountTotal,
    taxTotal: quoteLines.taxTotal,
    grandTotal: quoteLines.grandTotal,
    status: 'accepted',
    owner: salesUser._id,
    terms: '50% advance, balance against delivery. Prices ex-works Coimbatore.',
  });

  const orderLines = calculateTotals([
    { product: shirtWhite._id, quantity: 25000, unitPrice: 12.4, taxPercent: 18 },
    { product: kids._id, quantity: 30000, unitPrice: 7.2, discountPercent: 3, taxPercent: 18 },
  ]);
  const salesOrder = await SalesOrder.create({
    number: await nextNumber('SO'),
    customer: customers[1]._id,
    customerPoNumber: 'SGE/PO/2026/0431',
    orderDate: new Date(),
    deliveryDate: daysFromNow(18),
    lines: orderLines.lines,
    subtotal: orderLines.subtotal,
    discountTotal: orderLines.discountTotal,
    taxTotal: orderLines.taxTotal,
    grandTotal: orderLines.grandTotal,
    status: 'in_production',
    priority: 'high',
    owner: salesUser._id,
  });

  const shirtWhiteBom = await Bom.findOne({ product: shirtWhite._id });
  await ProductionOrder.create({
    number: await nextNumber('PRD'),
    product: shirtWhite._id,
    bom: shirtWhiteBom._id,
    salesOrder: salesOrder._id,
    quantityPlanned: 16000,
    machine: 'Injection Press 150T',
    shift: 'A',
    plannedStart: new Date(),
    plannedEnd: daysFromNow(6),
    status: 'planned',
    supervisor: productionUser._id,
    materials: shirtWhiteBom.components.map((component) => ({
      material: component.material,
      quantityRequired: component.quantityPerUnit * 16000 * (1 + component.scrapPercent / 100),
      uom: component.uom,
    })),
  });

  const poLines = calculateTotals([
    { material: pp._id, quantity: 2000, unitPrice: 118, taxPercent: 18 },
    { material: blackMb._id, quantity: 200, unitPrice: 210, taxPercent: 18 },
  ]);
  await PurchaseOrder.create({
    number: await nextNumber('PO'),
    supplier: suppliers[0]._id,
    orderDate: new Date(),
    expectedDate: daysFromNow(10),
    warehouse: rawStore._id,
    lines: poLines.lines,
    subtotal: poLines.subtotal,
    discountTotal: poLines.discountTotal,
    taxTotal: poLines.taxTotal,
    grandTotal: poLines.grandTotal,
    status: 'sent',
    createdBy: storesUser._id,
  });

  const invoiceLines = calculateTotals([
    { product: shirtBlack._id, quantity: 15000, unitPrice: 11.5, taxPercent: 18 },
  ]);
  const invoice = await Invoice.create({
    number: await nextNumber('INV'),
    customer: customers[2]._id,
    invoiceDate: daysFromNow(-40),
    dueDate: daysFromNow(-10),
    lines: invoiceLines.lines,
    subtotal: invoiceLines.subtotal,
    discountTotal: invoiceLines.discountTotal,
    taxTotal: invoiceLines.taxTotal,
    grandTotal: invoiceLines.grandTotal,
    amountPaid: 100000,
    status: 'partially_paid',
    placeOfSupply: 'Karnataka',
    createdBy: admin._id,
  });

  await Payment.create({
    number: await nextNumber('PAY'),
    customer: customers[2]._id,
    invoice: invoice._id,
    amount: 100000,
    paymentDate: daysFromNow(-20),
    mode: 'bank_transfer',
    referenceNumber: 'NEFT-88213345',
    createdBy: admin._id,
  });

  await Customer.findByIdAndUpdate(customers[2]._id, {
    outstandingAmount: invoice.grandTotal - invoice.amountPaid,
  });

  console.log('\nSeed complete. Sign in with:');
  console.log('  admin@npthangers.com      / Admin@12345   (admin)');
  console.log('  sales@npthangers.com      / Sales@12345   (sales)');
  console.log('  production@npthangers.com / Prod@123456   (production)');
  console.log('  stores@npthangers.com     / Store@12345   (inventory)');
  console.log('  accounts@npthangers.com   / Accts@12345   (accounts)');
  console.log(`\nScrap warehouse ready: ${scrapStore.code}`);

  await disconnectDatabase();
}

seed().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.connection.close();
  process.exit(1);
});
