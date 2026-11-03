const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const mongoose = require('mongoose');
const { io: createClient } = require('socket.io-client');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('../test-utils/integrationDatabase');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'local_support_integration_secret_longer_than_32_characters';

const app = require('../src/app');
const Notification = require('../src/models/Notification');
const SupportConversation = require('../src/models/SupportConversation');
const SupportMessage = require('../src/models/SupportMessage');
const User = require('../src/models/User');
const { initializeChatGateway } = require('../src/realtime/chatGateway');
const { createAccessToken } = require('../src/services/authService');
const { uniqueToken, uniqueVietnamesePhone } = require('../test-utils/uniqueTestData');

const runIntegration = process.env.RUN_SUPPORT_INTEGRATION === '1';
const waitFor = (socket, event, timeout = 2500) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
  socket.once(event, value => { clearTimeout(timer); resolve(value); });
});
const join = (socket, conversationId) => new Promise(resolve => socket.emit('support:join', String(conversationId), resolve));

test('Support Chat lưu lịch sử Customer, phân quyền Staff, realtime và idempotency', { skip: !runIntegration }, async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const server = http.createServer(app);
  const io = initializeChatGateway(server);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const suffix = uniqueToken('support');
  const passwordHash = await User.hashPassword('StrongPass123');
  const [staff, otherStaff, customer] = await User.create([
    { name: 'Nhân viên Support Test', email: `${suffix}-staff@example.com`, phone: uniqueVietnamesePhone('094'), passwordHash, role: 'staff' },
    { name: 'Nhân viên Support Khác', email: `${suffix}-other-staff@example.com`, phone: uniqueVietnamesePhone('093'), passwordHash, role: 'staff' },
    { name: 'Khách không liên quan', email: `${suffix}-customer@example.com`, phone: uniqueVietnamesePhone('095'), passwordHash, role: 'customer' }
  ]);
  const accessToken = user => createAccessToken(user, new mongoose.Types.ObjectId());
  let conversationId;
  let customerSocket;
  let staffSocket;
  let otherStaffSocket;

  try {
    const firstClientMessageId = `guest_${suffix}`;
    const first = await fetch(`${origin}/api/support/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken(customer)}` },
      body: JSON.stringify({ content: 'Tôi cần tư vấn gia công.', clientMessageId: firstClientMessageId })
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    conversationId = firstBody.data.conversation._id;
    assert.equal(firstBody.data.socketToken, undefined);

    const session = await fetch(`${origin}/api/support/session`, { headers: { Authorization: `Bearer ${accessToken(customer)}` } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).data.conversation._id, conversationId);

    const duplicate = await fetch(`${origin}/api/support/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken(customer)}` },
      body: JSON.stringify({ content: 'Tôi cần tư vấn gia công.', clientMessageId: firstClientMessageId })
    });
    assert.equal(duplicate.status, 200);
    assert.equal(await SupportMessage.countDocuments({ conversation: conversationId, clientMessageId: firstClientMessageId }), 1);

    const forbidden = await fetch(`${origin}/api/support/conversations`, { headers: { Authorization: `Bearer ${accessToken(customer)}` } });
    assert.equal(forbidden.status, 403);

    customerSocket = createClient(`${origin}/support`, { transports: ['websocket'], auth: { token: accessToken(customer) } });
    staffSocket = createClient(`${origin}/support`, { transports: ['websocket'], auth: { token: accessToken(staff) } });
    otherStaffSocket = createClient(`${origin}/support`, { transports: ['websocket'], auth: { token: accessToken(otherStaff) } });
    await Promise.all([waitFor(customerSocket, 'connect'), waitFor(staffSocket, 'connect'), waitFor(otherStaffSocket, 'connect')]);
    assert.deepEqual(await join(customerSocket, conversationId), { ok: true });
    assert.deepEqual(await join(staffSocket, conversationId), { ok: true });
    assert.deepEqual(await join(otherStaffSocket, conversationId), { ok: true });
    assert.equal((await join(customerSocket, new mongoose.Types.ObjectId())).ok, false);

    const realtime = waitFor(customerSocket, 'support:message');
    let staleStaffLeaked = false;
    otherStaffSocket.once('support:message', () => { staleStaffLeaked = true; });
    const staffClientMessageId = `staff_${suffix}`;
    const reply = await fetch(`${origin}/api/support/conversations/${conversationId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken(staff)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'DK Industry đã tiếp nhận yêu cầu.', clientMessageId: staffClientMessageId })
    });
    assert.equal(reply.status, 201);
    assert.equal((await realtime).message.clientMessageId, staffClientMessageId);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(staleStaffLeaked, false);
    assert.equal((await fetch(`${origin}/api/support/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${accessToken(otherStaff)}` } })).status, 404);
    assert.equal((await join(otherStaffSocket, conversationId)).ok, false);

    const duplicateReply = await fetch(`${origin}/api/support/conversations/${conversationId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken(staff)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'DK Industry đã tiếp nhận yêu cầu.', clientMessageId: staffClientMessageId })
    });
    assert.equal(duplicateReply.status, 200);
    assert.equal(await SupportMessage.countDocuments({ conversation: conversationId, clientMessageId: staffClientMessageId }), 1);

    // Historical notifications must still open a closed conversation, while
    // an unknown ID must never fall back to another active conversation.
    await SupportConversation.updateOne({ _id: conversationId }, { status: 'closed' });
    const history = await fetch(`${origin}/api/support/session?conversationId=${conversationId}`, { headers: { Authorization: `Bearer ${accessToken(customer)}` } });
    assert.equal(history.status, 200);
    assert.equal((await history.json()).data.conversation._id, String(conversationId));
    const missingHistory = await fetch(`${origin}/api/support/session?conversationId=${new mongoose.Types.ObjectId()}`, { headers: { Authorization: `Bearer ${accessToken(customer)}` } });
    assert.equal(missingHistory.status, 404);
  } finally {
    customerSocket?.disconnect(); staffSocket?.disconnect(); otherStaffSocket?.disconnect();
    if (conversationId) {
      await SupportMessage.deleteMany({ conversation: conversationId });
      await SupportConversation.deleteOne({ _id: conversationId });
    }
    await Notification.deleteMany({ recipient: { $in: [staff._id, otherStaff._id, customer._id] } });
    await User.deleteMany({ _id: { $in: [staff._id, otherStaff._id, customer._id] } });
    await new Promise(resolve => io.close(resolve));
    await mongoose.disconnect();
  }
});
