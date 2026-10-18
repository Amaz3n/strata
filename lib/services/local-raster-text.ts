import "server-only";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RASTER_TEXT_PROFILE,
  rasterTextRuns,
  rasterTextWindows,
  mergeArchitecturalTextRuns,
  type RasterTextEvidence,
} from "@/lib/drawings/raster-text";
import type { AreaRegion } from "@/lib/drawings/area-takeoff";
import type { openOriginalSheetRaster } from "./original-sheet-raster";
import { renderSheetWindowImage } from "./drawings-sheet-images";

/** next.config.mjs ships tesseract.js from its pnpm directory, where its own
 * dependencies resolve; the deployed function has no top-level link to it. */
function tesseractModulesPath(): string | undefined {
  const pnpm = path.join(process.cwd(), "node_modules/.pnpm");
  const dir = readdirSync(pnpm).find((name) => name.startsWith("tesseract.js@"));
  return dir ? path.join(pnpm, dir, "node_modules") : undefined;
}

/** Killing the child also stops Tesseract initialization and its nested worker,
 * so a failed/timed-out OCR job does not remain alive in the application. */
function runRasterTextChild(
  image: Buffer,
  timeoutMs = 10_000,
): Promise<unknown[]> {
  if (
    !image.length ||
    image.length > 16_000_000 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  )
    return Promise.reject(new Error("Invalid OCR image or time budget"));
  return new Promise((resolve, reject) => {
    // Launch the traced CJS entry as a Node process with IPC. Turbopack rewrites
    // fork() entries into /ROOT paths; this entry must remain a real filesystem
    // script so Tesseract can create its own worker. next.config.mjs ships it.
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", path.join(process.cwd(), "lib/services/ocr/raster-text-process.cjs")],
      {
        env: { ...process.env, NODE_PATH: tesseractModulesPath() },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let settled = false;
    const finish = (error?: Error, lines?: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.once("close", () => {
        if (error) reject(error);
        else resolve(lines ?? []);
      });
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () =>
        finish(new Error("Local OCR exceeded its source-window time budget.")),
      timeoutMs,
    );
    child.once("error", () =>
      finish(new Error("Local OCR process could not start.")),
    );
    child.once("exit", () =>
      finish(
        new Error("Local OCR process stopped before returning source text."),
      ),
    );
    child.once("message", (message: unknown) => {
      const value = message as { lines?: unknown[]; error?: string };
      if (
        !value ||
        value.error ||
        !Array.isArray(value.lines) ||
        value.lines.length > 4000
      )
        finish(new Error("Local OCR returned an incomplete source window."));
      else finish(undefined, value.lines);
    });
    child.send!({ image }, (error) => {
      if (error)
        finish(new Error("Local OCR source window could not be delivered."));
    });
  });
}

// One OCR child per application process bounds model memory. Queue waits count
// against the same caller deadline; stale queued jobs never start a late child.
let localOcrQueue: Promise<void> = Promise.resolve();
let queuedOcrJobs = 0;
export function recognizeLocalRasterText(
  image: Buffer,
  timeoutMs = 10_000,
): Promise<unknown[]> {
  if (
    !image.length ||
    image.length > 16_000_000 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  )
    return Promise.reject(new Error("Invalid OCR image or time budget"));
  if (queuedOcrJobs >= 4)
    return Promise.reject(
      new Error("Local OCR capacity is busy. Retry generation."),
    );
  const deadline = Date.now() + timeoutMs;
  queuedOcrJobs++;
  const work = localOcrQueue
    .then(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("Local OCR queue exceeded its time budget.");
      return runRasterTextChild(image, remaining);
    })
    .finally(() => {
      queuedOcrJobs--;
    });
  localOcrQueue = work.then(
    () => {},
    () => {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Local OCR exceeded its time budget.")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function loadLocalRasterText(input: {
  supabase: SupabaseClient;
  tilesBasePath: string;
  imageWidth: number;
  imageHeight: number;
  region: AreaRegion;
  original?: Awaited<ReturnType<typeof openOriginalSheetRaster>>;
}): Promise<RasterTextEvidence> {
  const result: RasterTextEvidence = {
    profile: RASTER_TEXT_PROFILE,
    status: "unavailable",
    runs: [],
    windows: 0,
    warnings: [],
  };
  if (input.original) {
    result.source = {
      kind: "original-pdf",
      hash: input.original.sourceHash,
      sampling: input.original.sampling,
    };
    result.warnings.push(...input.original.sampling.warnings);
  } else {
    result.source = { kind: "stored-tiles" };
    result.warnings.push(
      "Scan text uses stored drawing pixels; original PDF sampling is unavailable. Display tiles may have discarded native detail.",
    );
  }
  const deadline = Date.now() + 60_000;
  let windows: AreaRegion[];
  try {
    windows = rasterTextWindows(
      input.original?.imageWidth ?? input.imageWidth,
      input.original?.imageHeight ?? input.imageHeight,
      input.region,
    );
  } catch {
    result.warnings.push(
      "Native scan text exceeds its frame or processing budget. Select a smaller plan view.",
    );
    return result;
  }
  for (const window of windows) {
    if (Date.now() >= deadline) {
      result.warnings.push(
        "Local scan text processing reached its time budget. Some windows remain unread.",
      );
      break;
    }
    try {
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const image = await Promise.race([
        input.original
          ? input.original.renderWindow(window, 2050)
          : renderSheetWindowImage({
              ...input,
              window,
              maxEdge: 2048,
              requireComplete: true,
              lossless: true,
            }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("OCR tiles exceeded the time budget")),
            remaining,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (!image) throw new Error("Incomplete source pixels");
      const sharp = (await import("sharp")).default,
        metadata = await sharp(image.data).metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 2050 ||
        metadata.height > 2050
      )
        throw new Error("Invalid source-window dimensions");
      const lines = await recognizeLocalRasterText(
        image.data,
        Math.min(10_000, Math.max(1, deadline - Date.now())),
      );
      result.runs = mergeArchitecturalTextRuns(
        result.runs,
        rasterTextRuns(
          lines,
          metadata.width,
          metadata.height,
          image.sourceRegion,
        ),
      );
      result.windows++;
      if (result.runs.length >= 4000) {
        result.warnings.push(
          "Scan text reached its observation limit. Some text may be unrepresented; select a smaller plan view.",
        );
        break;
      }
    } catch {
      result.warnings.push(
        "A scan text window could not be processed completely. Its missing text was not guessed.",
      );
      break;
    }
  }
  result.status =
    result.windows === windows.length && result.runs.length < 4000
      ? "processed"
      : result.windows
        ? "partial"
        : "unavailable";
  if (result.runs.length)
    result.warnings.push(
      "Local OCR supplies provisional text positions. Verify room names, tags and dimensions against the original scan; transcription confidence is not architectural accuracy.",
    );
  else
    result.warnings.push(
      "No readable scan text was recovered within this region. Check source legibility and room labels.",
    );
  return result;
}
