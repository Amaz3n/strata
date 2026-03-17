#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const worker_1 = require("./worker");
async function main() {
    const worker = new worker_1.Worker();
    const processOnce = process.argv.includes('--once');
    const processPath = process.env.DRAWINGS_WORKER_PROCESS_PATH ?? '/process';
    if (processOnce) {
        const summary = await worker.processAvailableJobs(readProcessOptionsFromEnv());
        console.log('✅ One-off run completed:', summary);
        return;
    }
    const port = Number(process.env.PORT ?? 8080);
    const server = node_http_1.default.createServer(async (req, res) => {
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
        }
        catch (error) {
            console.error('💥 Request failed:', error);
            sendJson(res, 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
    server.listen(port, () => {
        console.log(`🛰️  Drawings worker listening on port ${port}`);
        console.log(`🛰️  Process path: ${processPath}`);
    });
    async function shutdown(signal) {
        console.log(`🛑 Received ${signal}, shutting down gracefully...`);
        server.close();
        process.exit(0);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('uncaughtException', async (error) => {
        console.error('💥 Uncaught exception, shutting down:', error);
        await shutdown('uncaughtException');
    });
}
main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});
function readProcessOptions(body) {
    const fromBody = typeof body === 'object' && body !== null ? body : {};
    return {
        batchSize: toInt(fromBody.batchSize) ?? toInt(process.env.DRAWINGS_WORKER_BATCH_SIZE),
        maxBatches: toInt(fromBody.maxBatches) ?? toInt(process.env.DRAWINGS_WORKER_MAX_BATCHES),
    };
}
function readProcessOptionsFromEnv() {
    return {
        batchSize: toInt(process.env.DRAWINGS_WORKER_BATCH_SIZE),
        maxBatches: toInt(process.env.DRAWINGS_WORKER_MAX_BATCHES),
    };
}
function toInt(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.floor(value);
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length === 0)
        return {};
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw)
        return {};
    return JSON.parse(raw);
}
function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
function isAuthorized(req) {
    const isDev = process.env.NODE_ENV !== 'production';
    const secret = process.env.DRAWINGS_WORKER_SECRET;
    if (!secret)
        return isDev;
    const authHeader = req.headers['authorization'];
    const workerSecretHeader = req.headers['x-worker-secret'];
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const headerValue = Array.isArray(workerSecretHeader)
        ? workerSecretHeader[0]
        : workerSecretHeader;
    return authValue === `Bearer ${secret}` || headerValue === secret;
}
