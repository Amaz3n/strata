/** Bounded, redacted stage telemetry shared by browser and worker boundaries. */
export const DRAWING_LIFECYCLE_STAGES = [
  "transfer",
  "registration",
  "queue_wait",
  "first_viewable_page",
  "review_readiness",
  "verification",
  "publish",
  "deletion_acknowledgement",
  "split",
  "render",
  "cleanup",
] as const;
export type DrawingLifecycleStage = (typeof DRAWING_LIFECYCLE_STAGES)[number];
export type DrawingLifecycleOutcome = "success" | "failure" | "cancelled";
export interface DrawingLifecycleCounts {
  attempts?: number;
  bytesTransferred?: number;
  sourceDownloads?: number;
  pagesRendered?: number;
  pagesReused?: number;
  storageDeletions?: number;
  databaseCalls?: number;
}
export interface DrawingLifecycleContext {
  operationId?: string;
  revisionId?: string;
  jobId?: string;
}
export interface DrawingLifecycleMeasurement
  extends DrawingLifecycleCounts, DrawingLifecycleContext {
  stage: DrawingLifecycleStage;
  outcome: DrawingLifecycleOutcome;
  durationMs: number;
}
export type DrawingLifecycleSink = (
  measurement: DrawingLifecycleMeasurement,
) => void;
const countKeys = [
  "attempts",
  "bytesTransferred",
  "sourceDownloads",
  "pagesRendered",
  "pagesReused",
  "storageDeletions",
  "databaseCalls",
] as const;
const idKeys = ["operationId", "revisionId", "jobId"] as const;
const defaultSink: DrawingLifecycleSink = (measurement) => {
  // A browser event lets the application attach telemetry without retaining files or signed URLs.
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("drawing-lifecycle", { detail: measurement }),
    );
  else console.info("[drawing-lifecycle]", measurement);
};
/** Only allowlisted scalar fields leave this boundary. Sink failure never affects the operation. */
export function startDrawingLifecycleStage(
  stage: DrawingLifecycleStage,
  context: DrawingLifecycleContext = {},
  options: { now?: () => number; sink?: DrawingLifecycleSink } = {},
) {
  const now = options.now ?? (() => performance.now());
  const started = now();
  let finished = false;
  return (
    outcome: DrawingLifecycleOutcome,
    counts: DrawingLifecycleCounts = {},
  ) => {
    if (finished) return;
    finished = true;
    const measurement: DrawingLifecycleMeasurement = {
      stage,
      outcome,
      durationMs: Math.max(0, now() - started),
    };
    for (const key of idKeys) {
      const value = context[key];
      // IDs only: deliberately reject URLs, arbitrary text, and unbounded input.
      if (typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value))
        measurement[key] = value;
    }
    for (const key of countKeys) {
      const value = counts[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        measurement[key] = value;
    }
    try {
      (options.sink ?? defaultSink)(measurement);
    } catch {
      /* Telemetry is best effort. */
    }
  };
}
