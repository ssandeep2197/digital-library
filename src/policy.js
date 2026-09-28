const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

// Whole days late, counting any started day. Returned on the due date → 0.
function daysOverdue(dueAt, at = new Date()) {
  const late = at.getTime() - dueAt.getTime();
  return late <= 0 ? 0 : Math.ceil(late / DAY_MS);
}

function fineFor(dueAt, at, { finePerDayCents, maxFineCents }) {
  return Math.min(daysOverdue(dueAt, at) * finePerDayCents, maxFineCents);
}

const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

const formatDate = (date) =>
  date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

module.exports = { DAY_MS, addDays, daysOverdue, fineFor, formatCents, formatDate };
