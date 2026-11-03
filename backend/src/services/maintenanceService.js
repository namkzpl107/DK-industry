const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const Quotation = require('../models/Quotation');
const QuarantinedUpload = require('../models/QuarantinedUpload');
const RequestMessage = require('../models/RequestMessage');
const ServiceRequest = require('../models/ServiceRequest');
const { createNotification, dispatchPendingEmails } = require('./notificationService');
const { removeStoredFiles } = require('./fileStorageService');

async function expireQuotations() {
  const expired = await Quotation.find({ status: 'sent', validUntil: { $lte: new Date() } }).select('_id code request customer').lean();
  if (!expired.length) return 0;
  const ids = expired.map(item => item._id);
  await Quotation.updateMany({ _id: { $in: ids }, status: 'sent' }, { status: 'expired' });
  for (const quotation of expired) {
    const request = await ServiceRequest.findOneAndUpdate(
      { _id: quotation.request, status: 'quoted' },
      { $set: { status: 'reviewing', closedAt: null }, $push: { timeline: { status: 'reviewing', message: `Báo giá ${quotation.code} đã hết hiệu lực.`, actorType: 'system' } } },
      { new: true }
    );
    if (request) {
      await RequestMessage.create({ request: request._id, senderRole: 'system', visibility: 'customer', content: `Báo giá ${quotation.code} đã hết hiệu lực. Vui lòng phản hồi nếu bạn cần báo giá cập nhật.` });
      await createNotification({ recipient: quotation.customer, type: 'quotation.expired', title: `Báo giá ${quotation.code} đã hết hiệu lực`, message: 'Yêu cầu đã được mở lại để đội ngũ cập nhật báo giá khi cần.', link: `/tai-khoan/yeu-cau?requestId=${request._id}`, metadata: { requestId: request._id, quotationId: quotation._id } });
    }
  }
  return expired.length;
}

async function remindOverdueLeads() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const leads = await Lead.find({ assignedTo: { $ne: null }, nextFollowUpAt: { $lte: now }, status: { $nin: ['won', 'lost', 'spam'] } }).select('_id code name assignedTo nextFollowUpAt').lean();
  let created = 0;
  for (const lead of leads) {
    const exists = await Notification.exists({ recipient: lead.assignedTo, type: 'lead.follow_up_overdue', 'metadata.leadId': lead._id, createdAt: { $gte: startOfDay } });
    if (!exists) {
      await createNotification({ recipient: lead.assignedTo, type: 'lead.follow_up_overdue', title: `Lead ${lead.code} đến hạn chăm sóc`, message: `Cần liên hệ lại ${lead.name}.`, link: `/staff/requests?leadId=${lead._id}`, metadata: { leadId: lead._id } });
      created += 1;
    }
  }
  return created;
}

async function purgeExpiredQuarantine() {
  const items = await QuarantinedUpload.find({ purgeAfter: { $lte: new Date() } }).select('+storedName').limit(100);
  if (!items.length) return 0;
  await removeStoredFiles(items);
  await QuarantinedUpload.deleteMany({ _id: { $in: items.map(item => item._id) } });
  return items.length;
}

async function runMaintenance() {
  const [expiredQuotations, leadReminders, purgedQuarantine] = await Promise.all([expireQuotations(), remindOverdueLeads(), purgeExpiredQuarantine()]);
  const email = await dispatchPendingEmails();
  return { expiredQuotations, leadReminders, purgedQuarantine, email };
}

module.exports = { expireQuotations, purgeExpiredQuarantine, remindOverdueLeads, runMaintenance };
