import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { CLOSED_STAGE } from '../config/enquiryStages.js';
import { marketingStatusLabel, marketingStatusOf } from '../config/marketingStatuses.js';
import { mayOpenCustomer, ownershipFilter } from '../services/ownership.service.js';
import { delegateCustomer, delegationTargets, mayDelegate } from '../services/delegation.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';

/**
 * The customer side panel [web: components/CustomerPanel.jsx] — opened from a row of the party
 * master, it raises department tasks for the buyer without opening anything else.
 *
 * One read gives it everything it shows: who the buyer is and how to reach them, the enquiries
 * still being worked (a task can go on one of them instead), the department tasks already open
 * for the buyer (so the same one is not raised twice), the buyer's own follow-up, and — for
 * Admin — who the buyer can be handed to.
 */

const OPEN_TASKS = 30;
const OPEN_ENQUIRIES = 20;

async function readableCustomer(req) {
  const customer = await Customer.findById(req.params.id).populate('assignedTo', 'name');
  /* Theirs, or one a query they are in is about — the same 404 as the customer page for anybody else. */
  if (!customer || !(await mayOpenCustomer(req.user, customer))) throw ApiError.notFound('Customer not found');
  return customer;
}

export const customerPanel = asyncHandler(async (req, res) => {
  const customer = await readableCustomer(req);
  const open = { customer: customer._id, status: { $ne: 'lost' }, stage: { $ne: CLOSED_STAGE } };

  /* The enquiries this person works — marketing their own, Admin every one. */
  const [enquiries, everyEnquiry] = await Promise.all([
    Enquiry.find({ ...open, ...ownershipFilter(req.user) })
      .select('number stage status marketingStatus nextFollowUpDate assignedTo requirement.modelNumber items.modelNumber updatedAt')
      .populate('assignedTo', 'name')
      .sort('-updatedAt')
      .limit(OPEN_ENQUIRIES)
      .lean(),
    Enquiry.find({ customer: customer._id, ...ownershipFilter(req.user) }).select('_id').lean(),
  ]);

  const tasks = await Todo.find({
    completed: false,
    holds: { $ne: true },
    kind: { $exists: true },
    $or: [{ customer: customer._id }, { enquiry: { $in: everyEnquiry.map((row) => row._id) } }],
  })
    .select('title kind department status dueDate priority enquiry user createdAt')
    .populate([{ path: 'enquiry', select: 'number' }, { path: 'user', select: 'name' }])
    .sort({ dueDate: 1, createdAt: -1 })
    .limit(OPEN_TASKS)
    .lean();

  const delegate = mayDelegate(req.user)
    ? await delegationTargets({ assignedTo: customer.assignedTo?._id }, req.user)
    : null;

  res.json({
    success: true,
    data: {
      customer: {
        _id: customer._id,
        code: customer.code,
        name: customer.name,
        status: customer.status,
        mobile: customer.mobile,
        whatsapp: customer.whatsapp,
        email: customer.email,
        contacts: (customer.contacts || []).map(({ name, designation, mobile, whatsapp, email, isPrimary }) => ({
          name, designation, mobile, whatsapp, email, isPrimary,
        })),
        address: [customer.address, customer.area, customer.landmark, customer.city, customer.state, customer.pincode]
          .filter(Boolean).join(', '),
        assignedTo: customer.assignedTo ? { _id: customer.assignedTo._id, name: customer.assignedTo.name } : null,
        followUp: customer.followUp || null,
      },
      enquiries: enquiries.map((enquiry) => ({
        _id: enquiry._id,
        number: enquiry.number,
        stage: enquiry.stage,
        status: enquiry.status,
        marketingStatus: marketingStatusOf(enquiry),
        marketingStatusLabel: marketingStatusLabel(marketingStatusOf(enquiry)),
        nextFollowUpDate: enquiry.nextFollowUpDate,
        model: enquiry.requirement?.modelNumber || enquiry.items?.find((item) => item.modelNumber)?.modelNumber || null,
        assignedTo: enquiry.assignedTo ? { _id: enquiry.assignedTo._id, name: enquiry.assignedTo.name } : null,
      })),
      tasks: tasks.map((task) => ({
        _id: task._id,
        title: task.title,
        kind: task.kind,
        department: task.department,
        status: task.status || null,
        dueDate: task.dueDate,
        priority: task.priority,
        enquiry: task.enquiry ? { _id: task.enquiry._id, number: task.enquiry.number } : null,
        user: task.user ? { _id: task.user._id, name: task.user.name } : null,
      })),
      delegate,
    },
  });
});

/** Admin hands the buyer, and every enquiry of theirs still being worked, to somebody else. */
export const delegateCustomerTo = asyncHandler(transactional(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');
  const before = snapshot(customer);
  const result = await delegateCustomer({ customer, to: req.body.to, note: req.body.note, user: req.user });
  await recordChange({ model: 'Customer', doc: customer, before, by: req.user, note: `Handed to ${result.to.name}` });
  res.json({ success: true, data: result });
}));
