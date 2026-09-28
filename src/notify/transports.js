const nodemailer = require('nodemailer');

// Errors marked permanent are not retried (bad address, rejected by the provider).
class DeliveryError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.permanent = permanent;
  }
}

function createEmailTransport({ smtp, mailFrom }, log = console) {
  if (!smtp.host) {
    // Development: build the full message but don't send it anywhere.
    const transport = nodemailer.createTransport({ jsonTransport: true });
    return {
      mode: 'simulated',
      async send({ to, subject, text }) {
        const info = await transport.sendMail({ from: mailFrom, to, subject, text });
        log.info(`[email:simulated] to=${to} subject="${subject}"`);
        return { providerId: info.messageId };
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return {
    mode: 'smtp',
    async send({ to, subject, text, html }) {
      try {
        const info = await transport.sendMail({ from: mailFrom, to, subject, text, html });
        return { providerId: info.messageId };
      } catch (err) {
        // SMTP 5xx = permanent rejection; 4xx and network errors are worth retrying.
        throw new DeliveryError(err.message, { permanent: err.responseCode >= 500 });
      }
    },
  };
}

function createSmsTransport({ twilio }, log = console, fetchImpl = globalThis.fetch) {
  if (!twilio.accountSid || !twilio.authToken || !twilio.from) {
    let n = 0;
    return {
      mode: 'simulated',
      async send({ to, body }) {
        log.info(`[sms:simulated] to=${to} body="${body}"`);
        return { providerId: `SIM${Date.now()}${++n}` };
      },
    };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`;
  const authHeader = `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64')}`;
  return {
    mode: 'twilio',
    async send({ to, body }) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, From: twilio.from, Body: body }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        throw new DeliveryError(`Twilio request failed: ${err.message}`);
      }
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 429 and 5xx are transient; other 4xx (invalid number, unsubscribed, bad auth) are not.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw new DeliveryError(`Twilio ${res.status}${payload.code ? ` (${payload.code})` : ''}: ${payload.message || res.statusText}`, { permanent });
      }
      return { providerId: payload.sid };
    },
  };
}

module.exports = { DeliveryError, createEmailTransport, createSmsTransport };
