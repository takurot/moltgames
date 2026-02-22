import { createServer } from './server.js';
import { fileURLToPath } from 'url';

export const ENGINE_SERVICE_NAME = '@moltgames/engine';

export const getEngineBootstrapInfo = () => ({
  service: ENGINE_SERVICE_NAME,
  runtime: 'node',
});

const start = async () => {
  try {
    const { fastify } = await createServer();
    const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
    await fastify.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}
