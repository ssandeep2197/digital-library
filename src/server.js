const config = require('./config');
const { createPool, migrate } = require('./db');
const { createApp, createServices } = require('./app');
const { Dispatcher } = require('./notify/dispatcher');
const { createEmailTransport, createSmsTransport } = require('./notify/transports');
const { startScheduler } = require('./scheduler');

async function main() {
  if (config.production && config.apiKey.length < 24) {
    console.error('Refusing to start in production: API_KEY must be set to at least 24 characters (e.g. `openssl rand -hex 24`).');
    process.exit(1);
  }
  if (!config.apiKey) console.warn('[auth] API_KEY not set: staff endpoints are open to anyone (development only).');

  const pool = createPool(config.db);
  await migrate(pool);

  const email = createEmailTransport(config);
  const sms = createSmsTransport(config);
  console.info(`[notify] email: ${email.mode}, sms: ${sms.mode}`);

  const dispatcher = new Dispatcher({ pool, email, sms, options: config.dispatcher });
  dispatcher.on('failed', (n, err) => console.warn(`[dispatch] FAILED ${n.channel} #${n.id} to ${n.recipient} after ${n.attempts + 1} attempt(s): ${err.message}`));
  dispatcher.on('retry', (n, err) => console.info(`[dispatch] retry ${n.channel} #${n.id}: ${err.message}`));
  dispatcher.start();

  const services = createServices({ pool, config });
  const scheduler = config.scheduler.enabled ? startScheduler({ circulation: services.circulation, intervalMs: config.scheduler.intervalMs }) : null;

  const app = createApp({ pool, config, services, dispatcher, notifyModes: { email: email.mode, sms: sms.mode } });
  const server = app.listen(config.port, () => console.info(`${config.libraryName} running at ${config.baseUrl} (dashboard) and ${config.baseUrl}/api`));

  const shutdown = async (signal) => {
    console.info(`${signal} received, shutting down`);
    server.close();
    scheduler?.stop();
    await dispatcher.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
