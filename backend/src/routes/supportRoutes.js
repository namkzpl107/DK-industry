const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const RefreshSession = require('../models/RefreshSession');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const User = require('../models/User');
const { createSupportSocketToken, hashToken, verifyAccessToken } = require('../services/authService');
const { notifyOperations, createNotification, dispatchSoon } = require('../services/notificationService');
const { emitSupportMessage, emitSupportUpdated } = require('../services/supportRealtimeService');
const { answerGuestSupport, isEnabled: supportAiEnabled, queueSupportAiReply } = require('../services/supportAiService');

const router = express.Router();
const phonePattern = /^(?:\+84|0)[0-9]{9,10}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value, max = 3000) => String(value || '').trim().slice(0, max);
const validId = value => mongoose.isValidObjectId(value);
const supportCookie = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/support', maxAge: 30 * 24 * 60 * 60 * 1000 };

async function optionalUser(req) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (!token || scheme !== 'Bearer') return null;
  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub).select('+tokenVersion');
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) throw Object.assign(new Error('Phiên đăng nhập không còn hiệu lực'), { status: 401 });
  if (process.env.NODE_ENV === 'production' || process.env.ENFORCE_SESSION_CHECK === 'true') {
    if (!payload.sid) throw Object.assign(new Error('Phiên đăng nhập không còn hiệu lực'), { status: 401 });
    const active = await RefreshSession.exists({ _id: payload.sid, user: user._id, revokedAt: null, expiresAt: { $gt: new Date() } });
    if (!active) throw Object.assign(new Error('Phiên đăng nhập đã bị thu hồi'), { status: 401 });
  }
  return user;
}

async function context(req) {
  const user = await optionalUser(req);
  if (user) return { user };
  const token = req.cookies.dk_support;
  if (!token) return {};
  const conversation = await SupportConversation.findOne({ guestTokenHash: hashToken(token), guestTokenExpiresAt: { $gt: new Date() } }).select('+guestTokenHash');
  return conversation ? { conversation, guest: true } : {};
}

function requireStaff(user) {
  if (!user || user.role !== 'staff') throw Object.assign(new Error('Bạn không có quyền truy cập hộp thư hỗ trợ'), { status: 403 });
}

const staffConversationFilter = (user, extra = {}) => ({ ...extra, assignedTo: { $in: [user._id, null] } });

function publicConversation(value) {
  const item = typeof value.toObject === 'function' ? value.toObject() : { ...value };
  delete item.guestTokenHash;
  return item;
}

async function latestMessages(conversationId, before, limit = 40) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 40));
  const filter = { conversation: conversationId };
  if (before && validId(before)) filter._id = { $lt: before };
  const values = await SupportMessage.find(filter).populate('sender', 'name role').sort({ _id: -1 }).limit(safeLimit + 1).lean();
  const hasMore = values.length > safeLimit;
  const items = values.slice(0, safeLimit).reverse();
  return { items, hasMore, nextCursor: hasMore ? String(items[0]._id) : null };
}

async function customerConversation(req, { create = false } = {}) {
  const auth = await context(req);
  if (auth.user?.role === 'customer') {
    const conversationId = req.query.conversationId;
    if (conversationId && !validId(conversationId)) throw Object.assign(new Error('Không tìm thấy cuộc trò chuyện'), { status: 404 });
    const filter = conversationId ? { customer: auth.user._id, _id: conversationId } : { customer: auth.user._id, status: 'open' };
    let conversation = await SupportConversation.findOne(filter).populate('customer', 'name email phone company').populate('assignedTo', 'name email');
    if (conversationId && !conversation) throw Object.assign(new Error('Không tìm thấy cuộc trò chuyện'), { status: 404 });
    if (!conversation && create) conversation = await SupportConversation.create({ customer: auth.user._id, contact: { name: auth.user.name, phone: auth.user.phone, email: auth.user.email } });
    return { ...auth, conversation };
  }
  if (auth.user) throw Object.assign(new Error('Tài khoản nhân viên sử dụng hộp thư hỗ trợ'), { status: 403 });
  return auth;
}

function socketToken(auth) {
  return auth.guest && auth.conversation ? createSupportSocketToken(auth.conversation._id) : undefined;
}

async function clearGuestConversation(req, res, auth) {
  if (!auth?.guest || !auth.conversation) return;
  await SupportMessage.deleteMany({ conversation: auth.conversation._id });
  await SupportConversation.deleteOne({ _id: auth.conversation._id, customer: { $exists: false } });
  res.clearCookie('dk_support', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/support' });
}

router.post('/guest-ai', async (req, res, next) => {
  try {
    const user = await optionalUser(req);
    if (user) throw Object.assign(new Error('Khách hàng đã đăng nhập sử dụng hội thoại được lưu'), { status: 409 });
    if (!supportAiEnabled()) throw Object.assign(new Error('Trợ lý AI hiện chưa sẵn sàng'), { status: 503 });
    const content = clean(req.body.content);
    if (!content) throw Object.assign(new Error('Vui lòng nhập nội dung cần hỗ trợ'), { status: 400 });
    const history = Array.isArray(req.body.history)
      ? req.body.history.slice(-11).map(item => ({
        senderRole: item?.senderRole === 'system' ? 'system' : 'guest',
        content: clean(item?.content, 2000)
      })).filter(item => item.content)
      : [];
    const result = await answerGuestSupport(history, content);
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.delete('/guest-session', async (req, res, next) => {
  try {
    const auth = await context(req);
    await clearGuestConversation(req, res, auth);
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.get('/session', async (req, res, next) => {
  try {
    const auth = await customerConversation(req);
    if (auth.guest) {
      await clearGuestConversation(req, res, auth);
      return res.json({ success: true, data: null });
    }
    if (!auth.conversation) return res.json({ success: true, data: null });
    const messages = await latestMessages(auth.conversation._id);
    res.json({ success: true, data: { conversation: publicConversation(auth.conversation), messages: messages.items, page: { hasMore: messages.hasMore, nextCursor: messages.nextCursor }, socketToken: socketToken(auth) } });
  } catch (error) { next(error); }
});

router.get('/messages', async (req, res, next) => {
  try {
    const auth = await customerConversation(req);
    if (!auth.conversation) throw Object.assign(new Error('Không tìm thấy cuộc trò chuyện'), { status: 404 });
    res.json({ success: true, data: await latestMessages(auth.conversation._id, req.query.before, req.query.limit) });
  } catch (error) { next(error); }
});

router.post('/messages', async (req, res, next) => {
  try {
    let auth = await customerConversation(req, { create: true });
    if (!auth.user) throw Object.assign(new Error('Chat Guest là phiên tạm thời; vui lòng sử dụng Trợ lý AI'), { status: 410 });
    const content = clean(req.body.content);
    if (content.length < 1) throw Object.assign(new Error('Vui lòng nhập nội dung cần hỗ trợ'), { status: 400 });
    if (auth.guest && auth.conversation?.status === 'closed') {
      const guestToken = crypto.randomBytes(32).toString('base64url');
      auth = {
        guest: true,
        conversation: await SupportConversation.create({
          guestTokenHash: hashToken(guestToken),
          guestTokenExpiresAt: new Date(Date.now() + supportCookie.maxAge),
          contact: auth.conversation.contact
        })
      };
      res.cookie('dk_support', guestToken, supportCookie);
    }
    if (!auth.conversation) {
      const name = clean(req.body.name, 100);
      const phone = clean(req.body.phone, 20).replace(/[\s.-]/g, '');
      const email = clean(req.body.email, 200).toLowerCase();
      if (phone && !phonePattern.test(phone)) throw Object.assign(new Error('Số điện thoại không hợp lệ'), { status: 400 });
      if (email && !emailPattern.test(email)) throw Object.assign(new Error('Email không hợp lệ'), { status: 400 });
      const guestToken = crypto.randomBytes(32).toString('base64url');
      auth = { guest: true, conversation: await SupportConversation.create({ guestTokenHash: hashToken(guestToken), guestTokenExpiresAt: new Date(Date.now() + supportCookie.maxAge), contact: { name, phone: phone || undefined, email: email || undefined } }) };
      res.cookie('dk_support', guestToken, supportCookie);
    }
    if (auth.conversation.status !== 'open') throw Object.assign(new Error('Cuộc trò chuyện đã kết thúc'), { status: 409 });
    const senderRole = auth.user ? 'customer' : 'guest';
    const clientMessageId = clean(req.body.clientMessageId, 100);
    let message = clientMessageId ? await SupportMessage.findOne({ conversation: auth.conversation._id, senderRole, clientMessageId }) : null;
    let duplicate = Boolean(message);
    if (!message) {
      try {
        message = await SupportMessage.create({ conversation: auth.conversation._id, sender: auth.user?._id, senderRole, clientMessageId: clientMessageId || undefined, content });
      } catch (error) {
        if (error.code !== 11000 || !clientMessageId) throw error;
        message = await SupportMessage.findOne({ conversation: auth.conversation._id, senderRole, clientMessageId });
        duplicate = true;
      }
    }
    if (!duplicate) {
      auth.conversation.lastMessageAt = new Date();
      auth.conversation.lastMessagePreview = content.slice(0, 200);
      auth.conversation.unreadByStaff += 1;
      await auth.conversation.save();
      await notifyOperations({ type: 'support.customer_message', title: `Tin hỗ trợ từ ${auth.conversation.contact.name || auth.user?.name || 'khách hàng'}`, message: content.slice(0, 180), link: '/staff/support', metadata: { conversationId: auth.conversation._id } });
      dispatchSoon();
      await emitSupportMessage(auth.conversation._id, message);
      queueSupportAiReply(auth.conversation._id, message._id);
    }
    res.status(duplicate ? 200 : 201).json({ success: true, data: { conversation: publicConversation(auth.conversation), message, socketToken: socketToken(auth) } });
  } catch (error) { next(error); }
});

router.get('/conversations', async (req, res, next) => {
  try {
    const { user } = await context(req); requireStaff(user);
    const items = await SupportConversation.find(staffConversationFilter(user, { customer: { $exists: true } })).populate('customer', 'name email phone company').populate('assignedTo', 'name email').sort({ lastMessageAt: -1 }).limit(100).lean();
    res.json({ success: true, data: items.map(publicConversation) });
  } catch (error) { next(error); }
});

router.get('/conversations/:id', async (req, res, next) => {
  try {
    const { user } = await context(req); requireStaff(user);
    if (!validId(req.params.id)) throw Object.assign(new Error('Hội thoại không hợp lệ'), { status: 404 });
    const conversation = await SupportConversation.findOne(staffConversationFilter(user, { _id: req.params.id })).populate('customer', 'name email phone company').populate('assignedTo', 'name email');
    if (!conversation) throw Object.assign(new Error('Không tìm thấy hội thoại'), { status: 404 });
    const messages = await latestMessages(conversation._id);
    res.json({ success: true, data: { conversation: publicConversation(conversation), messages: messages.items, page: { hasMore: messages.hasMore, nextCursor: messages.nextCursor } } });
  } catch (error) { next(error); }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const { user } = await context(req); requireStaff(user);
    if (!validId(req.params.id) || !await SupportConversation.exists(staffConversationFilter(user, { _id: req.params.id }))) throw Object.assign(new Error('Không tìm thấy hội thoại'), { status: 404 });
    res.json({ success: true, data: await latestMessages(req.params.id, req.query.before, req.query.limit) });
  } catch (error) { next(error); }
});

router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const { user } = await context(req); requireStaff(user);
    const conversation = validId(req.params.id) ? await SupportConversation.findOne(staffConversationFilter(user, { _id: req.params.id })) : null;
    if (!conversation) throw Object.assign(new Error('Không tìm thấy hội thoại'), { status: 404 });
    if (conversation.status !== 'open') throw Object.assign(new Error('Hội thoại đã đóng'), { status: 409 });
    const content = clean(req.body.content);
    if (!content) throw Object.assign(new Error('Vui lòng nhập nội dung'), { status: 400 });
    const clientMessageId = clean(req.body.clientMessageId, 100);
    let message = clientMessageId ? await SupportMessage.findOne({ conversation: conversation._id, senderRole: user.role, clientMessageId }).populate('sender', 'name role') : null;
    let duplicate = Boolean(message);
    if (!message) {
      try {
        message = await SupportMessage.create({ conversation: conversation._id, sender: user._id, senderRole: user.role, clientMessageId: clientMessageId || undefined, content });
      } catch (error) {
        if (error.code !== 11000 || !clientMessageId) throw error;
        message = await SupportMessage.findOne({ conversation: conversation._id, senderRole: user.role, clientMessageId }).populate('sender', 'name role');
        duplicate = true;
      }
    }
    if (!duplicate) {
      conversation.assignedTo ||= user._id;
      conversation.aiEscalated = false;
      conversation.aiEscalationReason = undefined;
      conversation.lastMessageAt = new Date(); conversation.lastMessagePreview = content.slice(0, 200); conversation.unreadByCustomer += 1;
      await conversation.save();
      if (conversation.customer) await createNotification({ recipient: conversation.customer, type: 'support.staff_message', title: 'DK Industry đã phản hồi hỗ trợ', message: content.slice(0, 180), link: '/', metadata: { conversationId: conversation._id } });
      dispatchSoon(); await emitSupportMessage(conversation._id, message);
    }
    res.status(duplicate ? 200 : 201).json({ success: true, data: message });
  } catch (error) { next(error); }
});

router.patch('/conversations/:id', async (req, res, next) => {
  try {
    const { user } = await context(req); requireStaff(user);
    const conversation = validId(req.params.id) ? await SupportConversation.findOne(staffConversationFilter(user, { _id: req.params.id })) : null;
    if (!conversation) throw Object.assign(new Error('Không tìm thấy hội thoại'), { status: 404 });
    if (req.body.assignedTo === 'me') conversation.assignedTo = user._id;
    if (req.body.status === 'closed') { conversation.status = 'closed'; conversation.closedAt = new Date(); }
    if (req.body.status === 'open') { conversation.status = 'open'; conversation.closedAt = undefined; }
    await conversation.save(); await emitSupportUpdated(conversation._id);
    res.json({ success: true, data: publicConversation(conversation) });
  } catch (error) { next(error); }
});

module.exports = router;
