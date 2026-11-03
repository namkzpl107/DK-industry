const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { resolveNotificationLink } = require('../services/notificationLinkService');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 10));
    const recipientQuery = { recipient: req.user._id };
    const listQuery = req.query.unread === 'true' ? { ...recipientQuery, readAt: null } : recipientQuery;
    const [items, unread, allTotal] = await Promise.all([
      Notification.find(listQuery).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments({ ...recipientQuery, readAt: null }),
      Notification.countDocuments(recipientQuery)
    ]);
    await Promise.all(items.map(async item => { item.link = await resolveNotificationLink(item); }));
    const total = req.query.unread === 'true' ? unread : allTotal;
    res.json({ success: true, data: { items, unread, total, allTotal, page, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
});

router.patch('/read-all', async (req, res, next) => {
  try {
    await Notification.updateMany({ recipient: req.user._id, readAt: null }, { readAt: new Date() });
    res.json({ success: true, message: 'Đã đánh dấu tất cả thông báo là đã đọc' });
  } catch (error) { next(error); }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Không tìm thấy thông báo' });
    const item = await Notification.findOneAndUpdate({ _id: req.params.id, recipient: req.user._id }, { readAt: new Date() }, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Không tìm thấy thông báo' });
    const data = item.toObject();
    data.link = await resolveNotificationLink(data);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});

module.exports = router;
