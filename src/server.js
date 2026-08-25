import app from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './config/db.js';

async function start() {
  try {
    await connectDatabase();
    console.log('MongoDB connected');

    const server = app.listen(env.port, () => {
      console.log(`NPT ERP API listening on port ${env.port} (${env.nodeEnv})`);
    });

    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down`);
      server.close(() => process.exit(0));
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

start();
