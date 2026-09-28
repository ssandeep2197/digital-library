const { render } = require('./templates');

// Queues a notification on every channel the member has opted into. Call it with the
// transaction's connection so the notification only exists if the event commits.
// dedupeKey makes repeated scheduler runs idempotent (INSERT IGNORE on a unique key).
async function enqueue(conn, { member, type, data, dedupeKey = null, library }) {
  const message = render(type, { ...data, memberName: member.name, library });
  const rows = [];
  if (member.notify_email && member.email) {
    rows.push(['email', member.email, message.subject, message.text]);
  }
  if (member.notify_sms && member.phone) {
    rows.push(['sms', member.phone, null, message.sms]);
  }
  let queued = 0;
  for (const [channel, recipient, subject, body] of rows) {
    const [result] = await conn.query(
      `INSERT IGNORE INTO notifications (member_id, channel, type, recipient, subject, body, dedupe_key, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [member.id, channel, type, recipient, subject, body, dedupeKey && `${dedupeKey}:${channel}`, new Date()],
    );
    queued += result.affectedRows;
  }
  return queued;
}

module.exports = { enqueue };
