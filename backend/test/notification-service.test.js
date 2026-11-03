const test = require('node:test');
const assert = require('node:assert/strict');
const Notification = require('../src/models/Notification');
const User = require('../src/models/User');
const Quotation = require('../src/models/Quotation');
const ServiceRequest = require('../src/models/ServiceRequest');
const nodemailer = require('nodemailer');
const { dispatchPendingEmails } = require('../src/services/notificationService');
const { buildMailOptions, createNotification, mailTransport, notifyAdmins, notifyOperations, quoteAdminEmail, sendDirectEmail } = require('../src/services/notificationService');

const managedKeys = ['NODE_ENV', 'EMAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'SMTP_FROM', 'COMPANY_EMAIL', 'QUOTE_ADMIN_EMAIL'];

test('retrying an initial quotation email after acceptance never attaches the director stamp', () => withEnv({
  SMTP_HOST: 'smtp.example.com', SMTP_USER: 'robot@example.com', SMTP_PASS: 'test-only', EMAIL_FROM: 'robot@example.com'
}, async () => {
  const originals = {
    updateMany: Notification.updateMany, findOneAndUpdate: Notification.findOneAndUpdate,
    quote: Quotation.findById, request: ServiceRequest.findById, transport: nodemailer.createTransport
  };
  const mails = [];
  const notes = ['quotation.sent', 'quotation.confirmed'].map(type => ({
    type, title: type, metadata: { quotationId: 'quote', requestId: 'request' },
    email: { address: 'customer@customer.vn' },
    recipient: { name: 'Customer' }, populate: async () => {}, save: async () => {}
  }));
  Notification.updateMany = async () => ({});
  Notification.findOneAndUpdate = async () => notes.shift();
  Quotation.findById = () => ({ lean: async () => ({
    status: 'accepted', code: 'BG-RETRY', senderName: 'Staff', total: 100,
    items: [{ description: 'Item', quantity: 1, unit: 'cái', unitPrice: 100, lineTotal: 100 }],
    validUntil: new Date('2027-01-01')
  }) });
  ServiceRequest.findById = () => ({ select: () => ({ lean: async () => ({ title: 'Request' }) }) });
  nodemailer.createTransport = () => ({ sendMail: async mail => { mails.push(mail); } });
  try {
    assert.deepEqual(await dispatchPendingEmails(2), { sent: 2, failed: 0 });
    assert.match(mails[0].attachments[0].filename, /^Bao-gia-BG/);
    assert.doesNotMatch(mails[0].attachments[0].content.toString('latin1'), /\/DCTDecode/);
    assert.match(mails[1].attachments[0].filename, /^Bao-gia-da-xac-nhan/);
    assert.match(mails[1].attachments[0].content.toString('latin1'), /\/DCTDecode/);
  } finally {
    Notification.updateMany = originals.updateMany;
    Notification.findOneAndUpdate = originals.findOneAndUpdate;
    Quotation.findById = originals.quote;
    ServiceRequest.findById = originals.request;
    nodemailer.createTransport = originals.transport;
  }
}));

function withEnv(values, work) {
  const previous = Object.fromEntries(managedKeys.map(key => [key, process.env[key]]));
  for (const key of managedKeys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve().then(work).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('transactional mail uses an aligned Message-ID and trace headers', () => withEnv({
  EMAIL_FROM: 'DK Industry <mail@dkindustry.vn>', COMPANY_EMAIL: 'contact@dkindustry.vn'
}, () => {
  const options = buildMailOptions({ to: 'customer@example.com', subject: 'Báo giá BG-001', text: 'Nội dung', html: '<p>Nội dung</p>', category: 'quotation.sent', referenceId: 'BG-001' });
  assert.match(options.messageId, /^<[0-9a-f-]+@dkindustry\.vn>$/);
  assert.equal(options.replyTo, 'contact@dkindustry.vn');
  assert.equal(options.headers['X-Transactional-Category'], 'quotation.sent');
  assert.equal(options.headers['X-Entity-Ref-ID'], 'BG-001');
  assert.ok(options.date instanceof Date);
}));

test('mail headers use safe fallbacks when optional sender metadata is absent', () => withEnv({
  SMTP_FROM: 'robot@example.com'
}, () => {
  const options = buildMailOptions({
    to: 'customer@example.com',
    subject: 'Test',
    text: 'Test',
    category: 'quote created / urgent',
    referenceId: 'REQ 001/2026'
  });
  assert.equal(options.replyTo, undefined);
  assert.match(options.messageId, /^<[0-9a-f-]+@example\.com>$/);
  assert.equal(options.headers['X-Transactional-Category'], 'quote-created---urgent');
  assert.equal(options.headers['X-Entity-Ref-ID'], 'REQ-001-2026');
}));

test('SMTP transport requires modern TLS on submission port', () => withEnv({
  NODE_ENV: 'development', EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'true', SMTP_USER: 'mail@example.com', SMTP_PASS: 'secret'
}, () => {
  let captured;
  mailTransport({ createTransport: options => { captured = options; return {}; } });
  assert.equal(captured.requireTLS, true);
  assert.equal(captured.tls.minVersion, 'TLSv1.2');
  assert.equal(captured.tls.servername, 'smtp.example.com');
}));

test('implicit TLS transport does not require SMTP auth or STARTTLS', () => withEnv({
  NODE_ENV: 'development', EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true'
}, () => {
  let captured;
  mailTransport({ createTransport: options => { captured = options; return {}; } });
  assert.equal(captured.secure, true);
  assert.equal(captured.requireTLS, false);
  assert.equal(captured.auth, undefined);
}));

test('extra quote mailbox has no personal hard-coded fallback', () => withEnv({}, () => {
  assert.equal(quoteAdminEmail(), '');
}));

test('extra quote mailbox is normalized before recipient comparison', () => withEnv({
  QUOTE_ADMIN_EMAIL: '  Quotes@Example.COM  '
}, () => {
  assert.equal(quoteAdminEmail(), 'quotes@example.com');
}));

test('direct email fails explicitly when SMTP is unavailable', () => withEnv({ NODE_ENV: 'development' }, async () => {
  await assert.rejects(sendDirectEmail({ to: 'customer@customer.vn', subject: 'Test', text: 'Test' }), /SMTP is not configured/);
}));

test('notification remains pending during an SMTP outage instead of being skipped', () => withEnv({}, async () => {
  const originalFindById = User.findById;
  const originalCreate = Notification.create;
  User.findById = () => ({ select: () => ({ lean: () => Promise.resolve({ email: 'staff@dkindustry.vn' }) }) });
  Notification.create = async documents => documents.map(document => ({ ...document, _id: 'notification-1' }));
  try {
    const notification = await createNotification({ recipient: '507f1f77bcf86cd799439011', type: 'request.created', title: 'Yêu cầu mới', message: 'Kiểm tra' });
    assert.equal(notification.email.address, 'staff@dkindustry.vn');
    assert.equal(notification.email.status, 'pending');
  } finally {
    User.findById = originalFindById;
    Notification.create = originalCreate;
  }
}));

test('notification without an email is stored without requesting delivery', async () => {
  const originalCreate = Notification.create;
  let stored;
  Notification.create = async documents => {
    [stored] = documents;
    return [{ ...stored, _id: 'notification-2' }];
  };
  try {
    const notification = await createNotification({
      recipient: '507f1f77bcf86cd799439011',
      type: 'request.created',
      title: 'Yêu cầu mới',
      message: 'Kiểm tra',
      email: ''
    });
    assert.equal(stored.email.address, '');
    assert.equal(stored.email.status, 'not_requested');
    assert.equal(notification._id, 'notification-2');
  } finally {
    Notification.create = originalCreate;
  }
});

test('role notifications only target active users with verified email addresses', async () => {
  const originalFind = User.find;
  const capturedFilters = [];
  User.find = filter => {
    capturedFilters.push(filter);
    return { select: () => ({ lean: () => Promise.resolve([]) }) };
  };
  try {
    const payload = { type: 'request.created', title: 'Yêu cầu mới', message: 'Kiểm tra' };
    await notifyOperations(payload);
    await notifyAdmins(payload);
    assert.deepEqual(capturedFilters, [
      { role: 'staff', status: 'active', emailVerifiedAt: { $exists: true, $ne: null } },
      { role: 'admin', status: 'active', emailVerifiedAt: { $exists: true, $ne: null } }
    ]);
  } finally {
    User.find = originalFind;
  }
});

test('test mode cannot use SMTP even with real-style credentials and an explicit smtp setting', () => withEnv({
  NODE_ENV: 'test', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com',
  SMTP_USER: 'sender@company.vn', SMTP_PASS: 'test-only', EMAIL_FROM: 'sender@company.vn'
}, () => {
  let captured;
  mailTransport({ createTransport: options => { captured = options; return {}; } });
  assert.deepEqual(captured, { jsonTransport: true });
}));

test('direct mail in test mode renders mail locally without SMTP credentials', () => withEnv({
  NODE_ENV: 'test', EMAIL_FROM: 'sender@company.vn'
}, async () => {
  const result = await sendDirectEmail({ to: 'customer@customer.vn', subject: 'Local test mail', text: 'Rendered without a network delivery' });
  const message = JSON.parse(result.message);
  assert.equal(message.to[0].address, 'customer@customer.vn');
  assert.equal(message.subject, 'Local test mail');
  assert.equal(message.text, 'Rendered without a network delivery');
}));

test('local json mode also renders direct mail without SMTP credentials', () => withEnv({
  NODE_ENV: 'development', EMAIL_TRANSPORT: 'json', EMAIL_FROM: 'sender@company.vn'
}, async () => {
  const result = await sendDirectEmail({ to: 'customer@customer.vn', subject: 'Preview', text: 'Preview only' });
  assert.equal(JSON.parse(result.message).subject, 'Preview');
}));

test('reserved fixture recipients never reach SMTP, including mixed recipient lists', () => withEnv({
  NODE_ENV: 'production', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com',
  SMTP_USER: 'sender@company.vn', SMTP_PASS: 'test-only', EMAIL_FROM: 'sender@company.vn'
}, async () => {
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => { throw new Error('Fixture mail must not create a transport'); };
  try {
    const recipients = [
      'lead-test@example.com', 'purchasing@anphat.example', 'customer@example.org',
      'customer@sub.example.net', 'customer@fixture.test', 'customer@fixture.invalid',
      'customer@localhost', 'customer@sub.localhost',
      'Real <customer@customer.vn>, Fixture <lead-test@example.com>',
      ['customer@customer.vn', { address: 'purchasing@anphat.example' }]
    ];
    for (const to of recipients) {
      const result = await sendDirectEmail({ to, subject: 'Fixture', text: 'Not deliverable' });
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'reserved_recipient');
    }
  } finally { nodemailer.createTransport = original; }
}));

test('real recipients continue to use configured SMTP outside test mode', () => withEnv({
  NODE_ENV: 'production', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com',
  SMTP_USER: 'sender@company.vn', SMTP_PASS: 'test-only', EMAIL_FROM: 'sender@company.vn'
}, async () => {
  const original = nodemailer.createTransport;
  const deliveries = [];
  nodemailer.createTransport = options => {
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.jsonTransport, undefined);
    return { sendMail: async mail => { deliveries.push(mail); return { messageId: 'smtp-message' }; } };
  };
  try {
    assert.equal((await sendDirectEmail({ to: 'customer@customer.vn', subject: 'Real mail', text: 'Mail' })).messageId, 'smtp-message');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].to, 'customer@customer.vn');
  } finally { nodemailer.createTransport = original; }
}));

test('fixture notifications stay visible in-app without entering the email queue', async () => {
  const original = Notification.create;
  Notification.create = async documents => documents;
  try {
    const result = await createNotification({ recipient: '507f1f77bcf86cd799439011', type: 'lead.created', title: 'Fixture', message: 'In-app only', email: 'lead-test@example.com' });
    assert.equal(result.title, 'Fixture');
    assert.equal(result.email.address, 'lead-test@example.com');
    assert.equal(result.email.status, 'not_requested');
  } finally { Notification.create = original; }
});

test('old queued fixture mail is retired permanently without delivery or retries', () => withEnv({
  NODE_ENV: 'test', EMAIL_FROM: 'sender@company.vn'
}, async () => {
  const originals = { updateMany: Notification.updateMany, findOneAndUpdate: Notification.findOneAndUpdate, transport: nodemailer.createTransport };
  let deliveries = 0;
  let saves = 0;
  const fixture = { email: { address: 'purchasing@anphat.example', status: 'pending', attempts: 1, sendingAt: new Date() }, save: async () => { saves += 1; } };
  const queue = [fixture];
  Notification.updateMany = async () => ({});
  Notification.findOneAndUpdate = async () => queue.shift();
  nodemailer.createTransport = options => {
    assert.deepEqual(options, { jsonTransport: true });
    return { sendMail: async () => { deliveries += 1; } };
  };
  try {
    assert.deepEqual(await dispatchPendingEmails(2), { sent: 0, failed: 1 });
    assert.equal(deliveries, 0);
    assert.equal(saves, 1);
    assert.equal(fixture.email.status, 'failed');
    assert.match(fixture.email.error, /reserved example\/test recipient/);
    assert.equal(fixture.email.nextAttemptAt, undefined);
    assert.equal(fixture.email.sendingAt, undefined);
  } finally {
    Notification.updateMany = originals.updateMany;
    Notification.findOneAndUpdate = originals.findOneAndUpdate;
    nodemailer.createTransport = originals.transport;
  }
}));
