#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const worker_1 = require("./worker");
async function main() {
    console.log('🚀 Starting drawings worker...');
    const worker = new worker_1.Worker();
    const port = Number(process.env.PORT ?? 8080);
    const server = node_http_1.default.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    });
    server.listen(port, () => {
        console.log(`🛰️  Health-check server listening on port ${port}`);
    });
    async function shutdown(signal) {
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
