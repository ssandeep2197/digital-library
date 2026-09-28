// Periodically sends due-soon reminders and overdue notices and expires uncollected holds.
// Each job is idempotent (dedupe keys + row locks), so running several instances is safe.
function startScheduler({ circulation, intervalMs, log = console }) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await circulation.runScheduledJobs();
      if (r.expiredHolds || r.dueSoon || r.overdue) {
        log.info(`[scheduler] holds expired=${r.expiredHolds} due-soon reminders=${r.dueSoon} overdue notices=${r.overdue}`);
      }
    } catch (err) {
      log.error(`[scheduler] ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  setImmediate(run);
  return { stop: () => clearInterval(timer), run };
}

module.exports = { startScheduler };
