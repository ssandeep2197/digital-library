const { EventEmitter } = require('events');
const { withTransaction } = require('../db');

const LEASE_MS = 5 * 60 * 1000;

// Delivers pending rows from the notifications outbox. Rows are claimed with
// FOR UPDATE SKIP LOCKED and leased by pushing next_attempt_at forward, so several app
// instances can run dispatchers without sending the same message twice.
class Dispatcher extends EventEmitter {
  constructor({ pool, email, sms, options, log = console }) {
    super();
    this.pool = pool;
    this.transports = { email, sms };
    this.options = options;
    this.log = log;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => this.log.error(`[dispatch] ${err.message}`)), this.options.intervalMs);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  // Sends one batch. Returns the number of notifications processed.
  async tick() {
    if (this.running) return 0;
    this.running = this.#runBatch();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async #runBatch() {
    const now = new Date();
    const batch = await withTransaction(this.pool, async (conn) => {
      const [rows] = await conn.query(
        `SELECT * FROM notifications
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, this.options.batchSize],
      );
      if (rows.length) {
        await conn.query('UPDATE notifications SET next_attempt_at = ? WHERE id IN (?)', [
          new Date(now.getTime() + LEASE_MS),
          rows.map((r) => r.id),
        ]);
      }
      return rows;
    });

    for (const n of batch) await this.#deliver(n);
    return batch.length;
  }

  async #deliver(n) {
    const attempts = n.attempts + 1;
    try {
      const transport = this.transports[n.channel];
      const { providerId } =
        n.channel === 'email'
          ? await transport.send({ to: n.recipient, subject: n.subject, text: n.body })
          : await transport.send({ to: n.recipient, body: n.body });
      await this.pool.query(
        `UPDATE notifications SET status = 'sent', attempts = ?, provider_id = ?, sent_at = ?, last_error = NULL WHERE id = ?`,
        [attempts, providerId || null, new Date(), n.id],
      );
      this.emit('sent', n);
    } catch (err) {
      const giveUp = err.permanent || attempts >= this.options.maxAttempts;
      // Exponential backoff with jitter: backoff, 2×, 4×, …
      const delay = this.options.backoffMs * 2 ** (attempts - 1) * (0.8 + Math.random() * 0.4);
      await this.pool.query(
        `UPDATE notifications SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`,
        [giveUp ? 'failed' : 'pending', attempts, String(err.message).slice(0, 500), new Date(Date.now() + delay), n.id],
      );
      this.emit(giveUp ? 'failed' : 'retry', n, err);
    }
  }
}

module.exports = { Dispatcher };
