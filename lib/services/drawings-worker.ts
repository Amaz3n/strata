type TriggerReason =
  | "drawing_set_uploaded"
  | "drawing_set_retry"
  | "tile_backfill"
  | "manual";

interface TriggerOptions {
  reason: TriggerReason;
  maxBatches?: number;
  batchSize?: number;
  timeoutMs?: number;
}

interface TriggerResult {
  triggered: boolean;
  status?: number;
  error?: string;
}

function normalizeBaseUrl(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parsePositiveInt(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export async function triggerDrawingsWorker(options: TriggerOptions): Promise<TriggerResult> {
  const baseUrl = process.env.DRAWINGS_WORKER_URL;
  if (!baseUrl) {
    return {
      triggered: false,
      error: "DRAWINGS_WORKER_URL not configured",
    };
  }

  const secret = process.env.DRAWINGS_WORKER_SECRET;
  const processPath = process.env.DRAWINGS_WORKER_PROCESS_PATH ?? "/process";
  const timeoutMs = options.timeoutMs ?? parsePositiveInt(process.env.DRAWINGS_WORKER_TIMEOUT_MS) ?? 4000;
  const maxBatches = options.maxBatches ?? parsePositiveInt(process.env.DRAWINGS_WORKER_MAX_BATCHES) ?? 20;
  const batchSize = options.batchSize ?? parsePositiveInt(process.env.DRAWINGS_WORKER_BATCH_SIZE) ?? 5;

  const url = `${normalizeBaseUrl(baseUrl)}${processPath.startsWith("/") ? processPath : `/${processPath}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        trigger: options.reason,
        maxBatches,
        batchSize,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await safeResponseText(response);
      return {
        triggered: false,
        status: response.status,
        error: responseText || `HTTP ${response.status}`,
      };
    }

    return {
      triggered: true,
      status: response.status,
    };
  } catch (error) {
    return {
      triggered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function safeResponseText(response: Response) {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}
