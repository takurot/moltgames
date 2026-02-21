import { createApp } from './app.js';

const start = async () => {
  const app = await createApp();
  const port = Number(process.env.PORT) || 8080;

  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const signalHandler = async (signal: string) => {
    app.log.info({ signal }, 'Received signal, shutting down...');
    try {
      await app.close();
      app.log.info('Server closed');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => signalHandler('SIGINT'));
  process.on('SIGTERM', () => signalHandler('SIGTERM'));
};

start();
