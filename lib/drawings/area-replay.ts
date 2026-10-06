import { createHash } from "node:crypto";
import { AREA_ENGINE_VERSION, type AreaInput } from "./area-takeoff";
import { runAreaEngine } from "./area-engine";

export interface AreaReplay {
  version: 1;
  engine: number;
  source: { sheetVersionId?: string; sourceHash?: string | null };
  wholeSheet: boolean;
  input: AreaInput & { segments: number[]; flags?: number[] };
  inputHash: string;
  recognition: string;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function createAreaReplay(
  input: AreaInput,
  wholeSheet: boolean,
  source: AreaReplay["source"],
  recognition: string,
): AreaReplay {
  const normalized = {
    ...input,
    segments: Array.from(input.segments),
    ...(input.flags
      ? { flags: Array.from(input.flags) }
      : { flags: undefined }),
  };
  const record = {
    version: 1 as const,
    engine: AREA_ENGINE_VERSION,
    source,
    wholeSheet,
    input: normalized,
    recognition,
  };
  return { ...record, inputHash: hash(record) };
}
export async function replayAreaDetection(
  record: AreaReplay,
  options: { compareCurrentEngine?: boolean } = {},
) {
  const { inputHash, ...payload } = record;
  if (record.version !== 1 || hash(payload) !== inputHash)
    throw new Error("Detection replay is corrupt or has been modified.");
  if (record.engine !== AREA_ENGINE_VERSION && !options.compareCurrentEngine)
    throw new Error(
      "Replay engine differs from the current engine. Use the recorded revision for an exact replay, or explicitly compare the current engine.",
    );
  const result = await runAreaEngine(record.input, {
    wholeSheet: record.wholeSheet,
    recordedRecognition: record.recognition === "partial" || record.recognition === "unavailable" ? record.recognition : undefined,
  });
  return {
    ...result,
    replay: {
      sourceEngine: record.engine,
      currentEngine: AREA_ENGINE_VERSION,
      mode: options.compareCurrentEngine ? "comparison" : "exact",
    },
  };
}
