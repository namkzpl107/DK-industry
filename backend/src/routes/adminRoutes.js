const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const AuditLog = require('../models/AuditLog');
const DataPrivacyRequest = require('../models/DataPrivacyRequest');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Project = require('../models/Project');
const Quotation = require('../models/Quotation');
const RefreshSession = require('../models/RefreshSession');
const Service = require('../models/Service');
const ServiceRequest = require('../models/ServiceRequest');
const SiteSetting = require('../models/SiteSetting');
const { presentSiteSetting } = require('../siteContent');
const User = require('../models/User');
const WorkOrder = require('../models/WorkOrder');
const { validateImageFile } = require('../services/fileSecurityService');
const { storeContentImage } = require('../services/fileStorageService');
const { createNotification, dispatchSoon } = require('../services/notificationService');
const { disconnectUserSockets } = require('../services/socketSessionService');

const router = express.Router();
const phonePattern = /^(?:\+84|0)[0-9]{9,10}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,72}$/;
const staffRoles = new Set(['staff', 'admin']);
const userRoles = new Set(['customer', 'staff', 'admin']);
const userStatuses = new Set(['active', 'blocked']);
const privacyStatuses = new Set(['submitted', 'reviewing', 'approved', 'rejected', 'completed']);
const privacyTransitions = {
  submitted: new Set(['submitted', 'reviewing', 'approved', 'rejected']),
  reviewing: new Set(['reviewing', 'approved', 'rejected']),
  approved: new Set(['approved', 'completed', 'rejected']),
  rejected: new Set(['rejected']),
  completed: new Set(['completed']),
  cancelled: new Set(['cancelled'])
};
const imageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => imageExtensions[file.mimetype] ? callback(null, true) : callback(Object.assign(new Error('Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP'), { status: 400 }))
});
const validId = value => mongoose.isValidObjectId(value);
const clean = (value, max = 5000) => String(value ?? '').trim().slice(0, max);
const normalizePhone = value => clean(value, 20).replace(/[\s.-]/g, '');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const pageValues = query => ({ page: Math.max(1, Number(query.page) || 1), limit: Math.min(50, Math.max(1, Number(query.limit) || 20)) });
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slugify = value => clean(value, 200).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const publicUser = user => ({ _id: user._id, name: user.name, email: user.email, phone: user.phone || '', role: user.role, status: user.status, emailVerified: Boolean(user.emailVerifiedAt), mfaEnabled: Boolean(user.mfaEnabledAt), lastLoginAt: user.lastLoginAt, createdAt: user.createdAt });

function dashboardMonths() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'numeric' }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const current = parts.year * 12 + parts.month - 1;
  return Array.from({ length: 12 }, (_, index) => {
    const value = current - 11 + index;
    const year = Math.floor(value / 12); const month = value % 12 + 1;
    return { key: `${year}-${String(month).padStart(2, '0')}`, label: `T${month}/${String(year).slice(-2)}` };
  });
}

async function audit(req, action, entity, entityId, summary, metadata = {}) {
  await AuditLog.create({ actor: req.user._id, action, entity, entityId, summary, metadata });
}

function listFilter(query, searchable, extra = {}) {
  const filter = { ...extra };
  const q = clean(query.q, 100);
  if (q) {
    const pattern = { $regex: escapeRegex(q), $options: 'i' };
    filter.$or = searchable.map(field => ({ [field]: pattern }));
  }
  return filter;
}

function populateProjectMonitor(query) {
  return query
    .populate('customer', 'name email phone company')
    .populate('assignedTo', 'name email')
    .populate('request', 'code title description requestType material quantity dimensions desiredDate budget')
    .populate('quotation', 'code version items subtotal taxRate taxAmount total validUntil leadTime paymentTerms notes status createdAt');
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const months = dashboardMonths();
    const analyticsStart = new Date(`${months[0].key}-01T00:00:00+07:00`);
    const monthStart = new Date(`${months.at(-1).key}-01T00:00:00+07:00`);
    const analyticsPromise = Promise.all([
      Order.aggregate([{ $match: { paymentStatus: 'paid', paidAt: { $gte: analyticsStart } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: 'Asia/Bangkok' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Order.aggregate([{ $match: { createdAt: { $gte: analyticsStart } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      ServiceRequest.countDocuments({ createdAt: { $gte: analyticsStart }, source: { $ne: 'lead_conversion' } }),
      Quotation.distinct('request', { sentAt: { $gte: analyticsStart }, status: { $ne: 'draft' } }),
      Order.countDocuments({ createdAt: { $gte: analyticsStart }, status: { $ne: 'cancelled' } }),
      WorkOrder.countDocuments({ createdAt: { $gte: analyticsStart }, status: { $ne: 'cancelled' } }),
      Order.aggregate([{ $match: { paymentStatus: 'paid', paidAt: { $gte: analyticsStart } } }, { $unwind: '$items' }, { $group: { _id: { product: '$items.product', name: '$items.name' }, quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } }, { $sort: { revenue: -1 } }, { $limit: 5 }]),
      WorkOrder.aggregate([{ $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: analyticsStart } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Bangkok' } }, revenue: { $sum: '$agreedTotal' }, projects: { $sum: 1 } } }])
    ]).then(([monthly, orderStatuses, directRequests, quotedRequests, orders, workOrders, topProducts, projectMonthly]) => {
      const monthlyMap = new Map(monthly.map(item => [item._id, item]));
      const projectMap = new Map(projectMonthly.map(item => [item._id, item]));
      const statusMap = orderStatuses.reduce((map, item) => {
        const status = item._id === 'preparing' ? 'confirmed' : item._id;
        map.set(status, (map.get(status) || 0) + item.count);
        return map;
      }, new Map());
      return {
        revenueTrend: months.map(month => ({ ...month, revenue: monthlyMap.get(month.key)?.revenue || 0, orders: monthlyMap.get(month.key)?.orders || 0, projectRevenue: projectMap.get(month.key)?.revenue || 0, projects: projectMap.get(month.key)?.projects || 0 })),
        orderStatuses: Array.from(statusMap, ([status, count]) => ({ status, count })),
        conversion: { opportunities: directRequests, quotations: quotedRequests.length, wins: orders + workOrders },
        topProducts: topProducts.map(item => ({ productId: item._id.product, name: item._id.name, quantity: item.quantity, revenue: item.revenue }))
      };
    });
    const [customers, staff, blockedUsers, products, lowStock, services, projects, activeProjects, openRequests, openOrders, pendingOrders, revenue, monthlyRevenue, deliveredRevenue, monthlyDeliveredRevenue, deliveredOrders, recentOrders, recentActivity, analytics] = await Promise.all([
      User.countDocuments({ role: 'customer' }), User.countDocuments({ role: 'staff', status: 'active' }), User.countDocuments({ status: 'blocked' }),
      Product.countDocuments({ active: true, deletedAt: null }), Product.countDocuments({ active: true, deletedAt: null, priceOnRequest: false, stock: { $lte: 5 } }), Service.countDocuments({ published: true, deletedAt: null }), Project.countDocuments({ published: true, deletedAt: null }),
      WorkOrder.countDocuments({ status: { $nin: ['completed', 'cancelled'] } }), ServiceRequest.countDocuments({ status: { $nin: ['accepted', 'rejected', 'cancelled'] } }), Order.countDocuments({ status: { $nin: ['delivered', 'cancelled'] } }), Order.countDocuments({ status: 'pending' }),
      Order.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, value: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'paid', paidAt: { $gte: monthStart } } }, { $group: { _id: null, value: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'paid', status: 'delivered' } }, { $group: { _id: null, value: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'paid', status: 'delivered', deliveredAt: { $gte: monthStart } } }, { $group: { _id: null, value: { $sum: '$total' } } }]),
      Order.countDocuments({ status: 'delivered' }),
      Order.find().select('code total status paymentStatus createdAt').populate('customer', 'name').sort({ createdAt: -1 }).limit(6).lean(),
      AuditLog.find().populate('actor', 'name email').sort({ createdAt: -1 }).limit(8).lean(), analyticsPromise
    ]);
    res.json({ success: true, data: { customers, staff, blockedUsers, products, lowStock, services, projects, activeProjects, openRequests, openOrders, pendingOrders, revenue: revenue[0]?.value || 0, monthlyRevenue: monthlyRevenue[0]?.value || 0, deliveredRevenue: deliveredRevenue[0]?.value || 0, monthlyDeliveredRevenue: monthlyDeliveredRevenue[0]?.value || 0, deliveredOrders, recentOrders, recentActivity, analytics } });
  } catch (error) { next(error); }
});

router.get('/work-orders', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = {};
    if (req.query.state === 'active') filter.status = { $nin: ['completed', 'cancelled'] };
    else if (req.query.state === 'completed') filter.status = 'completed';
    else if (req.query.state === 'cancelled') filter.status = 'cancelled';
    const q = clean(req.query.q, 100);
    if (q) {
      const pattern = { $regex: escapeRegex(q), $options: 'i' };
      const [requests, quotations, customers] = await Promise.all([
        ServiceRequest.find({ $or: [{ code: pattern }, { title: pattern }] }).select('_id').limit(100).lean(),
        Quotation.find({ code: pattern }).select('_id').limit(100).lean(),
        User.find({ role: 'customer', name: pattern }).select('_id').limit(100).lean()
      ]);
      filter.$or = [
        { code: pattern },
        { request: { $in: requests.map(item => item._id) } },
        { quotation: { $in: quotations.map(item => item._id) } },
        { customer: { $in: customers.map(item => item._id) } }
      ];
    }
    const [items, total] = await Promise.all([
      populateProjectMonitor(WorkOrder.find(filter)).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WorkOrder.countDocuments(filter)
    ]);
    res.json({ success: true, data: { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
});

router.get('/work-orders/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Dự án không hợp lệ', 404);
    const item = await populateProjectMonitor(WorkOrder.findById(req.params.id)).lean();
    if (!item) fail('Không tìm thấy dự án', 404);
    res.json({ success: true, data: item });
  } catch (error) { next(error); }
});

router.get('/privacy-requests', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = {};
    if (req.query.privacyRequestId) {
      if (!validId(req.query.privacyRequestId)) fail('Yêu cầu không hợp lệ', 404);
      filter._id = req.query.privacyRequestId;
    }
    if (privacyStatuses.has(req.query.status) || req.query.status === 'cancelled') filter.status = req.query.status;
    const [items, total] = await Promise.all([
      DataPrivacyRequest.find(filter).populate('customer', 'name email phone status').populate('handledBy', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      DataPrivacyRequest.countDocuments(filter)
    ]);
    res.json({ success: true, data: { items, total, page, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.patch('/privacy-requests/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Yêu cầu không hợp lệ', 404);
    const status = clean(req.body.status, 30);
    const resolution = clean(req.body.resolution, 3000);
    if (!privacyStatuses.has(status)) fail('Trạng thái xử lý không hợp lệ');
    if (['rejected', 'completed'].includes(status) && resolution.length < 10) fail('Cần ghi rõ kết quả xử lý ít nhất 10 ký tự');
    const item = await DataPrivacyRequest.findById(req.params.id).populate('customer', 'name email');
    if (!item) fail('Không tìm thấy yêu cầu', 404);
    if (['cancelled', 'completed'].includes(item.status)) fail('Yêu cầu này đã kết thúc', 409);
    if (!privacyTransitions[item.status]?.has(status)) fail('Không thể chuyển yêu cầu theo trạng thái này', 409);
    item.status = status; item.resolution = resolution; item.handledBy = req.user._id; item.handledAt = new Date();
    if (status === 'completed') item.completedAt = new Date();
    await item.save();
    await audit(req, `privacy.${status}`, 'privacy_request', item._id, `Đã cập nhật yêu cầu xóa tài khoản của ${item.customer?.name || 'khách hàng'}`, { status });
    if (item.customer) {
      await createNotification({ recipient: item.customer._id, type: `privacy.${status}`, title: 'Cập nhật yêu cầu xóa tài khoản', message: `Yêu cầu của bạn hiện ở trạng thái: ${status}. ${resolution || ''}`.trim(), link: '/tai-khoan', email: item.customer.email, metadata: { privacyRequestId: item._id } });
      dispatchSoon();
    }
    res.json({ success: true, message: 'Đã cập nhật yêu cầu quyền riêng tư', data: item });
  } catch (error) { next(error); }
});

router.get('/users', async (req, res, next) => {
  try {
    const { page, limit } = pageValues(req.query);
    const filter = listFilter(req.query, ['name', 'email', 'phone']);
    if (userRoles.has(req.query.role)) filter.role = req.query.role;
    if (userStatuses.has(req.query.status)) filter.status = req.query.status;
    const [items, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), User.countDocuments(filter)]);
    res.json({ success: true, data: { items: items.map(publicUser), total, page, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.post('/users', async (req, res, next) => {
  try {
    const name = clean(req.body.name, 100); const email = clean(req.body.email, 200).toLowerCase(); const phone = normalizePhone(req.body.phone); const password = String(req.body.password || '');
    const role = staffRoles.has(req.body.role) ? req.body.role : 'staff';
    if (name.length < 2 || !emailPattern.test(email) || !phonePattern.test(phone)) fail('Họ tên, email hoặc số điện thoại không hợp lệ');
    if (!passwordPattern.test(password)) fail('Mật khẩu tạm thời cần từ 8 đến 72 ký tự, gồm chữ hoa, chữ thường và số');
    const user = await User.create({ name, email, phone, role, passwordHash: await User.hashPassword(password), status: 'active', emailVerifiedAt: new Date() });
    await audit(req, 'user.created', 'user', user._id, `Đã tạo tài khoản ${role}: ${user.name}`);
    res.status(201).json({ success: true, message: 'Đã tạo tài khoản nhân sự', data: publicUser(user) });
  } catch (error) { next(error); }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Tài khoản không hợp lệ', 404);
    const user = await User.findById(req.params.id).select('+tokenVersion');
    if (!user) fail('Không tìm thấy tài khoản', 404);
    const isSelf = String(user._id) === String(req.user._id);
    const nextRole = req.body.role === undefined ? user.role : req.body.role;
    const nextStatus = req.body.status === undefined ? user.status : req.body.status;
    if (!userRoles.has(nextRole) || !userStatuses.has(nextStatus)) fail('Vai trò hoặc trạng thái không hợp lệ');
    if (isSelf && (nextRole !== user.role || nextStatus !== user.status)) fail('Không thể tự thay đổi vai trò hoặc khóa chính tài khoản đang đăng nhập', 409);
    if (user.role === 'admin' && (nextRole !== 'admin' || nextStatus !== 'active')) {
      const activeAdmins = await User.countDocuments({ role: 'admin', status: 'active' });
      if (activeAdmins <= 1) fail('Hệ thống phải luôn còn ít nhất một Admin đang hoạt động', 409);
    }
    const before = { role: user.role, status: user.status };
    if (req.body.name !== undefined) { const name = clean(req.body.name, 100); if (name.length < 2) fail('Họ tên không hợp lệ'); user.name = name; }
    if (req.body.email !== undefined) { const email = clean(req.body.email, 200).toLowerCase(); if (!emailPattern.test(email)) fail('Email không hợp lệ'); if (email !== user.email) user.emailVerifiedAt = undefined; user.email = email; }
    if (req.body.phone !== undefined) { const phone = normalizePhone(req.body.phone); if (!phonePattern.test(phone)) fail('Số điện thoại không hợp lệ'); user.phone = phone; }
    user.role = nextRole; user.status = nextStatus;
    const securityChanged = before.role !== user.role || before.status !== user.status;
    if (securityChanged) user.tokenVersion += 1;
    await user.save();
    if (securityChanged) {
      await RefreshSession.deleteMany({ user: user._id });
      disconnectUserSockets(user._id, { reason: 'account_security_changed' });
    }
    await audit(req, 'user.updated', 'user', user._id, `Đã cập nhật tài khoản ${user.name}`, { before, after: { role: user.role, status: user.status } });
    res.json({ success: true, message: 'Đã cập nhật tài khoản', data: publicUser(user) });
  } catch (error) { next(error); }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) fail('Tài khoản không hợp lệ', 404);
    const password = String(req.body.password || '');
    if (!passwordPattern.test(password)) fail('Mật khẩu mới cần từ 8 đến 72 ký tự, gồm chữ hoa, chữ thường và số');
    const user = await User.findById(req.params.id).select('+passwordHash +tokenVersion');
    if (!user) fail('Không tìm thấy tài khoản', 404);
    user.passwordHash = await User.hashPassword(password); user.tokenVersion += 1; await user.save();
    await RefreshSession.deleteMany({ user: user._id });
    disconnectUserSockets(user._id, { reason: 'admin_password_reset' });
    await audit(req, 'user.password_reset', 'user', user._id, `Đã đặt lại mật khẩu cho ${user.name}`);
    res.json({ success: true, message: 'Đã đặt lại mật khẩu và đăng xuất các phiên cũ' });
  } catch (error) { next(error); }
});

router.post('/uploads/images', imageUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) fail('Vui lòng chọn một ảnh để tải lên');
    if (!validateImageFile(req.file)) {
      fail('Nội dung tệp không phải ảnh hợp lệ');
    }
    const stored = await storeContentImage(req.file);
    res.status(201).json({ success: true, message: 'Đã tải ảnh lên', data: stored });
  } catch (error) { next(error); }
});

router.get('/site-settings/about', async (_req, res, next) => {
  try {
    const setting = await SiteSetting.findOne({ key: 'about' }).lean();
    res.json({ success: true, data: presentSiteSetting(setting) });
  } catch (error) { next(error); }
});

router.patch('/site-settings/about', async (req, res, next) => {
  try {
    const update = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'leaderImage')) update.leaderImage = safeImage(req.body.leaderImage);
    if (Object.prototype.hasOwnProperty.call(req.body, 'equipment')) update.equipment = sanitizeEquipment(req.body.equipment);
    if (Object.prototype.hasOwnProperty.call(req.body, 'orgUnits')) update.orgUnits = sanitizeOrgUnits(req.body.orgUnits);
    if (!Object.keys(update).length) fail('Không có nội dung để cập nhật');
    const setting = await SiteSetting.findOneAndUpdate(
      { key: 'about' },
      { $set: update, $setOnInsert: { key: 'about' } },
      { new: true, upsert: true, runValidators: true }
    );
    await audit(req, 'site_setting.updated', 'site_setting', setting._id, 'Đã cập nhật nội dung trang Giới thiệu và máy móc xưởng');
    res.json({ success: true, message: 'Đã cập nhật nội dung', data: presentSiteSetting(setting.toObject()) });
  } catch (error) { next(error); }
});

function safeImage(value) {
  const image = clean(value, 2000);
  if (!image) return '';
  if (image.startsWith('/images/') || image.startsWith('/uploads/')) {
    if (image.includes('..') || image.includes('\\') || image.includes('//')) fail('Đường dẫn ảnh không hợp lệ');
    return image;
  }
  let parsed;
  try { parsed = new URL(image); } catch { fail('Đường dẫn ảnh không hợp lệ'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('Đường dẫn ảnh phải sử dụng HTTP hoặc HTTPS');
  return image;
}

function sanitizeEquipment(value) {
  if (!Array.isArray(value) || value.length > 20) fail('Danh sách máy móc không hợp lệ');
  return value.map(item => {
    const name = clean(item && item.name, 120);
    if (!name) fail('Tên máy không được để trống');
    const images = (Array.isArray(item.images) ? item.images : []).map(safeImage).filter(Boolean);
    if (images.length > 2) fail('Mỗi máy chỉ có tối đa 2 ảnh');
    return { name, summary: clean(item.summary, 400), purpose: clean(item.purpose, 500), notes: clean(item.notes, 500), images };
  });
}

function sanitizeOrgUnits(value) {
  if (!Array.isArray(value) || value.length > 24) fail('Sơ đồ tổ chức không hợp lệ');
  return value.map(item => {
    const name = clean(item && item.name, 120);
    if (!name) fail('Tên phòng ban không được để trống');
    const tier = Number(item && item.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 4) fail('Cấp trong sơ đồ phải từ 1 đến 4');
    return { name, note: clean(item.note, 240), tier };
  });
}

function contentValues(kind, body, current = {}) {
  const name = clean(body.name ?? body.title ?? current.name ?? current.title, 200);
  const values = { ...current, ...body, slug: slugify(body.slug || name || current.slug) };
  delete values._id; delete values.createdAt; delete values.updatedAt; delete values.__v;
  if (!name || !values.slug) fail('Tên và đường dẫn nội dung không hợp lệ');
  if (kind === 'product') {
    const allowed = ['name', 'slug', 'sku', 'category', 'description', 'specifications', 'price', 'unit', 'stock', 'priceOnRequest', 'image', 'images', 'featured', 'active'];
    const result = Object.fromEntries(allowed.filter(key => values[key] !== undefined).map(key => [key, values[key]]));
    result.name = name; result.category = clean(result.category, 150); result.sku = clean(result.sku, 100) || undefined; result.unit = clean(result.unit, 50) || 'sản phẩm';
    if (!result.category) fail('Danh mục sản phẩm là bắt buộc');
    if (result.priceOnRequest) result.price = null; else { result.price = Number(result.price); if (!Number.isFinite(result.price) || result.price < 0) fail('Giá sản phẩm không hợp lệ'); }
    result.stock = Number(result.stock || 0); if (!Number.isInteger(result.stock) || result.stock < 0) fail('Tồn kho không hợp lệ');
    return result;
  }
  if (kind === 'service') {
    const allowed = ['name', 'slug', 'summary', 'description', 'capabilities', 'materials', 'applications', 'image', 'order', 'featured', 'published'];
    const result = Object.fromEntries(allowed.filter(key => values[key] !== undefined).map(key => [key, values[key]])); result.name = name; result.summary = clean(result.summary, 500);
    if (!result.summary) fail('Mô tả ngắn dịch vụ là bắt buộc'); return result;
  }
  const allowed = ['title', 'slug', 'category', 'client', 'location', 'year', 'description', 'objective', 'projectScale', 'durationDays', 'teamSize', 'scope', 'requirements', 'workItems', 'technicalHighlights', 'challenge', 'solution', 'results', 'customerFeedback', 'stages', 'image', 'gallery', 'featured', 'published'];
  const result = Object.fromEntries(allowed.filter(key => values[key] !== undefined).map(key => [key, values[key]])); result.title = name; result.category = clean(result.category, 150);
  if (!result.category) fail('Danh mục dự án là bắt buộc');
  if (result.durationDays !== null && result.durationDays !== undefined && result.durationDays !== '') {
    result.durationDays = Number(result.durationDays);
    if (!Number.isInteger(result.durationDays) || result.durationDays < 1) fail('Số ngày thực hiện phải là số nguyên dương');
  } else result.durationDays = null;
  if (result.teamSize !== null && result.teamSize !== undefined && result.teamSize !== '') {
    result.teamSize = Number(result.teamSize);
    if (!Number.isInteger(result.teamSize) || result.teamSize < 1) fail('Quy mô nhân sự phải là số nguyên dương');
  } else result.teamSize = null;
  if (result.stages !== undefined) {
    if (!Array.isArray(result.stages) || result.stages.length > 3) fail('Các giai đoạn dự án không hợp lệ');
    result.stages = result.stages.map(stage => {
      const phase = clean(stage?.phase, 20); const title = clean(stage?.title, 200); const description = clean(stage?.description, 5000);
      if (!['before', 'during', 'after'].includes(phase) || !title) fail('Thông tin giai đoạn dự án không hợp lệ');
      if (!Array.isArray(stage.images) || stage.images.length > 20) fail('Mỗi giai đoạn chỉ được tối đa 20 ảnh');
      const images = stage.images.map(image => ({ url: clean(image?.url, 2000), caption: clean(image?.caption, 500) })).filter(image => image.url);
      return { phase, title, description, images };
    });
  }
  return result;
}

for (const [path, kind, Model, activeField, searchable] of [
  ['products', 'product', Product, 'active', ['name', 'sku', 'category']],
  ['services', 'service', Service, 'published', ['name', 'summary']],
  ['projects', 'project', Project, 'published', ['title', 'client', 'category']]
]) {
  router.get(`/${path}`, async (req, res, next) => { try {
    const { page, limit } = pageValues(req.query); const filter = listFilter(req.query, searchable);
    if (req.query.state === 'deleted') filter.deletedAt = { $ne: null };
    else { filter.deletedAt = null; if (req.query.state === 'published') filter[activeField] = true; if (req.query.state === 'hidden') filter[activeField] = false; }
    const baseFilter = listFilter(req.query, searchable);
    const [items, total, published, hidden, deleted] = await Promise.all([
      Model.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Model.countDocuments(filter),
      Model.countDocuments({ ...baseFilter, [activeField]: true, deletedAt: null }),
      Model.countDocuments({ ...baseFilter, [activeField]: false, deletedAt: null }),
      Model.countDocuments({ ...baseFilter, deletedAt: { $ne: null } })
    ]);
    res.json({ success: true, data: { items, total, page, pages: Math.ceil(total / limit), counts: { published, hidden, deleted } } });
  } catch (error) { next(error); } });
  router.post(`/${path}`, async (req, res, next) => { try { const data = await Model.create(contentValues(kind, req.body)); await audit(req, `${kind}.created`, kind, data._id, `Đã tạo ${kind}: ${data.name || data.title}`); res.status(201).json({ success: true, message: 'Đã tạo nội dung', data }); } catch (error) { next(error); } });
  router.patch(`/${path}/:id`, async (req, res, next) => { try { if (!validId(req.params.id)) fail('Nội dung không hợp lệ', 404); const current = await Model.findById(req.params.id).lean(); if (!current) fail('Không tìm thấy nội dung', 404); const data = await Model.findByIdAndUpdate(req.params.id, contentValues(kind, req.body, current), { new: true, runValidators: true }); await audit(req, `${kind}.updated`, kind, data._id, `Đã cập nhật ${kind}: ${data.name || data.title}`); res.json({ success: true, message: 'Đã cập nhật nội dung', data }); } catch (error) { next(error); } });
  router.patch(`/${path}/:id/status`, async (req, res, next) => { try {
    if (!validId(req.params.id)) fail('Nội dung không hợp lệ', 404);
    const status = clean(req.body.status, 20);
    if (!['published', 'hidden', 'deleted'].includes(status)) fail('Trạng thái nội dung không hợp lệ');
    const update = status === 'deleted' ? { [activeField]: false, deletedAt: new Date() } : { [activeField]: status === 'published', deletedAt: null };
    const data = await Model.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!data) fail('Không tìm thấy nội dung', 404);
    await audit(req, `${kind}.${status}`, kind, data._id, `Đã chuyển ${kind} sang trạng thái ${status}: ${data.name || data.title}`);
    res.json({ success: true, message: 'Đã cập nhật trạng thái nội dung', data });
  } catch (error) { next(error); } });
  router.delete(`/${path}/:id`, async (req, res, next) => { try {
    if (!validId(req.params.id)) fail('Nội dung không hợp lệ', 404);
    const data = await Model.findByIdAndUpdate(req.params.id, { [activeField]: false, deletedAt: new Date() }, { new: true });
    if (!data) fail('Không tìm thấy nội dung', 404);
    await audit(req, `${kind}.deleted`, kind, data._id, `Đã xóa ${kind}: ${data.name || data.title}`);
    res.json({ success: true, message: 'Đã chuyển nội dung vào mục Đã xóa', data });
  } catch (error) { next(error); } });
}

router.get('/audit-logs', async (req, res, next) => {
  try { const { page, limit } = pageValues(req.query); const filter = {}; if (req.query.entity && ['user', 'product', 'service', 'project', 'site_setting', 'lead', 'request', 'quotation', 'work_order', 'order', 'payment', 'inventory', 'privacy_request'].includes(req.query.entity)) filter.entity = req.query.entity; const [items, total] = await Promise.all([AuditLog.find(filter).populate('actor', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), AuditLog.countDocuments(filter)]); res.json({ success: true, data: { items, total, page, pages: Math.ceil(total / limit) } }); } catch (error) { next(error); }
});

module.exports = router;
