"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.workerLogger = void 0;
exports.initObservability = initObservability;
const Sentry = __importStar(require("@sentry/node"));
const REDACTED = '[redacted]';
const SENSITIVE_KEY_PARTS = [
    'authorization',
    'cookie',
    'password',
    'secret',
    'session',
    'token',
    'api_key',
    'apikey',
    'access_token',
    'refresh_token',
];
function initObservability() {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
        release: process.env.SENTRY_RELEASE ?? process.env.K_REVISION,
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? (process.env.NODE_ENV === 'production' ? 0.1 : 1)),
        sendDefaultPii: false,
        beforeSend(event) {
            if (event.extra) {
                event.extra = sanitizeLogContext(event.extra);
            }
            if (event.contexts) {
                event.contexts = sanitizeLogContext(event.contexts);
            }
            return event;
        },
    });
}
function shouldRedactKey(key) {
    const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
    return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}
function normalizeError(error) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return {
        name: 'NonError',
        message: typeof error === 'string' ? error : 'Unknown error',
        value: error,
    };
}
function sanitizeValue(value, key = '', depth = 0) {
    if (shouldRedactKey(key))
        return REDACTED;
    if (value instanceof Error)
        return normalizeError(value);
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value)) {
        if (depth > 5)
            return '[max_depth]';
        return value.slice(0, 50).map((item) => sanitizeValue(item, key, depth + 1));
    }
    if (value && typeof value === 'object') {
        if (depth > 5)
            return '[max_depth]';
        return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
            entryKey,
            sanitizeValue(entryValue, entryKey, depth + 1),
        ]));
    }
    return value;
}
function sanitizeLogContext(context = {}) {
    return sanitizeValue(context);
}
function tagsFromContext(context) {
    const tags = {};
    for (const key of ['domain', 'event', 'orgId', 'jobId', 'jobType']) {
        const value = context[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            tags[key] = String(value).slice(0, 200);
        }
    }
    return tags;
}
function write(level, event, context = {}) {
    const payload = {
        level,
        event,
        timestamp: new Date().toISOString(),
        domain: 'drawings-worker',
        ...sanitizeLogContext(context),
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
        console.error(line);
        return;
    }
    if (level === 'warn') {
        console.warn(line);
        return;
    }
    console.log(line);
}
exports.workerLogger = {
    info(event, context) {
        write('info', event, context);
    },
    warn(event, context) {
        write('warn', event, context);
    },
    error(event, context = {}) {
        write('error', event, context);
        Sentry.withScope((scope) => {
            const scopedContext = { ...context, domain: 'drawings-worker', event };
            scope.setTags(tagsFromContext(scopedContext));
            scope.setContext('log', sanitizeLogContext(scopedContext));
            if (context.error instanceof Error) {
                Sentry.captureException(context.error);
            }
            else if (context.error) {
                Sentry.captureException(new Error(String(context.error)));
            }
            else {
                Sentry.captureMessage(event, 'error');
            }
        });
    },
    async flush(timeoutMs = 2000) {
        await Sentry.flush(timeoutMs);
    },
};
