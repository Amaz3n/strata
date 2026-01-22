#!/usr/bin/env node

import http from 'node:http';
import { Worker } from './worker';

async function main() {
  console.log('🚀 Starting drawings worker...');

  const worker = new Worker();
  const port = Number(process.env.PORT ?? 8080);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  server.listen(port, () => {
    console.log(`🛰️  Health-check server listening on port ${port}`);
  });

  async function shutdown(signal: string) {
    console.log(`🛑 Received ${signal}, shutting down gracefully...`);
    server.close();
    await worker.stop();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught exception, shutting down:', error);
    await shutdown('uncaughtException');
  });

  await worker.start();
}

main().catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});