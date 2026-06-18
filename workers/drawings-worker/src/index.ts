#!/usr/bin/env node

import http from 'node:http';
import { initObservability, workerLogger } from './observability';
import { Worker, type ProcessOptions } from './worker';

initObservability();

async function main() {
  const worker = new Worker();
  const processOnce = process.argv.includes('--once');
  const processPath = process.env.DRAWINGS_WORKER_PROCESS_PATH ?? '/process';

  if (processOnce) {
    const summary = await worker.processAvailableJobs(readProcessOptionsFromEnv());
    workerLogger.info('drawings_worker.once.completed', { summary });
    return;
  }

  const port = Number(process.env.PORT ?? 8080);
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      if (method === 'GET' && (pathname === '/' || pathname === '/health')) {
        sendJson(res, 200, { ok: true, service: 'drawings-worker' });
        return;
      }

      if (method === 'POST' && pathname === processPath) {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }

        const body = await readJsonBody(req);
        const options = readProcessOptions(body);
        const summary = await worker.processAvailableJobs(options);
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      workerLogger.error('drawings_worker.request.failed', { error });
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(port, () => {
    workerLogger.info('drawings_worker.server.started', { port, processPath });
  });

  async function shutdown(signal: string) {
    workerLogger.info('drawings_worker.server.shutdown', { signal });
    server.close();
    await workerLogger.flush();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', async (error) => {
    workerLogger.error('drawings_worker.uncaught_exception', { error });
    await shutdown('uncaughtException');
  });

  process.on('unhandledRejection', async (reason) => {
    workerLogger.error('drawings_worker.unhandled_rejection', { error: reason });
    await shutdown('unhandledRejection');
  });
}

main().catch((error) => {
  workerLogger.error('drawings_worker.fatal', { error });
  workerLogger.flush().finally(() => process.exit(1));
});

function readProcessOptions(body: unknown): ProcessOptions {
  const fromBody =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  return {
    batchSize: toInt(fromBody.batchSize) ?? toInt(process.env.DRAWINGS_WORKER_BATCH_SIZE),
    maxBatches: toInt(fromBody.maxBatches) ?? toInt(process.env.DRAWINGS_WORKER_MAX_BATCHES),
  };
}

function readProcessOptionsFromEnv(): ProcessOptions {
  return {
    batchSize: toInt(process.env.DRAWINGS_WORKER_BATCH_SIZE),
    maxBatches: toInt(process.env.DRAWINGS_WORKER_MAX_BATCHES),
  };
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const isDev = process.env.NODE_ENV !== 'production';
  const secret = process.env.DRAWINGS_WORKER_SECRET;
  if (!secret) return isDev;

  const authHeader = req.headers['authorization'];
  const workerSecretHeader = req.headers['x-worker-secret'];
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const headerValue = Array.isArray(workerSecretHeader)
    ? workerSecretHeader[0]
    : workerSecretHeader;

  return authValue === `Bearer ${secret}` || headerValue === secret;
}
