// Resolve from stored entity IDs as well as the original URL so historical
// notifications keep working after a workspace route changes.
function notificationLink(notification) {
  const link = notification.link || '';
  if (!link.startsWith('/') || link.startsWith('//')) return '';
  const url = new URL(link, 'http://notification.local');
  if (url.origin !== 'http://notification.local') return '';
  const metadata = notification.metadata || {};
  const kind = notification.type?.split('.')[0];
  const staff = url.pathname.startsWith('/staff/');
  const set = (key, value) => { if (value) url.searchParams.set(key, String(value)); };
  if (kind === 'lead' && staff) {
    url.pathname = '/staff/requests';
    set('leadId', metadata.leadId);
  } else if (kind === 'support') {
    if (staff) set('conversationId', metadata.conversationId);
    else {
      set('supportConversationId', metadata.conversationId);
      set('support', 'open');
    }
  } else if (kind === 'order') {
    set('orderId', metadata.orderId);
  } else if (kind === 'work_order' || url.pathname === '/staff/work-orders') {
    set(staff ? 'workOrderId' : 'projectId', metadata.workOrderId);
  } else if (kind === 'request' || kind === 'quotation') {
    set('requestId', metadata.requestId);
    set('quotationId', metadata.quotationId);
    if (notification.type?.endsWith('_message')) set('tab', 'chat');
  } else if (kind === 'privacy') {
    set('privacyRequestId', metadata.privacyRequestId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

async function resolveNotificationLink(notification) {
  const metadata = { ...notification.metadata };
  // Older producers omitted requestId/orderId, but kept a quotation ID or
  // the unique order code. Repair these on read without a database migration.
  if (notification.type?.startsWith('quotation.') && !metadata.requestId && metadata.quotationId) {
    const quotation = await require('../models/Quotation').findById(metadata.quotationId).select('request').lean();
    metadata.requestId = quotation?.request;
  }
  if (notification.type?.startsWith('order.') && !metadata.orderId) {
    const code = notification.title?.match(/\bDH-\d{6}-[A-Z0-9]+\b/i)?.[0];
    if (code) {
      const order = await require('../models/Order').findOne({ code }).select('_id').lean();
      metadata.orderId = order?._id;
    }
  }
  return notificationLink({ ...notification, metadata });
}

module.exports = { notificationLink, resolveNotificationLink };
