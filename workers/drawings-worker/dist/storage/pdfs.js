"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadPdfObject = downloadPdfObject;
const stream_1 = require("stream");
const client_s3_1 = require("@aws-sdk/client-s3");
const R2_BUCKET = process.env.R2_BUCKET ?? 'project-files';
const R2_PREFIX = 'drawings-pdfs';
const R2_REGION = process.env.R2_REGION ?? 'auto';
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === 'true';
let cachedR2Client = null;
function getProvider() {
    const raw = process.env.DRAWINGS_PDFS_STORAGE ??
        process.env.DRAWINGS_TILES_STORAGE ??
        'r2';
    if (raw.toLowerCase() !== 'r2') {
        throw new Error('DRAWINGS_PDFS_STORAGE must be set to r2.');
    }
    return 'r2';
}
function normalizePath(path) {
    return path.startsWith('/') ? path.slice(1) : path;
}
function normalizeKey(path) {
    const normalized = normalizePath(path);
    return `${R2_PREFIX}/${normalized}`;
}
function getR2Client() {
    if (cachedR2Client)
        return cachedR2Client;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const endpoint = process.env.R2_ENDPOINT ??
        (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);
    if (!endpoint || !accessKeyId || !secretAccessKey) {
        throw new Error('Missing R2 credentials or endpoint');
    }
    cachedR2Client = new client_s3_1.S3Client({
        region: R2_REGION,
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: R2_FORCE_PATH_STYLE,
    });
    return cachedR2Client;
}
async function streamToBuffer(stream) {
    if (stream instanceof stream_1.Readable) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    if (stream?.arrayBuffer) {
        const ab = await stream.arrayBuffer();
        return Buffer.from(ab);
    }
    return Buffer.from(stream ?? []);
}
async function downloadPdfObject(params) {
    const { supabase: _supabase, path } = params;
    getProvider();
    const key = normalizeKey(path);
    const client = getR2Client();
    const result = await client.send(new client_s3_1.GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
    }));
    if (!result.Body) {
        throw new Error(`Failed to download PDF: empty body for ${key}`);
    }
    return streamToBuffer(result.Body);
}
