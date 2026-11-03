const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notificationLink, resolveNotificationLink } = require('../src/services/notificationLinkService');

test('old follow-up reminders open the specific lead in the current workspace', () => {
  for (const leadId of ['customer-a', 'customer-b']) {
    const link = notificationLink({ type: 'lead.follow_up_overdue', link: '/staff/leads', metadata: { leadId } });
    assert.equal(link, `/staff/requests?leadId=${leadId}`);
  }
});

test('request messages open the matching request and expand chat, preserving filters', () => {
  const link = notificationLink({ type: 'request.customer_message', link: '/staff/requests?requestId=a&view=mine', metadata: { requestId: 'b' } });
  const url = new URL(link, 'http://localhost');
  assert.equal(url.pathname, '/staff/requests');
  assert.equal(url.searchParams.get('requestId'), 'b');
  assert.equal(url.searchParams.get('view'), 'mine');
  assert.equal(url.searchParams.get('tab'), 'chat');
});

test('support messages target a conversation for staff and open the customer widget', () => {
  assert.equal(notificationLink({ type: 'support.customer_message', link: '/staff/support', metadata: { conversationId: 'chat-a' } }), '/staff/support?conversationId=chat-a');
  assert.equal(notificationLink({ type: 'support.staff_message', link: '/', metadata: { conversationId: 'chat-a' } }), '/?supportConversationId=chat-a&support=open');
});

test('orders, projects, quotations and privacy use their own detail identifiers', () => {
  const cases = [
    ['order.created', '/staff/orders', { orderId: 'o' }, 'orderId', 'o'],
    ['order.updated', '/tai-khoan/don-hang', { orderId: 'o' }, 'orderId', 'o'],
    ['work_order.repair', '/staff/work-orders', { workOrderId: 'w' }, 'workOrderId', 'w'],
    ['work_order.completed', '/tai-khoan/du-an', { workOrderId: 'w' }, 'projectId', 'w'],
    ['quotation.sent', '/tai-khoan/yeu-cau', { requestId: 'r', quotationId: 'q' }, 'quotationId', 'q'],
    ['privacy.deletion_requested', '/admin/quyen-rieng-tu', { privacyRequestId: 'p' }, 'privacyRequestId', 'p'],
  ];
  for (const [type, link, metadata, key, value] of cases) {
    assert.equal(new URL(notificationLink({ type, link, metadata }), 'http://localhost').searchParams.get(key), value);
  }
  // Accepted quotations already point to their new project: retain that target.
  assert.equal(notificationLink({ type: 'quotation.accepted', link: '/staff/work-orders?workOrderId=w', metadata: { requestId: 'r', workOrderId: 'w' } }), '/staff/work-orders?workOrderId=w');
});

test('historical expired quotations recover requestId from the saved quotation', async () => {
  const Quotation = require('../src/models/Quotation');
  const original = Quotation.findById;
  Quotation.findById = id => {
    assert.equal(id, 'quote-a');
    return { select: () => ({ lean: async () => ({ request: 'request-a' }) }) };
  };
  try {
    const result = await resolveNotificationLink({ type: 'quotation.expired', link: '/tai-khoan/yeu-cau', metadata: { quotationId: 'quote-a' } });
    assert.equal(new URL(result, 'http://localhost').searchParams.get('requestId'), 'request-a');
  } finally { Quotation.findById = original; }
});

test('historical order updates recover their exact order from its unique code', async () => {
  const Order = require('../src/models/Order');
  const original = Order.findOne;
  Order.findOne = filter => {
    assert.deepEqual(filter, { code: 'DH-260922-ABC123' });
    return { select: () => ({ lean: async () => ({ _id: 'order-a' }) }) };
  };
  try {
    assert.equal(await resolveNotificationLink({ type: 'order.updated', title: 'Đơn hàng DH-260922-ABC123 đã cập nhật', link: '/tai-khoan/don-hang' }), '/tai-khoan/don-hang?orderId=order-a');
  } finally { Order.findOne = original; }
});

test('notification destinations stay inside the application', () => {
  for (const link of ['https://example.com', '//example.com', '/\\example.com', 'javascript:alert(1)']) {
    assert.equal(notificationLink({ link }), '');
  }
});
