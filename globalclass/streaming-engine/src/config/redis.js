import { createClient } from 'redis';

const client = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
  },
});
client.on('error', (err) => console.error('[Redis] error:', err.message));
client.connect();

export default client;
