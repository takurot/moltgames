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
};

start();
