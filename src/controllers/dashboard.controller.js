import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import SalesOrder from '../models/SalesOrder.js';
import ProductionOrder from '../models/ProductionOrder.js';
import Invoice from '../models/Invoice.js';
import Stock from '../models/Stock.js';
import Product from '../models/Product.js';
import asyncHandler from '../utils/asyncHandler.js';
import { round2 } from '../utils/money.js';

const startOfMonth = () => {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

/** Headline numbers for the landing dashboard. */
export const summary = asyncHandler(async (_req, res) => {
  const monthStart = startOfMonth();

  const [
    customers,
    openLeads,
    openOrders,
    monthSales,
    receivables,
    activeProduction,
    stockValue,
  ] = await Promise.all([
    Customer.countDocuments({ status: 'active' }),
    Lead.countDocuments({ stage: { $nin: ['won', 'lost'] } }),
    SalesOrder.countDocuments({ status: { $nin: ['closed', 'cancelled', 'dispatched'] } }),
    SalesOrder.aggregate([
      { $match: { orderDate: { $gte: monthStart }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, value: { $sum: '$grandTotal' }, orders: { $sum: 1 } } },
    ]),
    Invoice.aggregate([
      { $match: { status: { $in: ['unpaid', 'partially_paid'] } } },
      { $group: { _id: null, due: { $sum: { $subtract: ['$grandTotal', '$amountPaid'] } } } },
    ]),
    ProductionOrder.countDocuments({ status: { $in: ['planned', 'released', 'in_progress'] } }),
    Stock.aggregate([
      { $group: { _id: null, value: { $sum: { $multiply: ['$quantity', '$averageCost'] } } } },
    ]),
  ]);

  res.json({
    success: true,
    data: {
      activeCustomers: customers,
      openLeads,
      openSalesOrders: openOrders,
      salesThisMonth: round2(monthSales[0]?.value || 0),
      ordersThisMonth: monthSales[0]?.orders || 0,
      receivables: round2(receivables[0]?.due || 0),
      activeProductionOrders: activeProduction,
      stockValue: round2(stockValue[0]?.value || 0),
    },
  });
});

/** Monthly booked order value for the last N months (default 6). */
export const salesTrend = asyncHandler(async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const from = new Date();
  from.setMonth(from.getMonth() - (months - 1));
  from.setDate(1);
  from.setHours(0, 0, 0, 0);

  const rows = await SalesOrder.aggregate([
    { $match: { orderDate: { $gte: from }, status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: { year: { $year: '$orderDate' }, month: { $month: '$orderDate' } },
        value: { $sum: '$grandTotal' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const byKey = new Map(rows.map((row) => [`${row._id.year}-${row._id.month}`, row]));
  const data = [];

  for (let index = 0; index < months; index += 1) {
    const cursor = new Date(from.getFullYear(), from.getMonth() + index, 1);
    const key = `${cursor.getFullYear()}-${cursor.getMonth() + 1}`;
    const row = byKey.get(key);
    data.push({
      month: cursor.toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
      value: round2(row?.value || 0),
      orders: row?.orders || 0,
    });
  }

  res.json({ success: true, data });
});

/** Best selling hanger SKUs by ordered value. */
export const topProducts = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);

  const rows = await SalesOrder.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.product',
        quantity: { $sum: '$lines.quantity' },
        value: { $sum: '$lines.lineTotal' },
      },
    },
    { $sort: { value: -1 } },
    { $limit: limit },
  ]);

  const products = await Product.find({ _id: { $in: rows.map((row) => row._id) } }).select(
    'sku name hangerType material color'
  );
  const productById = new Map(products.map((product) => [String(product._id), product]));

  res.json({
    success: true,
    data: rows.map((row) => ({
      product: productById.get(String(row._id)) || null,
      quantity: row.quantity,
      value: round2(row.value),
    })),
  });
});
