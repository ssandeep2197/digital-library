const { formatCents, formatDate } = require('../policy');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Each template returns the email subject/text and a short SMS body (kept under ~160 chars
// where possible so it fits one segment). `d` always includes library and member name.
const templates = {
  due_soon: (d) => ({
    subject: `Reminder: "${d.title}" is due ${formatDate(d.dueAt)}`,
    text: [
      `Hi ${d.memberName},`,
      '',
      `"${d.title}" by ${d.author} is due back on ${formatDate(d.dueAt)}.`,
      d.canRenew
        ? 'You can renew it at the desk or through the library app if you need more time.'
        : 'This item cannot be renewed, so please return it on time.',
    ],
    sms: `${d.library}: "${truncate(d.title, 50)}" is due ${formatDate(d.dueAt)}.`,
  }),

  overdue: (d) => ({
    subject: `Overdue: "${d.title}" was due ${formatDate(d.dueAt)}`,
    text: [
      `Hi ${d.memberName},`,
      '',
      `"${d.title}" by ${d.author} was due on ${formatDate(d.dueAt)} and is now ${d.daysOverdue} day(s) overdue.`,
      `Fines so far: ${formatCents(d.fineCents)} (${formatCents(d.finePerDayCents)} per day, capped at ${formatCents(d.maxFineCents)}).`,
      'Please return it as soon as possible.',
    ],
    sms: `${d.library}: "${truncate(d.title, 40)}" is ${d.daysOverdue}d overdue. Fine so far ${formatCents(d.fineCents)}. Please return it.`,
  }),

  reservation_placed: (d) => ({
    subject: `Reservation confirmed: "${d.title}"`,
    text: [
      `Hi ${d.memberName},`,
      '',
      `You're on the list for "${d.title}" by ${d.author}. Your position in the queue: ${d.position}.`,
      "We'll let you know as soon as a copy is ready for you.",
    ],
    sms: `${d.library}: You're #${d.position} in line for "${truncate(d.title, 50)}". We'll text you when it's ready.`,
  }),

  reservation_ready: (d) => ({
    subject: `Ready for pickup: "${d.title}"`,
    text: [
      `Hi ${d.memberName},`,
      '',
      `Good news: "${d.title}" by ${d.author} is waiting for you at the front desk.`,
      `We'll hold it until ${formatDate(d.expiresAt)}. After that it goes to the next person in line.`,
      d.barcode ? `Copy: ${d.barcode}` : null,
    ],
    sms: `${d.library}: "${truncate(d.title, 50)}" is ready for pickup. Held until ${formatDate(d.expiresAt)}.`,
  }),

  hold_expired: (d) => ({
    subject: `Hold expired: "${d.title}"`,
    text: [
      `Hi ${d.memberName},`,
      '',
      `Your hold on "${d.title}" expired on ${formatDate(d.expiresAt)} and the copy has been released.`,
      'You can place a new reservation at any time.',
    ],
    sms: `${d.library}: Your hold on "${truncate(d.title, 50)}" expired. Reserve again anytime.`,
  }),
};

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function render(type, data) {
  const template = templates[type];
  if (!template) throw new Error(`Unknown notification type: ${type}`);
  const t = template(data);
  const lines = t.text.filter((line) => line !== null);
  lines.push('', `— ${data.library}`);
  const text = lines.join('\n');
  const html = lines.map((line) => (line === '' ? '<br>' : `<p style="margin:0 0 4px">${escapeHtml(line)}</p>`)).join('\n');
  return { subject: t.subject, text, html, sms: t.sms };
}

module.exports = { render, types: Object.keys(templates) };
