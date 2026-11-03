const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Order = require('../models/Order');
const Quotation = require('../models/Quotation');
const RequestMessage = require('../models/RequestMessage');
const ServiceRequest = require('../models/ServiceRequest');
const User = require('../models/User');
const WorkOrder = require('../models/WorkOrder');
const { transitionLead, transitionOrder, transitionPayment, transitionServiceRequest } = require('../services/workflowService');
const { commitOrderStock, releaseOrderStock } = require('../services/orderService');
const { withTransaction } = require('../services/transactionService');
const { writeAudit } = require('../services/auditService');
const { createNotification, dispatchSoon, sendDirectEmail } = require('../services/notificationService');
const { notificationEmail, passwordResetEmail } = require('../services/emailTemplateService');
const { issueAccountToken } = require('../services/accountTokenService');
const { createIdempotentMessage, messagePage, publicMessage } = require('../services/chatMessageService');
const { emitMessage, emitRequestEvent, emitRequestUpdated } = require('../services/realtimeService');
const { sendStoredFile } = require('../services/fileStorageService');
const { vietnamDateKey } = require('../lib/vietnamDate');

const router = express.Router();
const leadStatuses = new Set(['new', 'qualified', 'contacted', 'needs_analysis', 'quoted', 'won', 'lost', 'spam']);
const leadStageStatuses = {
  received: ['new', 'qualified'],
  quoting: ['contacted', 'needs_analysis'],
  waiting: ['quoted'],
  done: ['won'],
  stopped: ['lost', 'spam'],
};
const requestStatuses = new Set(['submitted', 'reviewing', 'need_more_info', 'quoted', 'accepted', 'rejected', 'cancelled']);
const orderStatuses = new Set(['pending', 'confirmed', 'preparing', 'shipping', 'delivered', 'cancelled']);
const paymentStatuses = new Set(['unpaid', 'pending', 'paid', 'refund_pending', 'refunded']);
const priorities = new Set(['low', 'normal', 'high', 'urgent']);
const workOrderStatuses = new Set(['awaiting_contract', 'awaiting_deposit', 'scheduled', 'in_progress', 'quality_check', 'ready_for_delivery', 'completed', 'cancelled']);
const workOrderTransitions = {
  awaiting_contract: ['awaiting_deposit', 'scheduled', 'in_progress', 'cancelled'],
  awaiting_deposit: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['quality_check', 'ready_for_delivery', 'cancelled'],
  quality_check: ['in_progress', 'ready_for_delivery'],
  ready_for_delivery: ['completed'],
  completed: [], cancelled: []
};
const validId = value => mongoose.isValidObjectId(value);
const workOrderWithIntegrity = item => ({
  ...item,
  integrityIssues: [
    !item.customer && 'customer',
    !item.request && 'request',
    !item.quotation && 'quotation'
  ].filter(Boolean)
});
const clean = (value, max = 3000) => String(value || '').trim().slice(0, max);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const optionalInteger = (value, label, min, max) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(label);
  return number;
};

async function lockRevisionItems(request, quote) {
  if (request.status !== 'reviewing') return quote;
  const previous = await Quotation.findOne({ request: request._id }).sort({ version: -1 });
  if (!previous || previous.status !== 'rejected') return quote;
  const sameLine = (left, right) => left.description === right.description && (left.spec || '') === (right.spec || '') && Number(left.quantity) === Number(right.quantity) && left.unit === right.unit;
  if (quote.items.length !== previous.items.length || previous.items.some((item, index) => !sameLine(item, quote.items[index]))) {
    fail('Báo giá lại phải giữ đúng vật tư, quy cách, số lượng và đơn vị của báo giá trước. Chỉ được đổi đơn giá.');
  }
  quote.items = previous.items.map((item, index) => ({ description: item.description, spec: item.spec || '', quantity: item.quantity, unit: item.unit, unitPrice: quote.items[index].unitPrice, lineTotal: 0 }));
  return quote;
}

function quotationInput(req) {
  if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 50) fail('Báo giá cần từ 1 đến 50 hạng mục');
  const items = req.body.items.map(item => ({ description: clean(item.description, 500), spec: clean(item.spec, 200), quantity: Number(item.quantity), unit: clean(item.unit, 50), unitPrice: Number(item.unitPrice), lineTotal: 0 }));
  if (items.some(item => !item.description || !item.unit || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Number.isInteger(item.unitPrice) || item.unitPrice < 0)) fail('Số lượng phải là số nguyên dương và đơn giá phải là số nguyên không âm');
  const taxRate = req.body.taxRate === undefined || req.body.taxRate === '' ? 0 : Number(req.body.taxRate);
  if (!Number.isInteger(taxRate) || taxRate < 0 || taxRate > 100) fail('Thuế VAT phải là số nguyên từ 0 đến 100');
  const validityDays = optionalInteger(req.body.validityDays, 'Hiệu lực báo giá phải là số ngày từ 1 đến 365', 1, 365);
  let validUntil;
  if (validityDays) {
    validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);
  } else {
    validUntil = new Date(req.body.validUntil);
    if (Number.isNaN(validUntil.getTime()) || validUntil <= new Date()) fail('Ngày hiệu lực báo giá phải ở tương lai');
  }
  const leadTimeDays = optionalInteger(req.body.leadTimeDays, 'Thời gian thực hiện phải là số ngày nguyên dương', 1, 3650);
  const depositPercent = optionalInteger(req.body.depositPercent, 'Tỷ lệ đặt cọc phải là số nguyên từ 0 đến 100', 0, 100);
  return {
    items, subtotal: 0, total: 0, taxRate, validUntil, validityDays: validityDays || undefined,
    workTitle: clean(req.body.workTitle, 300),
    leadTime: leadTimeDays === null ? clean(req.body.leadTime, 300) : `${leadTimeDays} ngày`,
    leadTimeDays: leadTimeDays || undefined,
    paymentTerms: depositPercent === null ? clean(req.body.paymentTerms, 1000) : `Đặt cọc ${depositPercent}%`,
    incoterm: clean(req.body.incoterm, 300),
    notes: clean(req.body.notes, 2000),
    senderName: req.user.name,
    senderPhone: clean(req.body.senderPhone, 30) || req.user.phone || '',
    senderFax: clean(req.body.senderFax, 30),
    recipientCompany: clean(req.body.recipientCompany, 200),
    recipientName: clean(req.body.recipientName, 120),
    recipientPhone: clean(req.body.recipientPhone, 30),
    recipientFax: clean(req.body.recipientFax, 30)
  };
}
const pageValues = query => ({ page: Math.max(1, Number(query.page) || 1), limit: Math.min(50, Math.max(1, Number(query.limit) || 20)) });
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const searchTerm = value => clean(value, 64);
const assignmentAccess = user => ({ $in: [user._id, null] });
const scopedFilter = (user, extra = {}) => ({ ...extra, assignedTo: assignmentAccess(user) });

function assignmentFilter(query, user) {
  if (query.assigned === 'mine') return user._id;
  if (query.assigned === 'unassigned') return null;
  return undefined;
}

async function assignUser(value, actor) {
  if (!value || value === 'me') return actor._id;
  if (value === 'unassigned') return null;
  if (actor.role !== 'admin') fail('Nhân viên chỉ có thể nhận hoặc bỏ nhận hồ sơ của chính mình', 403);
  if (!validId(value)) fail('Người phụ trách không hợp lệ');
  const assignee = await User.findOne({ _id: value, role: 'staff', status: 'active' }).select('_id');
  if (!assignee) fail('Chỉ có thể giao cho một nhân viên đang hoạt động', 404);
  return assignee._id;
}

function ensureOwnership(document, actor, label) {
  if (actor.role === 'admin') return;
  if (document.assignedTo && String(document.assignedTo) !== String(actor._id)) {
    fail(`${label} đang do nhân viên khác phụ trách`, 409);
  }
}

function claimIfUnassigned(document, actor) {
  if (!document.assignedTo && actor.role === 'staff') document.assignedTo = actor._id;
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const [portalRequests, websiteLeads, waitingQuotes, activeProjects, pendingOrders, myOrders] = await Promise.all([
      ServiceRequest.countDocuments({ status: { $in: ['submitted', 'reviewing', 'need_more_info'] } }),
      Lead.countDocuments({ convertedRequest: null, status: { $nin: ['lost', 'spam', 'won'] } }),
      ServiceRequest.countDocuments({ status: 'quoted' }),
      WorkOrder.countDocuments({ status: { $nin: ['completed', 'cancelled'] } }),
      Order.countDocuments(scopedFilter(req.user, { status: 'pending' })),
      Order.countDocuments({ assignedTo: req.user._id, status: { $nin: ['delivered', 'cancelled'] } })
    ]);
    res.json({ success: true, data: { newRequests: portalRequests + websiteLeads, waitingQuotes, myRequests: waitingQuotes, activeProjects, pendingOrders, myOrders } });
  } catch (error) { next(error); }
});

router.get('/members', async (req, res, next) => {
  try {
    const data = await User.find({ role: 'staff', status: 'active' }).select('name email role').sort({ name: 1 }).lean();
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/leads', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = scopedFilter(req.user);
    if (req.query.queue === 'new') {
      filter.convertedRequest = null;
      filter.status = { $nin: ['lost', 'spam', 'won'] };
    } else if (req.query.queue === 'done') {
      filter.status = { $in: ['lost', 'spam'] };
    } else if (leadStageStatuses[req.query.stage]) filter.status = { $in: leadStageStatuses[req.query.stage] };
    else if (leadStatuses.has(req.query.status)) filter.status = req.query.status;
    if (priorities.has(req.query.priority)) filter.priority = req.query.priority;
    const assignedTo = assignmentFilter(req.query, req.user);
    if (assignedTo !== undefined) filter.assignedTo = assignedTo;
    const q = searchTerm(req.query.q);
    if (q) {
      const pattern = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ code: pattern }, { name: pattern }, { phone: pattern }, { email: pattern }];
    }
    const [items, total] = await Promise.all([
      Lead.find(filter).populate('assignedTo', 'name email').populate('convertedRequest', 'code title status').sort({ priority: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Lead.countDocuments(filter)
    ]);
    res.json({ success: true, data: { items, total, page, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.get('/leads/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Lead không hợp lệ', 404);
    const data = await Lead.findOne(scopedFilter(req.user, { _id: req.params.id })).populate('assignedTo', 'name email').populate('convertedRequest', 'code title status').populate('notes.author', 'name role').populate('timeline.actor', 'name role').lean();
    if (!data) fail('Không tìm thấy Lead', 404);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.patch('/leads/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Lead không hợp lệ', 404);
    const lead = await Lead.findOne(scopedFilter(req.user, { _id: req.params.id }));
    if (!lead) fail('Không tìm thấy Lead', 404);
    ensureOwnership(lead, req.user, 'Lead');
    claimIfUnassigned(lead, req.user);
    if (req.body.assignedTo !== undefined) {
      const nextAssignee = await assignUser(req.body.assignedTo, req.user);
      lead.assignedTo = nextAssignee;
      lead.timeline.push({ action: 'assignment_changed', message: nextAssignee ? 'Đã cập nhật người phụ trách.' : 'Đã bỏ người phụ trách.', actor: req.user._id });
    }
    if (req.body.priority !== undefined) {
      if (!priorities.has(req.body.priority)) fail('Mức ưu tiên không hợp lệ');
      lead.priority = req.body.priority;
    }
    if (req.body.nextFollowUpAt !== undefined) {
      const value = req.body.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : null;
      if (value && Number.isNaN(value.getTime())) fail('Lịch chăm sóc không hợp lệ');
      lead.nextFollowUpAt = value;
    }
    if (req.body.status !== undefined) {
      if (!leadStatuses.has(req.body.status)) fail('Trạng thái Lead không hợp lệ');
      transitionLead(lead, req.body.status, { actor: req.user._id, message: clean(req.body.message, 500) });
    }
    if (req.body.status === 'lost') {
      const reason = clean(req.body.lostReason, 500);
      if (!reason) fail('Cần nhập lý do Lead thất bại');
      lead.lostReason = reason;
    }
    await lead.save();
    if (req.body.status === 'lost' && lead.email) {
      const mail = notificationEmail({ notification: { type: 'lead.rejected', title: `Yêu cầu ${lead.code} chưa thể thực hiện`, message: lead.lostReason || 'Xưởng chưa nhận yêu cầu này.' }, recipientName: lead.name, actionUrl: '' });
      sendDirectEmail({ to: lead.email, subject: `Yêu cầu ${lead.code} chưa thể thực hiện`, text: mail.text, html: mail.html }).catch(error => console.error('Lead rejection email failed:', error.message));
    }
    res.json({ success: true, message: 'Đã cập nhật Lead', data: lead });
  } catch (error) { next(error); }
});

router.post('/leads/:id/notes', async (req, res, next) => {
  try {
    const content = clean(req.body.content, 2000);
    if (!content) fail('Vui lòng nhập nội dung ghi chú');
    const lead = validId(req.params.id) ? await Lead.findOne(scopedFilter(req.user, { _id: req.params.id })) : null;
    if (!lead) fail('Không tìm thấy Lead', 404);
    ensureOwnership(lead, req.user, 'Lead');
    claimIfUnassigned(lead, req.user);
    lead.notes.push({ content, author: req.user._id });
    lead.timeline.push({ action: 'note_added', message: 'Đã thêm ghi chú nội bộ.', actor: req.user._id });
    await lead.save();
    res.status(201).json({ success: true, message: 'Đã thêm ghi chú', data: lead.notes.at(-1) });
  } catch (error) { next(error); }
});

router.post('/leads/:id/convert', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Lead không hợp lệ', 404);
    const result = await withTransaction(async session => {
      const leadQuery = Lead.findOne(scopedFilter(req.user, { _id: req.params.id }));
      if (session) leadQuery.session(session);
      const lead = await leadQuery;
      if (!lead) fail('Không tìm thấy Lead', 404);
      ensureOwnership(lead, req.user, 'Lead');
      if (lead.convertedRequest) fail('Lead đã được chuyển thành hồ sơ trước đó', 409);
      if (lead.status === 'spam') fail('Không thể chuyển đổi Lead bị đánh dấu spam', 409);
      claimIfUnassigned(lead, req.user);
      const customerId = req.body?.customerId;
      const customerFilter = customerId && validId(customerId)
        ? { _id: customerId, role: 'customer', status: 'active' }
        : { role: 'customer', status: 'active', $or: [...(lead.email ? [{ email: lead.email }] : []), { phone: lead.phone }] };
      const customerQuery = User.findOne(customerFilter);
      if (session) customerQuery.session(session);
      const customer = await customerQuery;
      if (!customer) fail('Chưa tìm thấy tài khoản khách hàng trùng email hoặc số điện thoại. Hãy tạo/liên kết tài khoản khách trước khi chuyển đổi.', 409);
      const type = lead.products?.length ? 'product_quote' : 'consulting';
      const created = await ServiceRequest.create([{
        code: `YC-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${require('crypto').randomBytes(3).toString('hex').toUpperCase()}`,
        customer: customer._id, requestType: type, title: clean(lead.serviceType || `Tư vấn từ ${lead.code}`, 200),
        description: clean(lead.message || `Yêu cầu được chuyển đổi từ Lead ${lead.code}.`, 5000), budget: lead.budget,
        product: lead.products?.[0]?.product, productSnapshot: lead.products?.[0] ? { name: lead.products[0].name } : undefined,
        contact: { name: customer.name, phone: customer.phone, email: customer.email, company: customer.company },
        source: 'lead_conversion', sourceLead: lead._id, assignedTo: lead.assignedTo || (req.user.role === 'staff' ? req.user._id : undefined),
        status: 'submitted', timeline: [{ status: 'submitted', message: `Hồ sơ được chuyển từ Lead ${lead.code}.`, actorType: 'staff', actor: req.user._id }]
      }], session ? { session } : undefined);
      const request = created[0];
      lead.convertedCustomer = customer._id;
      lead.convertedRequest = request._id;
      lead.timeline.push({ action: 'converted', message: `Đã chuyển thành hồ sơ ${request.code}.`, actor: req.user._id });
      if (lead.status !== 'won') transitionLead(lead, 'won', { actor: req.user._id, message: `Đã tạo hồ sơ ${request.code}.` });
      await lead.save(session ? { session } : undefined);
      await writeAudit({ actor: req.user._id, action: 'lead.converted', entity: 'lead', entityId: lead._id, summary: `Chuyển Lead ${lead.code} thành ${request.code}`, metadata: { customerId: customer._id, requestId: request._id }, session });
      return { lead, request, customer };
    });
    await createNotification({ recipient: result.customer._id, type: 'request.created_from_lead', title: `Hồ sơ tư vấn ${result.request.code} đã được tạo`, message: 'Yêu cầu trao đổi trước đó của bạn đã được đưa vào cổng khách hàng để theo dõi.', link: `/tai-khoan/yeu-cau?requestId=${result.request._id}` });
    dispatchSoon();
    res.status(201).json({ success: true, message: `Đã tạo yêu cầu ${result.request.code}. Bạn có thể kiểm tra và gửi báo giá ngay.`, data: { leadId: result.lead._id, requestId: result.request._id, requestCode: result.request.code, customerId: result.customer._id } });
  } catch (error) { next(error); }
});

const accountRoles = { admin: 'quản trị', staff: 'nhân viên', customer: 'khách hàng' };

async function customerForLead(lead) {
  const email = String(lead.email || '').trim().toLowerCase();
  const phone = String(lead.phone || '').trim();
  if (!email) fail('Yêu cầu chưa có email khách hàng, nên chưa thể gửi báo giá.');
  const [byEmail, byPhone] = await Promise.all([
    User.findOne({ email }),
    phone ? User.findOne({ phone }) : null
  ]);
  if (byEmail) return { customer: byEmail, created: false };
  const phoneTaken = Boolean(byPhone);
  const passwordHash = await User.hashPassword(crypto.randomBytes(18).toString('hex'));
  const draft = { name: lead.name, email, phone: phoneTaken ? undefined : (phone || undefined), passwordHash, role: 'customer', status: 'active', emailVerifiedAt: new Date() };
  try {
    const customer = await User.create(draft);
    return { customer, created: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const again = await User.findOne({ email });
    if (again) return { customer: again, created: false };
    if (!phoneTaken && phone && Object.keys(error.keyPattern || {}).includes('phone')) {
      const customer = await User.create({ ...draft, phone: undefined });
      return { customer, created: true };
    }
    throw error;
  }
}

function quoteDeliveryMessage(customer, created) {
  if (created) return 'Đã gửi báo giá cho khách hàng';
  const role = accountRoles[customer.role] || 'khách hàng';
  const locked = customer.status !== 'active' ? ' Tài khoản này đang bị khóa, cần mở khóa thì người nhận mới đăng nhập xem được.' : '';
  return `Đã gửi báo giá tới email đã có tài khoản ${role}.${locked}`;
}

router.post('/leads/:id/quotation', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Lead không hợp lệ', 404);
    const quote = quotationInput(req);
    const lead = validId(req.params.id) ? await Lead.findOne(scopedFilter(req.user, { _id: req.params.id })) : null;
    if (!lead) fail('Không tìm thấy Lead', 404);
    if (lead.convertedRequest) fail('Yêu cầu này đã có báo giá. Hãy mở hồ sơ đang chờ khách.', 409);
    if (lead.status === 'spam') fail('Không gửi báo giá cho yêu cầu spam', 409);
    const customerEmail = clean(req.body.customerEmail, 200).toLowerCase();
    if (customerEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) fail('Email khách nhận báo giá không đúng định dạng.');
      lead.email = customerEmail;
    }
    const { customer, created } = await customerForLead(lead);
    claimIfUnassigned(lead, req.user);
    const requestCode = `YC-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const createdRequest = await ServiceRequest.create({
      code: requestCode, customer: customer._id, requestType: lead.products?.length ? 'product_quote' : 'consulting',
      title: clean(lead.serviceType || `Tư vấn từ ${lead.code}`, 200),
      description: clean(lead.message || `Yêu cầu được chuyển từ ${lead.code}.`, 5000), budget: lead.budget,
      contact: { name: customer.name, phone: customer.phone, email: customer.email, company: customer.company },
      source: 'lead_conversion', sourceLead: lead._id, assignedTo: req.user._id, status: 'submitted',
      timeline: [{ status: 'submitted', message: `Hồ sơ được mở từ yêu cầu ${lead.code}.`, actorType: 'staff', actor: req.user._id }]
    });
    const sequenced = await ServiceRequest.findByIdAndUpdate(createdRequest._id, { $inc: { quotationSequence: 1 } }, { new: true }).select('quotationSequence');
    const quotation = await Quotation.create({
      request: createdRequest._id, customer: customer._id, version: sequenced.quotationSequence, ...quote,
      status: 'sent', sentAt: new Date(), createdBy: req.user._id
    });
    transitionServiceRequest(createdRequest, 'quoted', { actor: req.user._id, actorType: 'staff', message: `Đã gửi báo giá ${quotation.code}.` });
    createdRequest.lastStaffMessageAt = new Date();
    lead.convertedCustomer = customer._id;
    lead.convertedRequest = createdRequest._id;
    if (lead.status !== 'won') transitionLead(lead, 'won', { actor: req.user._id, message: `Đã gửi báo giá ${quotation.code}.` });
    await Promise.all([
      createdRequest.save(), lead.save(),
      RequestMessage.create({ request: createdRequest._id, sender: req.user._id, senderRole: req.user.role, visibility: 'customer', content: `Cơ khí Đăng Khoa đã gửi báo giá ${quotation.code}.`, readByStaffAt: new Date() })
    ]);
    await createNotification({ recipient: customer._id, type: 'quotation.sent', title: `Bạn có báo giá mới ${quotation.code}`, message: `Báo giá có tổng giá trị ${quotation.total.toLocaleString('vi-VN')}đ và hiệu lực đến ${quotation.validUntil.toLocaleDateString('vi-VN')}.`, link: `/tai-khoan/yeu-cau?requestId=${createdRequest._id}`, metadata: { requestId: createdRequest._id, quotationId: quotation._id } });
    if (created) {
      const token = await issueAccountToken(customer, 'password_reset', 30);
      const base = (process.env.CLIENT_URL || 'http://localhost:3000').split(',')[0].replace(/\/$/, '');
      const mail = passwordResetEmail({ name: customer.name, actionUrl: `${base}/dat-lai-mat-khau#token=${encodeURIComponent(token)}` });
      sendDirectEmail({ to: customer.email, subject: mail.subject, text: mail.text, html: mail.html }).catch(error => console.error('Quote account email failed:', error.message));
    }
    dispatchSoon();
    res.status(201).json({ success: true, message: quoteDeliveryMessage(customer, created), data: { requestId: createdRequest._id, requestCode: createdRequest.code, quotationId: quotation._id } });
  } catch (error) { next(error); }
});

router.get('/requests', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = scopedFilter(req.user);
    if (req.query.view === 'new') {
      filter.status = { $in: ['submitted', 'reviewing', 'need_more_info'] };
    } else if (req.query.view === 'waiting') {
      filter.status = 'quoted';
    } else if (req.query.view === 'doing') {
      const completedIds = await WorkOrder.find({ status: 'completed' }).distinct('request');
      filter.status = 'accepted';
      filter._id = { $nin: completedIds };
    } else if (req.query.view === 'done') {
      const doneIds = await WorkOrder.find({ status: 'completed' }).distinct('request');
      delete filter.assignedTo;
      filter.$and = [scopedFilter(req.user), { $or: [{ status: { $in: ['rejected', 'cancelled'] } }, { _id: { $in: doneIds } }] }];
    } else if (req.query.view === 'active') {
      filter.status = { $nin: ['accepted', 'rejected', 'cancelled'] };
      if (req.user.role === 'staff') filter.assignedTo = req.user._id;
    } else if (req.query.view === 'mine') {
      filter.assignedTo = req.user._id;
      filter.status = { $nin: ['accepted', 'rejected', 'cancelled'] };
    } else if (req.query.view === 'closed') {
      filter.status = { $in: ['accepted', 'rejected', 'cancelled'] };
    }
    if (requestStatuses.has(req.query.status)) filter.status = req.query.status;
    if (priorities.has(req.query.priority)) filter.priority = req.query.priority;
    const assignedTo = assignmentFilter(req.query, req.user);
    if (assignedTo !== undefined) filter.assignedTo = assignedTo;
    const q = searchTerm(req.query.q);
    if (q) {
      const pattern = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ code: pattern }, { title: pattern }, { 'contact.name': pattern }, { 'contact.phone': pattern }];
    }
    const [items, total] = await Promise.all([
      ServiceRequest.find(filter).select('-attachments.storedName -internalSummary').populate('customer', 'name email phone company').populate('assignedTo', 'name email').sort({ priority: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ServiceRequest.countDocuments(filter)
    ]);
    const requestIds = items.map(item => item._id);
    const [unread, latestQuotes] = await Promise.all([
      RequestMessage.aggregate([{ $match: { request: { $in: requestIds }, senderRole: 'customer', readByStaffAt: null } }, { $group: { _id: '$request', count: { $sum: 1 } } }]),
      Quotation.aggregate([{ $match: { request: { $in: requestIds } } }, { $sort: { version: -1 } }, { $group: { _id: '$request', status: { $first: '$status' } } }])
    ]);
    const unreadByRequest = new Map(unread.map(item => [String(item._id), item.count]));
    const revisionIds = new Set(latestQuotes.filter(item => item.status === 'rejected').map(item => String(item._id)));
    res.json({ success: true, data: { items: items.map(item => ({ ...item, unreadCount: unreadByRequest.get(String(item._id)) || 0, revisionRequested: item.status === 'reviewing' && revisionIds.has(String(item._id)) })), total, page, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Yêu cầu không hợp lệ', 404);
    const request = await ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.id })).select('+internalSummary -attachments.storedName').populate('customer', 'name email phone company').populate('assignedTo', 'name email').lean();
    if (!request) fail('Không tìm thấy yêu cầu', 404);
    const [messageResult, quotations, workOrder] = await Promise.all([
      messagePage({ request: request._id }, { limit: 50, populateSender: true }),
      Quotation.find({ request: request._id }).populate('createdBy', 'name role').sort({ version: -1 }).lean(),
      WorkOrder.findOne({ request: request._id }).populate('assignedTo', 'name email').lean()
    ]);
    const readAt = new Date();
    const readResult = await RequestMessage.updateMany({ request: request._id, senderRole: 'customer', readByStaffAt: null }, { readByStaffAt: readAt });
    if (readResult.modifiedCount) await emitRequestEvent(request._id, 'message:read', { requestId: String(request._id), readerRole: 'staff', readAt: readAt.toISOString() });
    res.json({ success: true, data: { request, messages: messageResult.items, messagePage: { hasMore: messageResult.hasMore, nextCursor: messageResult.nextCursor }, quotations, workOrder } });
  } catch (error) { next(error); }
});

router.get('/requests/:id/messages', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Yêu cầu không hợp lệ', 404);
    const request = await ServiceRequest.exists(scopedFilter(req.user, { _id: req.params.id }));
    if (!request) fail('Không tìm thấy yêu cầu', 404);
    const data = await messagePage({ request: req.params.id }, { before: req.query.before, limit: req.query.limit, populateSender: true });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.post('/requests/:id/claim', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Yêu cầu không hợp lệ', 404);
    const existing = await ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.id })).select('assignedTo status code customer');
    if (!existing) fail('Không tìm thấy yêu cầu', 404);
    if (existing.assignedTo) {
      if (String(existing.assignedTo) !== String(req.user._id)) fail('Yêu cầu đã được nhân viên khác nhận xử lý', 409);
      return res.json({ success: true, message: 'Yêu cầu này đã thuộc phần phụ trách của bạn', data: existing });
    }
    if (existing.status !== 'submitted') fail('Yêu cầu không còn ở trạng thái chờ tiếp nhận', 409);
    const message = 'Yêu cầu đã được nhân viên tiếp nhận. Chúng tôi đang kiểm tra thông tin và chuẩn bị báo giá.';
    const request = await ServiceRequest.findOneAndUpdate(
      { _id: existing._id, assignedTo: null, status: 'submitted' },
      {
        $set: { assignedTo: req.user._id, status: 'reviewing', closedAt: null, lastStaffMessageAt: new Date() },
        $push: { timeline: { status: 'reviewing', message, actorType: 'staff', actor: req.user._id } }
      },
      { new: true, runValidators: true }
    );
    if (!request) fail('Yêu cầu vừa được nhân viên khác nhận xử lý', 409);
    await Promise.all([
      RequestMessage.create({ request: request._id, sender: req.user._id, senderRole: req.user.role, visibility: 'customer', content: message, readByStaffAt: new Date() }),
      createNotification({ recipient: request.customer, type: 'request.claimed', title: `Yêu cầu ${request.code} đã được tiếp nhận`, message, link: `/tai-khoan/yeu-cau?requestId=${request._id}`, metadata: { requestId: request._id } }),
      writeAudit({ actor: req.user._id, action: 'request.claimed', entity: 'request', entityId: request._id, summary: `Nhận xử lý yêu cầu ${request.code}` })
    ]);
    dispatchSoon();
    await emitRequestUpdated(request._id, 'request_claimed', { visibility: 'customer' });
    res.json({ success: true, message: 'Đã nhận xử lý và thông báo cho khách hàng', data: request });
  } catch (error) { next(error); }
});

router.patch('/requests/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Yêu cầu không hợp lệ', 404);
    const request = await ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.id })).select('+internalSummary');
    if (!request) fail('Không tìm thấy yêu cầu', 404);
    let customerMessage = '';
    ensureOwnership(request, req.user, 'Hồ sơ');
    if (req.body.assignedTo !== undefined) {
      const nextAssignee = await assignUser(req.body.assignedTo, req.user);
      request.assignedTo = nextAssignee;
    }
    if (!request.assignedTo) fail('Hãy nhận xử lý yêu cầu trước khi cập nhật', 409);
    if (req.body.priority !== undefined) {
      if (!priorities.has(req.body.priority)) fail('Mức ưu tiên không hợp lệ');
      request.priority = req.body.priority;
    }
    if (req.body.internalSummary !== undefined) request.internalSummary = clean(req.body.internalSummary, 3000);
    if (req.body.status !== undefined) {
      if (!requestStatuses.has(req.body.status)) fail('Trạng thái yêu cầu không hợp lệ');
      const message = clean(req.body.message, 1000);
      if (req.body.status === 'need_more_info' && !message) fail('Cần nêu rõ thông tin khách hàng phải bổ sung');
      transitionServiceRequest(request, req.body.status, { actor: req.user._id, actorType: 'staff', message });
      const visibility = req.body.visibility === 'internal' ? 'internal' : 'customer';
      if (message) {
        await RequestMessage.create({ request: request._id, sender: req.user._id, senderRole: req.user.role, visibility, content: message, readByStaffAt: new Date() });
        if (visibility === 'customer') customerMessage = message;
      }
    }
    await request.save();
    if (customerMessage) {
      await createNotification({ recipient: request.customer, type: 'request.status_updated', title: `Cập nhật yêu cầu ${request.code}`, message: customerMessage.slice(0, 180), link: `/tai-khoan/yeu-cau?requestId=${request._id}`, metadata: { requestId: request._id } });
      dispatchSoon();
    }
    await emitRequestUpdated(request._id, 'staff_update', { visibility: req.body.visibility === 'internal' ? 'internal' : 'customer' });
    res.json({ success: true, message: 'Đã cập nhật yêu cầu', data: request });
  } catch (error) { next(error); }
});

router.post('/requests/:id/messages', async (req, res, next) => {
  try {
    const request = validId(req.params.id) ? await ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.id })) : null;
    if (!request) fail('Không tìm thấy yêu cầu', 404);
    ensureOwnership(request, req.user, 'Hồ sơ');
    if (!request.assignedTo) request.assignedTo = req.user._id;
    if (['accepted', 'rejected', 'cancelled'].includes(request.status)) fail('Hồ sơ đã đóng, không thể gửi thêm trao đổi', 409);
    const content = clean(req.body.content);
    if (!content) fail('Vui lòng nhập nội dung');
    const visibility = req.body.visibility === 'internal' ? 'internal' : 'customer';
    const result = await createIdempotentMessage({ request: request._id, sender: req.user._id, senderRole: req.user.role, visibility, content, clientMessageId: req.body.clientMessageId, readByStaffAt: new Date() });
    if (result.duplicate) return res.status(200).json({ success: true, message: 'Tin nhắn đã được gửi trước đó', data: publicMessage(result.message) });
    request.lastStaffMessageAt = new Date();
    if (visibility === 'customer' && request.status === 'submitted') {
      transitionServiceRequest(request, 'reviewing', { actor: req.user._id, actorType: 'staff', message: 'Đã bắt đầu xử lý và phản hồi khách hàng.' });
    }
    await request.save();
    if (visibility === 'customer') {
      await createNotification({ recipient: request.customer, type: 'request.staff_message', title: `Phản hồi mới cho ${request.code}`, message: content.slice(0, 180), link: `/tai-khoan/yeu-cau?requestId=${request._id}`, metadata: { requestId: request._id } });
      dispatchSoon();
    }
    await result.message.populate('sender', 'name role');
    await emitMessage(result.message);
    await emitRequestUpdated(request._id, 'staff_message', { visibility });
    res.status(201).json({ success: true, message: visibility === 'internal' ? 'Đã lưu ghi chú nội bộ' : 'Đã gửi khách hàng', data: publicMessage(result.message) });
  } catch (error) { next(error); }
});

router.post('/requests/:id/quotations', async (req, res, next) => {
  try {
    const request = validId(req.params.id) ? await ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.id })) : null;
    if (!request) fail('Không tìm thấy yêu cầu', 404);
    ensureOwnership(request, req.user, 'Hồ sơ');
    if (!request.assignedTo) request.assignedTo = req.user._id;
    if (!['submitted', 'reviewing', 'need_more_info', 'quoted'].includes(request.status)) fail('Yêu cầu đã đóng, không thể tạo báo giá', 409);
    const quote = await lockRevisionItems(request, quotationInput(req));
    const sequenced = await ServiceRequest.findByIdAndUpdate(request._id, { $inc: { quotationSequence: 1 } }, { new: true }).select('quotationSequence');
    const status = req.body.status === 'sent' ? 'sent' : 'draft';
    const quotation = await Quotation.create({
      request: request._id, customer: request.customer, version: sequenced.quotationSequence, ...quote,
      status, sentAt: status === 'sent' ? new Date() : undefined, createdBy: req.user._id,
      ...(status === 'sent' ? { senderName: req.user.name, senderPhone: req.user.phone || '' } : {})
    });
    if (status === 'sent') {
      await Quotation.updateMany({ request: request._id, _id: { $ne: quotation._id }, status: { $in: ['sent', 'draft'] } }, { status: 'superseded' });
      transitionServiceRequest(request, 'quoted', { actor: req.user._id, actorType: 'staff', message: `Đã gửi báo giá ${quotation.code}.` });
      request.lastStaffMessageAt = new Date();
      await Promise.all([request.save(), RequestMessage.create({ request: request._id, sender: req.user._id, senderRole: req.user.role, visibility: 'customer', content: `Cơ khí Đăng Khoa đã gửi báo giá ${quotation.code} (phiên bản ${quotation.version}).`, readByStaffAt: new Date() })]);
      await createNotification({ recipient: request.customer, type: 'quotation.sent', title: `Bạn có báo giá mới ${quotation.code}`, message: `Báo giá có tổng giá trị ${quotation.total.toLocaleString('vi-VN')}đ và hiệu lực đến ${quotation.validUntil.toLocaleDateString('vi-VN')}.`, link: `/tai-khoan/yeu-cau?requestId=${request._id}`, metadata: { requestId: request._id, quotationId: quotation._id } });
      await writeAudit({ actor: req.user._id, action: 'quotation.sent', entity: 'quotation', entityId: quotation._id, summary: `Gửi báo giá ${quotation.code}`, metadata: { requestId: request._id, total: quotation.total } });
      dispatchSoon();
    } else {
      if (request.status === 'submitted' || request.status === 'need_more_info') {
        transitionServiceRequest(request, 'reviewing', { actor: req.user._id, actorType: 'staff', message: 'Đã bắt đầu lập báo giá.' });
      }
      await request.save();
      await writeAudit({ actor: req.user._id, action: 'quotation.draft_created', entity: 'quotation', entityId: quotation._id, summary: `Tạo nháp báo giá ${quotation.code}`, metadata: { requestId: request._id, total: quotation.total } });
    }
    await emitRequestUpdated(request._id, status === 'sent' ? 'quotation_sent' : 'quotation_draft', { visibility: status === 'sent' ? 'customer' : 'internal' });
    res.status(201).json({ success: true, message: status === 'sent' ? 'Đã gửi báo giá cho khách hàng' : 'Đã lưu bản nháp báo giá', data: quotation });
  } catch (error) { next(error); }
});

router.patch('/requests/:requestId/quotations/:quotationId/send', async (req, res, next) => {
  try {
    if (!validId(req.params.requestId) || !validId(req.params.quotationId)) fail('Báo giá không hợp lệ', 404);
    const [request, quotation] = await Promise.all([ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.requestId })), Quotation.findOne({ _id: req.params.quotationId, request: req.params.requestId })]);
    if (!request || !quotation) fail('Không tìm thấy báo giá', 404);
    ensureOwnership(request, req.user, 'Hồ sơ');
    if (!request.assignedTo) fail('Hãy nhận xử lý yêu cầu trước khi gửi báo giá', 409);
    if (quotation.status !== 'draft') fail('Chỉ có thể gửi báo giá đang ở bản nháp', 409);
    if (quotation.validUntil <= new Date()) fail('Báo giá đã hết hiệu lực', 409);
    await Quotation.updateMany({ request: request._id, _id: { $ne: quotation._id }, status: { $in: ['sent', 'draft'] } }, { status: 'superseded' });
    quotation.status = 'sent'; quotation.sentAt = new Date();
    quotation.senderName = req.user.name;
    quotation.senderPhone = req.user.phone || '';
    transitionServiceRequest(request, 'quoted', { actor: req.user._id, actorType: 'staff', message: `Đã gửi báo giá ${quotation.code}.` });
    request.lastStaffMessageAt = new Date();
    await Promise.all([quotation.save(), request.save(), RequestMessage.create({ request: request._id, sender: req.user._id, senderRole: req.user.role, visibility: 'customer', content: `Cơ khí Đăng Khoa đã gửi báo giá ${quotation.code} (phiên bản ${quotation.version}).`, readByStaffAt: new Date() })]);
    await createNotification({ recipient: request.customer, type: 'quotation.sent', title: `Bạn có báo giá mới ${quotation.code}`, message: `Báo giá có tổng giá trị ${quotation.total.toLocaleString('vi-VN')}đ và hiệu lực đến ${quotation.validUntil.toLocaleDateString('vi-VN')}.`, link: `/tai-khoan/yeu-cau?requestId=${request._id}`, metadata: { requestId: request._id, quotationId: quotation._id } });
    await writeAudit({ actor: req.user._id, action: 'quotation.sent', entity: 'quotation', entityId: quotation._id, summary: `Gửi báo giá ${quotation.code}`, metadata: { requestId: request._id, total: quotation.total } });
    dispatchSoon();
    await emitRequestUpdated(request._id, 'quotation_sent');
    res.json({ success: true, message: 'Đã gửi báo giá cho khách hàng', data: quotation });
  } catch (error) { next(error); }
});

router.get('/requests/:requestId/attachments/:attachmentId', async (req, res, next) => {
  try {
    if (!validId(req.params.requestId) || !validId(req.params.attachmentId)) fail('Tệp không hợp lệ', 404);
    const request = await ServiceRequest.findOne(scopedFilter(req.user, { _id: req.params.requestId }));
    const attachment = request?.attachments.id(req.params.attachmentId);
    if (!attachment) fail('Không tìm thấy tệp', 404);
    return await sendStoredFile(res, attachment);
  } catch (error) { next(error); }
});

router.get('/requests/:requestId/messages/:messageId/attachments/:attachmentId', async (req, res, next) => {
  try {
    if (![req.params.requestId, req.params.messageId, req.params.attachmentId].every(validId)) fail('Tệp không hợp lệ', 404);
    const request = await ServiceRequest.exists(scopedFilter(req.user, { _id: req.params.requestId }));
    if (!request) fail('Không tìm thấy tệp', 404);
    const message = await RequestMessage.findOne({ _id: req.params.messageId, request: req.params.requestId }).select('+attachments.storedName');
    const attachment = message?.attachments.id(req.params.attachmentId);
    if (!attachment) fail('Không tìm thấy tệp', 404);
    return await sendStoredFile(res, attachment);
  } catch (error) { next(error); }
});

router.get('/work-orders', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = scopedFilter(req.user);
    if (req.query.view === 'active') filter.status = { $nin: ['completed', 'cancelled'] };
    if (req.query.view === 'completed') filter.status = 'completed';
    if (workOrderStatuses.has(req.query.status)) filter.status = req.query.status;
    const assignedTo = assignmentFilter(req.query, req.user);
    if (assignedTo !== undefined) filter.assignedTo = assignedTo;
    const q = searchTerm(req.query.q);
    if (q) {
      const pattern = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ code: pattern }, { contractReference: pattern }, { purchaseOrderReference: pattern }];
    }
    const [items, total] = await Promise.all([
      WorkOrder.find(filter).populate('customer', 'name email phone company').populate('assignedTo', 'name email').populate('request', 'code title').populate('quotation', 'code total leadTime paymentTerms notes').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WorkOrder.countDocuments(filter)
    ]);
    res.json({ success: true, data: { items: items.map(workOrderWithIntegrity), total, page, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.get('/work-orders/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Dự án không hợp lệ', 404);
    const data = await WorkOrder.findOne(scopedFilter(req.user, { _id: req.params.id })).populate('customer', 'name email phone company').populate('assignedTo', 'name email').populate('request', 'code title description').populate('quotation').populate('timeline.actor', 'name role').lean();
    if (!data) fail('Không tìm thấy dự án', 404);
    res.json({ success: true, data: workOrderWithIntegrity(data) });
  } catch (error) { next(error); }
});

router.patch('/work-orders/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Dự án không hợp lệ', 404);
    const workOrder = await withTransaction(async session => {
      const query = WorkOrder.findOne(scopedFilter(req.user, { _id: req.params.id }));
      if (session) query.session(session);
      const current = await query;
      if (!current) fail('Không tìm thấy dự án', 404);
      const [customerExists, requestExists, quotationExists] = await Promise.all([
        User.exists({ _id: current.customer }),
        ServiceRequest.exists({ _id: current.request }),
        Quotation.exists({ _id: current.quotation })
      ]);
      if (!customerExists || !requestExists || !quotationExists) fail('Hồ sơ dự án bị thiếu dữ liệu liên kết và không thể cập nhật', 409);
      ensureOwnership(current, req.user, 'Dự án');
      const before = { status: current.status, assignedTo: current.assignedTo, depositRequired: current.depositRequired, depositPaid: current.depositPaid };
      if (req.body.assignedTo !== undefined) current.assignedTo = await assignUser(req.body.assignedTo, req.user);
      claimIfUnassigned(current, req.user);
      if (req.body.contractReference !== undefined) current.contractReference = clean(req.body.contractReference, 200);
      if (req.body.purchaseOrderReference !== undefined) current.purchaseOrderReference = clean(req.body.purchaseOrderReference, 200);
      if (req.body.depositRequired !== undefined) {
        const value = Math.round(Number(req.body.depositRequired));
        if (!Number.isFinite(value) || value < 0 || value > current.agreedTotal) fail('Số tiền đặt cọc yêu cầu không hợp lệ');
        current.depositRequired = value;
      }
      if (req.body.depositPaid !== undefined) {
        const value = Math.round(Number(req.body.depositPaid));
        if (!Number.isFinite(value) || value < 0 || value > current.agreedTotal) fail('Số tiền đặt cọc đã nhận không hợp lệ');
        current.depositPaid = value;
      }
      for (const field of ['plannedStartAt', 'plannedDeliveryAt']) if (req.body[field] !== undefined) {
        const value = req.body[field] ? new Date(req.body[field]) : null;
        if (value && Number.isNaN(value.getTime())) fail('Mốc thời gian kế hoạch không hợp lệ');
        if (field === 'plannedDeliveryAt') {
          const previousKey = current.deliveryDateSavedAt && current.plannedDeliveryAt ? vietnamDateKey(current.plannedDeliveryAt) : '';
          const nextKey = value ? vietnamDateKey(value) : '';
          current.deliveryDateSavedAt = value ? new Date() : undefined;
          if (value && previousKey !== nextKey) {
            const [year, month, day] = nextKey.split('-');
            current.timeline.push({ status: current.status, message: `Hẹn giao ngày ${day}/${month}/${year}.`, actor: req.user._id, actorType: 'staff' });
          }
        }
        current[field] = value;
      }
      if (req.body.status !== undefined && req.body.status !== current.status) {
        if (!workOrderStatuses.has(req.body.status) || !workOrderTransitions[current.status]?.includes(req.body.status)) fail(`Không thể chuyển dự án từ ${current.status} sang ${req.body.status}`, 409);
        if (req.body.status === 'scheduled' && current.depositRequired > current.depositPaid) fail('Chưa thu đủ tiền đặt cọc để lên lịch thực hiện', 409);
        if (req.body.status === 'awaiting_deposit' && current.depositRequired <= 0) fail('Cần nhập số tiền đặt cọc trước khi chờ thanh toán');
        current.status = req.body.status;
        current.timeline.push({ status: current.status, message: clean(req.body.message, 1000), actor: req.user._id, actorType: 'staff' });
      }
      await current.save(session ? { session } : undefined);
      await writeAudit({ actor: req.user._id, action: 'work_order.updated', entity: 'work_order', entityId: current._id, summary: `Cập nhật dự án ${current.code}`, metadata: { before, after: { status: current.status, assignedTo: current.assignedTo, depositRequired: current.depositRequired, depositPaid: current.depositPaid } }, session });
      return current;
    });
    const projectLabels = { awaiting_contract: 'Nhận dự án thành công', awaiting_deposit: 'Nhận dự án thành công', scheduled: 'Nhận dự án thành công', in_progress: 'Đang triển khai', quality_check: 'Đang triển khai', ready_for_delivery: 'Đang triển khai', completed: 'Đã hoàn thành', cancelled: 'Đã hủy' };
    await createNotification({ recipient: workOrder.customer, type: 'work_order.updated', title: `Dự án ${workOrder.code} đã được cập nhật`, message: `Tiến độ hiện tại: ${projectLabels[workOrder.status] || workOrder.status}.`, link: `/tai-khoan/du-an?projectId=${workOrder._id}` });
    dispatchSoon();
    res.json({ success: true, message: 'Đã cập nhật dự án', data: workOrder });
  } catch (error) { next(error); }
});

router.patch('/work-orders/:id/repair', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Dự án không hợp lệ', 404);
    const decision = clean(req.body.decision);
    const resolution = clean(req.body.resolution, 2000);
    if (!['accept', 'reject'].includes(decision)) fail('Quyết định sửa chữa không hợp lệ');
    if (resolution.length < 3) fail('Vui lòng ghi lý do hoặc ngày xử lý');
    const workOrder = await WorkOrder.findOne(scopedFilter(req.user, { _id: req.params.id }));
    if (!workOrder) fail('Không tìm thấy dự án', 404);
    if (!['requested', 'requote'].includes(workOrder.repair?.status)) fail('Không có yêu cầu sửa đang chờ', 409);
    if (decision === 'accept') {
      const delivery = req.body.plannedDeliveryAt ? new Date(req.body.plannedDeliveryAt) : null;
      if (delivery && Number.isNaN(delivery.getTime())) fail('Ngày giao không hợp lệ');
      workOrder.status = 'in_progress';
      if (delivery) {
        workOrder.plannedDeliveryAt = delivery;
        workOrder.deliveryDateSavedAt = new Date();
      }
      workOrder.repair.status = 'accepted';
      workOrder.repair.resolution = resolution;
      workOrder.repair.at = new Date();
      workOrder.customerConfirmedAt = undefined;
      workOrder.timeline.push({ status: 'in_progress', message: `Nhận sửa: ${resolution}`, actor: req.user._id, actorType: 'staff' });
    } else {
      workOrder.repair.status = 'rejected';
      workOrder.repair.resolution = resolution;
      workOrder.repair.at = new Date();
      workOrder.timeline.push({ status: workOrder.status, message: `Từ chối sửa: ${resolution}`, actor: req.user._id, actorType: 'staff' });
    }
    await workOrder.save();
    await createNotification({ recipient: workOrder.customer, type: 'work_order.repair', title: decision === 'accept' ? `Xưởng nhận sửa ${workOrder.code}` : `Xưởng chưa nhận sửa ${workOrder.code}`, message: resolution, link: `/tai-khoan/du-an?projectId=${workOrder._id}`, metadata: { workOrderId: workOrder._id } });
    dispatchSoon();
    res.json({ success: true, message: decision === 'accept' ? 'Đã nhận sửa và hẹn giao lại' : 'Đã từ chối yêu cầu sửa', data: workOrder });
  } catch (error) { next(error); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = scopedFilter(req.user);
    if (orderStatuses.has(req.query.status)) filter.status = req.query.status === 'confirmed' ? { $in: ['confirmed', 'preparing'] } : req.query.status;
    if (paymentStatuses.has(req.query.paymentStatus)) filter.paymentStatus = req.query.paymentStatus;
    const assignedTo = assignmentFilter(req.query, req.user);
    if (assignedTo !== undefined) filter.assignedTo = assignedTo;
    const q = searchTerm(req.query.q);
    if (q) {
      const pattern = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ code: pattern }, { 'shippingAddress.recipientName': pattern }, { 'shippingAddress.phone': pattern }];
    }
    const [items, total] = await Promise.all([
      Order.find(filter).populate('customer', 'name email phone company').populate('assignedTo', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Order.countDocuments(filter)
    ]);
    res.json({ success: true, data: { items, total, page, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Đơn hàng không hợp lệ', 404);
    const data = await Order.findOne(scopedFilter(req.user, { _id: req.params.id })).select('+internalNote').populate('customer', 'name email phone company').populate('assignedTo', 'name email').populate('timeline.actor', 'name role').populate('paymentTimeline.actor', 'name role').lean();
    if (!data) fail('Không tìm thấy đơn hàng', 404);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

router.patch('/orders/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Đơn hàng không hợp lệ', 404);
    const order = await withTransaction(async session => {
      const query = Order.findOne(scopedFilter(req.user, { _id: req.params.id })).select('+internalNote');
      if (session) query.session(session);
      const current = await query;
      if (!current) fail('Không tìm thấy đơn hàng', 404);
      ensureOwnership(current, req.user, 'Đơn hàng');
      const before = { status: current.status, paymentStatus: current.paymentStatus, shippingFee: current.shippingFee, total: current.total, assignedTo: current.assignedTo };
      const terminalOrder = ['delivered', 'cancelled'].includes(current.status);

      if (req.body.assignedTo !== undefined) {
        if (terminalOrder) fail('Không thể phân công đơn hàng đã kết thúc', 409);
        current.assignedTo = await assignUser(req.body.assignedTo, req.user);
      }
      if (req.body.internalNote !== undefined) current.internalNote = clean(req.body.internalNote, 3000);
      if (req.body.shippingFee !== undefined) {
        if (!['pending', 'confirmed', 'preparing'].includes(current.status)) fail('Chỉ cập nhật phí vận chuyển trước khi xuất giao');
        const shippingFee = Number(req.body.shippingFee);
        if (!Number.isFinite(shippingFee) || shippingFee < 0 || shippingFee > 100000000) fail('Phí vận chuyển không hợp lệ');
        if (Math.round(shippingFee) !== current.shippingFee && (current.paymentLockedAt || ['paid', 'refund_pending', 'refunded'].includes(current.paymentStatus))) {
          fail('Không thể thay đổi phí vận chuyển sau khi đã ghi nhận thanh toán', 409);
        }
        current.shippingFee = Math.round(shippingFee);
        current.total = current.subtotal + current.shippingFee;
      }
      const updatesShipping = req.body.shippingProvider !== undefined || req.body.trackingCode !== undefined || req.body.estimatedDeliveryAt !== undefined;
      if (terminalOrder && updatesShipping) fail('Không thể cập nhật vận chuyển cho đơn hàng đã kết thúc', 409);
      if (req.body.shippingProvider !== undefined) current.shippingProvider = clean(req.body.shippingProvider, 150);
      if (req.body.trackingCode !== undefined) current.trackingCode = clean(req.body.trackingCode, 150);
      if (req.body.estimatedDeliveryAt !== undefined) {
        const estimate = req.body.estimatedDeliveryAt ? new Date(req.body.estimatedDeliveryAt) : null;
        if (estimate && Number.isNaN(estimate.getTime())) fail('Ngày giao dự kiến không hợp lệ');
        current.estimatedDeliveryAt = estimate;
      }
      if (req.body.paymentStatus !== undefined) {
        const nextPayment = req.body.paymentStatus;
        if (!paymentStatuses.has(nextPayment)) fail('Trạng thái thanh toán không hợp lệ');
        if (nextPayment === 'refund_pending' && (req.body.status || current.status) !== 'cancelled') fail('Chỉ yêu cầu hoàn tiền cho đơn đã hủy');
        if (nextPayment === 'refunded' && (req.body.status || current.status) !== 'cancelled') fail('Chỉ xác nhận hoàn tiền cho đơn đã hủy');
        if (nextPayment === 'paid' && current.paymentMethod === 'cod' && (req.body.status || current.status) !== 'delivered') fail('Đơn COD chỉ được ghi nhận đã thanh toán khi giao thành công');
        if (nextPayment !== current.paymentStatus) {
          let amount;
          let reference = clean(req.body.paymentReference, 200);
          if (nextPayment === 'paid') {
            amount = req.body.amountPaid === undefined ? current.total : Number(req.body.amountPaid);
            if (!Number.isFinite(amount) || Math.round(amount) !== current.total) fail('Số tiền nhận phải khớp chính xác tổng đơn hàng');
            if (current.paymentMethod === 'bank_transfer' && reference.length < 3) fail('Cần nhập mã hoặc nội dung tham chiếu giao dịch chuyển khoản');
            current.amountPaid = Math.round(amount);
            current.paymentReference = reference;
            current.paymentLockedAt = new Date();
          }
          transitionPayment(current, nextPayment, { actor: req.user._id, message: clean(req.body.paymentMessage || req.body.message, 1000), amount, reference });
        }
      }
      if (req.body.status !== undefined && req.body.status !== current.status) {
        if (!orderStatuses.has(req.body.status)) fail('Trạng thái đơn hàng không hợp lệ');
        const previousStatus = current.status;
        const message = clean(req.body.message, 1000);
        if (req.body.status === 'cancelled' && !message) fail('Cần nhập lý do hủy đơn');
        if (req.body.status === 'shipping' && !current.shippingProvider) fail('Cần nhập đơn vị hoặc hình thức vận chuyển trước khi giao hàng');
        if (req.body.status === 'shipping' && current.paymentMethod === 'bank_transfer' && current.paymentStatus !== 'paid') fail('Đơn chuyển khoản phải được xác nhận thanh toán trước khi giao');
        if (req.body.status === 'delivered') {
          const recipientName = clean(req.body.deliveryRecipientName, 150);
          if (req.body.deliveryConfirmed !== true) fail('Cần xác nhận hàng đã được giao cho người nhận');
          if (recipientName.length < 2) fail('Vui lòng nhập tên người đã nhận hàng');
          current.deliveryRecipientName = recipientName;
          current.deliveryConfirmationSource = 'staff';
        }
        transitionOrder(current, req.body.status, { actor: req.user._id, message });
        if (req.body.status === 'confirmed') await commitOrderStock(current, session);
        if (req.body.status === 'cancelled' && ['confirmed', 'preparing'].includes(previousStatus)) await releaseOrderStock(current, session);
        if (req.body.status === 'cancelled') {
          current.cancellationReason = message;
          if (current.paymentStatus === 'paid') transitionPayment(current, 'refund_pending', { actor: req.user._id, message: 'Đơn đã hủy và đang chờ hoàn tiền cho khách.', amount: current.amountPaid, reference: current.paymentReference });
        }
        if (req.body.status === 'delivered' && current.paymentMethod === 'cod' && ['unpaid', 'pending'].includes(current.paymentStatus)) {
          current.amountPaid = current.total;
          current.paymentLockedAt = new Date();
          transitionPayment(current, 'paid', { actor: req.user._id, message: 'Đã thu đủ tiền khi giao hàng.', amount: current.total });
        }
      }
      if (!current.assignedTo && req.body.status && req.body.status !== 'pending' && req.user.role === 'staff') current.assignedTo = req.user._id;
      await current.save(session ? { session } : undefined);
      await writeAudit({ actor: req.user._id, action: 'order.updated', entity: 'order', entityId: current._id, summary: `Cập nhật đơn ${current.code}`, metadata: { before, after: { status: current.status, paymentStatus: current.paymentStatus, shippingFee: current.shippingFee, total: current.total, assignedTo: current.assignedTo } }, session });
      return current;
    });
    await createNotification({ recipient: order.customer, type: 'order.updated', title: `Đơn hàng ${order.code} đã được cập nhật`, message: `Trạng thái hiện tại: ${order.status}. Thanh toán: ${order.paymentStatus}.`, link: `/tai-khoan/don-hang?orderId=${order._id}`, metadata: { orderId: order._id } });
    dispatchSoon();
    res.json({ success: true, message: 'Đã cập nhật đơn hàng', data: order });
  } catch (error) { next(error); }
});

router.patch('/orders/:orderId/after-sales/:requestId', async (req, res, next) => {
  try {
    if (!validId(req.params.orderId) || !validId(req.params.requestId)) fail('Yêu cầu hậu mãi không hợp lệ', 404);
    const order = await Order.findOne(scopedFilter(req.user, { _id: req.params.orderId }));
    if (!order) fail('Không tìm thấy đơn hàng', 404);
    ensureOwnership(order, req.user, 'Đơn hàng');
    const item = order.afterSalesRequests.id(req.params.requestId);
    if (!item) fail('Không tìm thấy yêu cầu hậu mãi', 404);
    const transitions = { submitted: ['reviewing', 'rejected'], reviewing: ['approved', 'rejected'], approved: ['received', 'resolved'], received: ['resolved'], rejected: [], resolved: [] };
    const nextStatus = clean(req.body.status);
    if (!transitions[item.status]?.includes(nextStatus)) fail(`Không thể chuyển hậu mãi từ ${item.status} sang ${nextStatus}`, 409);
    const resolution = clean(req.body.resolution, 3000);
    if (['rejected', 'resolved'].includes(nextStatus) && resolution.length < 5) fail('Cần nhập kết quả xử lý rõ ràng');
    item.status = nextStatus;
    item.resolution = resolution || item.resolution;
    item.updatedBy = req.user._id;
    if (nextStatus === 'resolved') item.resolvedAt = new Date();
    await order.save();
    await writeAudit({ actor: req.user._id, action: 'order.after_sales_updated', entity: 'order', entityId: order._id, summary: `Cập nhật hậu mãi ${order.code}: ${nextStatus}`, metadata: { afterSalesId: item._id, resolution } });
    await createNotification({ recipient: order.customer, type: 'order.after_sales_updated', title: `Yêu cầu hậu mãi ${order.code} đã được cập nhật`, message: resolution || `Trạng thái hiện tại: ${nextStatus}.`, link: `/tai-khoan/don-hang?orderId=${order._id}`, metadata: { orderId: order._id, afterSalesId: item._id } });
    dispatchSoon();
    res.json({ success: true, message: 'Đã cập nhật yêu cầu hậu mãi', data: order });
  } catch (error) { next(error); }
});

module.exports = router;
