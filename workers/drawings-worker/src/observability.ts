import * as Sentry from '@sentry/node';

type LogLevel = 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

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

export function initObservability() {
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
        event.contexts = sanitizeLogContext(event.contexts) as typeof event.contexts;
      }
      return event;
    },
  });
}

function shouldRedactKey(key: string) {
  const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function normalizeError(error: unknown) {
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

function sanitizeValue(value: unknown, key = '', depth = 0): unknown {
  if (shouldRedactKey(key)) return REDACTED;
  if (value instanceof Error) return normalizeError(value);
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (depth > 5) return '[max_depth]';
    return value.slice(0, 50).map((item) => sanitizeValue(item, key, depth + 1));
  }

  if (value && typeof value === 'object') {
    if (depth > 5) return '[max_depth]';
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey, depth + 1),
      ]),
    );
  }

  return value;
}

function sanitizeLogContext(context: LogContext = {}) {
  return sanitizeValue(context) as LogContext;
}

function tagsFromContext(context: LogContext) {
  const tags: Record<string, string> = {};
  for (const key of ['domain', 'event', 'orgId', 'jobId', 'jobType']) {
    const value = context[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      tags[key] = String(value).slice(0, 200);
    }
  }
  return tags;
}

function write(level: LogLevel, event: string, context: LogContext = {}) {
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

export const workerLogger = {
  info(event: string, context?: LogContext) {
    write('info', event, context);
  },

  warn(event: string, context?: LogContext) {
    write('warn', event, context);
  },

  error(event: string, context: LogContext & { error?: unknown } = {}) {
    write('error', event, context);

    Sentry.withScope((scope) => {
      const scopedContext = { ...context, domain: 'drawings-worker', event };
      scope.setTags(tagsFromContext(scopedContext));
      scope.setContext('log', sanitizeLogContext(scopedContext));

      if (context.error instanceof Error) {
        Sentry.captureException(context.error);
      } else if (context.error) {
        Sentry.captureException(new Error(String(context.error)));
      } else {
        Sentry.captureMessage(event, 'error');
      }
    });
  },

  async flush(timeoutMs = 2000) {
    await Sentry.flush(timeoutMs);
  },
};
