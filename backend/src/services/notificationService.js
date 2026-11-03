const crypto = require('crypto');
const { notificationLink, resolveNotificationLink } = require('./notificationLinkService');
const Notification = require('../models/Notification');
const Quotation = require('../models/Quotation');
const ServiceRequest = require('../models/ServiceRequest');
const User = require('../models/User');
const { smtpConfigured } = require('../config/runtime');
const { notificationEmail, quotationEmail } = require('./emailTemplateService');
const { generateQuotationPdf } = require('./quotationDocumentService');

const emailMaxAttempts = () => Math.max(1, Math.min(10, Number(process.env.EMAIL_MAX_ATTEMPTS) || 5));
const directEmailMaxAttempts = () => Math.max(1, Math.min(5, Number(process.env.DIRECT_EMAIL_MAX_ATTEMPTS) || 3));
const retryDelayMs = attempt => Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attempt - 1)));
const directRetryDelayMs = attempt => Math.min(5000, 500 * (2 ** Math.max(0, attempt - 1)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function addressFromHeader(value) {
  return String(value || '').match(/<([^>]+)>/)?.[1]?.trim() || String(value || '').trim();
}

function buildMailOptions({ to, subject, text, html, attachments, category = 'transactional', referenceId }) {
  const from = process.env.SMTP_FROM || process.env.EMAIL_FROM;
  const fromAddress = addressFromHeader(from);
  const messageDomain = fromAddress.includes('@') ? fromAddress.split('@').pop().toLowerCase() : 'localhost';
  const safeCategory = String(category || 'transactional').replace(/[^a-z0-9._-]/gi, '-').slice(0, 64);
  const safeReference = String(referenceId || crypto.randomUUID()).replace(/[^a-z0-9._-]/gi, '-').slice(0, 100);
  return {
    from,
    replyTo: process.env.COMPANY_EMAIL || undefined,
    to,
    subject,
    text,
    html,
    attachments,
    date: new Date(),
    messageId: `<${crypto.randomUUID()}@${messageDomain}>`,
    headers: {
      'X-Entity-Ref-ID': safeReference,
      'X-Transactional-Category': safeCategory
    }
  };
}

function mailTransport(nodemailer) {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: Math.max(1000, Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 10000),
    greetingTimeout: Math.max(1000, Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10000),
    socketTimeout: Math.max(1000, Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 20000),
    tls: { minVersion: 'TLSv1.2', servername: process.env.SMTP_HOST },
    disableFileAccess: true,
    disableUrlAccess: true
  });
}

async function sendDirectEmail({ to, subject, text, html, attachments, category, referenceId }) {
  if (!smtpConfigured()) throw new Error('SMTP is not configured');
  const nodemailer = require('nodemailer');
  const transporter = mailTransport(nodemailer);
  let lastError;
  for (let attempt = 1; attempt <= directEmailMaxAttempts(); attempt += 1) {
    try {
      return await transporter.sendMail(buildMailOptions({ to, subject, text, html, attachments, category, referenceId }));
    } catch (error) {
      lastError = error;
      if (attempt < directEmailMaxAttempts()) await wait(directRetryDelayMs(attempt));
    }
  }
  throw Object.assign(new Error(`Direct email delivery failed after ${directEmailMaxAttempts()} attempts: ${lastError?.message || 'unknown SMTP error'}`), { cause: lastError });
}

async function createNotification({ recipient, type, title, message, link = '', metadata = {}, email, session = null }) {
  try {
    let emailAddress = email;
    if (emailAddress === undefined) {
      const query = User.findById(recipient).select('email').lean();
      if (session) query.session(session);
      emailAddress = (await query)?.email || '';
    }
    const document = {
      recipient, type, title, message, link: notificationLink({ type, link, metadata }), metadata,
      email: emailAddress
        ? { address: emailAddress, status: 'pending' }
        : { address: emailAddress || '', status: 'not_requested' }
    };
    const created = await Notification.create([document], session ? { session } : undefined);
    return created[0];
  } catch (error) {
    if (session) throw error;
    console.error('Cannot create notification:', error.message);
    return null;
  }
}

async function notifyRole(role, payload, session = null) {
  try {
    const query = User.find({
      role,
      status: 'active',
      emailVerifiedAt: { $exists: true, $ne: null }
    }).select('_id email').lean();
    if (session) query.session(session);
    const recipients = await query;
    return Promise.all(recipients.map(user => createNotification({ ...payload, recipient: user._id, email: user.email, session })));
  } catch (error) {
    if (session) throw error;
    console.error('Cannot notify operations:', error.message);
    return [];
  }
}

const notifyOperations = (payload, session = null) => notifyRole('staff', payload, session);
const notifyAdmins = (payload, session = null) => notifyRole('admin', payload, session);
const quoteAdminEmail = () => String(process.env.QUOTE_ADMIN_EMAIL || '').trim().toLowerCase();

async function notifyQuoteWatchers(payload, session = null) {
  const [staffNotes, adminNotes] = await Promise.all([
    notifyOperations(payload, session),
    notifyAdmins(payload, session)
  ]);
  const covered = new Set([...(staffNotes || []), ...(adminNotes || [])]
    .map(note => String(note?.email?.address || '').toLowerCase())
    .filter(Boolean));
  const extra = quoteAdminEmail();
  let extraDeliveryStatus = !extra ? 'not_configured' : covered.has(extra) ? 'covered' : session ? 'deferred' : 'pending';
  if (extra && !covered.has(extra) && !session) {
    const baseUrl = (process.env.CLIENT_URL || 'http://localhost:3000').split(',')[0].replace(/\/$/, '');
    const actionUrl = payload.link ? `${baseUrl}${payload.link.startsWith('/') ? '' : '/'}${payload.link}` : '';
    const mail = notificationEmail({ notification: payload, recipientName: 'Admin', actionUrl });
    try {
      await sendDirectEmail({ to: extra, subject: payload.title, text: mail.text, html: mail.html, category: payload.type, referenceId: payload.metadata?.requestId || payload.metadata?.leadId });
      extraDeliveryStatus = 'sent';
    } catch (error) {
      extraDeliveryStatus = 'failed';
      console.error('Extra quote watcher email failed:', error.message);
    }
  }
  return { staffNotes, adminNotes, coveredAddresses: [...covered], extraDeliveryStatus };
}

async function dispatchPendingEmails(limit = 25) {
  if (!smtpConfigured()) return { sent: 0, failed: 0 };
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch { return { sent: 0, failed: 0 }; }
  const transporter = mailTransport(nodemailer);
  let sent = 0;
  let failed = 0;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  // A process may stop between reserving and sending. Return that work to the
  // queue after a bounded lease instead of losing the notification forever.
  await Notification.updateMany(
    { 'email.status': 'sending', 'email.sendingAt': { $lt: staleBefore } },
    { $set: { 'email.status': 'pending', 'email.nextAttemptAt': now }, $unset: { 'email.sendingAt': 1 } }
  );
  for (let index = 0; index < limit; index += 1) {
    const notification = await Notification.findOneAndUpdate(
      {
        'email.status': 'pending',
        'email.address': { $ne: '' },
        'email.attempts': { $lt: emailMaxAttempts() },
        $or: [{ 'email.nextAttemptAt': { $exists: false } }, { 'email.nextAttemptAt': null }, { 'email.nextAttemptAt': { $lte: new Date() } }]
      },
      { $set: { 'email.status': 'sending', 'email.sendingAt': new Date() }, $inc: { 'email.attempts': 1 } },
      { new: true, sort: { createdAt: 1 } }
    );
    if (!notification) break;
    try {
      const baseUrl = (process.env.CLIENT_URL || '').split(',')[0];
      await notification.populate('recipient', 'name email company phone');
      const resolvedLink = await resolveNotificationLink(notification.toObject ? notification.toObject() : notification);
      const actionUrl = resolvedLink ? `${baseUrl.replace(/\/$/, '')}${resolvedLink}` : '';
      let emailContent;
      let attachments;
      if (['quotation.sent', 'quotation.confirmed'].includes(notification.type) && notification.metadata?.quotationId) {
        const [quotation, request] = await Promise.all([
          Quotation.findById(notification.metadata.quotationId).lean(),
          ServiceRequest.findById(notification.metadata.requestId).select('code title').lean()
        ]);
        if (!quotation || !request) throw new Error('Không tìm thấy dữ liệu để tạo email báo giá');
        // A retried initial email must remain unsigned even after acceptance.
        const confirmed = notification.type === 'quotation.confirmed';
        if (confirmed && quotation.status !== 'accepted') throw new Error('Chỉ được phát hành bản có dấu sau khi khách chấp thuận');
        const documentQuotation = { ...quotation, status: confirmed ? 'accepted' : 'sent' };
        emailContent = quotationEmail({ quotation: documentQuotation, request, customer: notification.recipient, actionUrl });
        attachments = [{ filename: `${confirmed ? 'Bao-gia-da-xac-nhan' : 'Bao-gia'}-${quotation.code}.pdf`, content: await generateQuotationPdf({ quotation: documentQuotation, request, customer: notification.recipient }), contentType: 'application/pdf' }];
      } else {
        emailContent = notificationEmail({ notification, recipientName: notification.recipient?.name, actionUrl });
      }
      await transporter.sendMail(buildMailOptions({
        to: notification.email.address,
        subject: notification.title,
        text: emailContent.text,
        html: emailContent.html,
        attachments,
        category: notification.type,
        referenceId: notification._id
      }));
      notification.email.status = 'sent';
      notification.email.sentAt = new Date();
      notification.email.error = undefined;
      notification.email.nextAttemptAt = undefined;
      notification.email.sendingAt = undefined;
      sent += 1;
    } catch (error) {
      const finalAttempt = notification.email.attempts >= emailMaxAttempts();
      notification.email.status = finalAttempt ? 'failed' : 'pending';
      notification.email.error = String(error.message || error).slice(0, 500);
      notification.email.sendingAt = undefined;
      notification.email.nextAttemptAt = finalAttempt ? undefined : new Date(Date.now() + retryDelayMs(notification.email.attempts));
      failed += 1;
    }
    await notification.save();
  }
  return { sent, failed };
}

function dispatchSoon() {
  if (process.env.NODE_ENV === 'test') return;
  setImmediate(() => dispatchPendingEmails().catch(error => console.error('Notification email dispatch failed:', error.message)));
}

module.exports = { buildMailOptions, createNotification, notifyOperations, notifyAdmins, notifyQuoteWatchers, quoteAdminEmail, dispatchPendingEmails, dispatchSoon, mailTransport, smtpConfigured, sendDirectEmail };
