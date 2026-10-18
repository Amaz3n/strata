import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  evidencePathBounds,
  type AreaEvidence,
  type EvidencePath,
} from "./area-evidence";
import type { AreaRegion } from "./area-takeoff";
import {
  architecturalKinds,
  type AreaVisualObservation,
} from "./area-semantics";
import {
  validRecognitionImageSource,
  type RecognitionImageSource,
} from "./recognition-image-source";
import { bindWallHypothesis } from "./wall-hypothesis-semantics";
import {
  sourceWallNetwork,
  type VectorWallHypothesis,
} from "./vector-wall-network";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const factsSchema = z
  .object({
    version: z.literal(1),
    scope: keySchema,
    sx: z.number().positive().finite(),
    sy: z.number().positive().finite(),
    digest: keySchema,
    sourceImage: z.unknown(),
    paths: z
      .array(z.object({ key: keySchema, kind: z.enum(architecturalKinds) }))
      .max(160),
    spans: z
      .array(
        z.object({
          key: keySchema,
          kind: z.enum(["wall", "not-wall", "unknown"]),
        }),
      )
      .max(160),
  })
  .strict();
export type RecognitionSourceFacts = z.infer<typeof factsSchema> & {
  sourceImage: RecognitionImageSource;
};
const inside = (b: AreaRegion, r: AreaRegion) =>
  b.x0 >= r.x0 - 1e-10 &&
  b.y0 >= r.y0 - 1e-10 &&
  b.x1 <= r.x1 + 1e-10 &&
  b.y1 <= r.y1 + 1e-10;

/** Exact identity, never geometric proximity or rounded coordinates. Global
 * extraction versions and transient IDs may change while the actual source
 * primitive remains identical. Referenced clips are part of its identity. */
export class RecognitionSourceFactIndex {
  readonly evidenceHash: string;
  readonly paths = new Map<number, { key: string; path: EvidencePath }>();
  readonly uniquePaths = new Map<string, EvidencePath | null>();
  private spans?: Map<string, VectorWallHypothesis | null>;
  private paint = new Map<string, unknown[]>();
  constructor(
    readonly evidence: AreaEvidence,
    readonly sx: number,
    readonly sy: number,
  ) {
    if (
      evidence.truncated ||
      ![sx, sy].every((n) => Number.isFinite(n) && n > 0) ||
      evidence.paths.length > 65536
    )
      throw Error(
        "Source fact identity is incomplete or exceeds its work budget.",
      );
    this.evidenceHash = hash(JSON.stringify(evidence));
    if (evidence.paths.some((p) => !Number.isInteger(p.id) || p.id < 0))
      throw Error("Invalid source primitive identity.");
    const ids = new Map(evidence.paths.map((p) => [p.id, p]));
    if (ids.size !== evidence.paths.length)
      throw Error("Source primitive IDs are ambiguous.");
    let bytes = 0;
    for (const path of evidence.paths) {
      const clips = path.clips.map((id) => ids.get(id));
      // Nested/missing clip ownership needs a separate source graph witness.
      if (clips.some((p) => !p || p.clips.length)) continue;
      const value = canonical({
        ...path,
        id: undefined,
        clips: clips.map((p) => ({ ...p!, id: undefined })),
      });
      bytes += value.length;
      if (bytes > 32 * 1024 * 1024)
        throw Error("Source fact identity exceeds its work budget.");
      const key = hash(value);
      this.paths.set(path.id, { key, path });
      this.uniquePaths.set(key, this.uniquePaths.has(key) ? null : path);
    }
    for (const entry of evidence.rasterPairPaint ?? []) {
      const id = [...entry.pathIds].sort((a, b) => a - b).join(":"),
        rows = this.paint.get(id) ?? [];
      rows.push({ ...entry, pathIds: undefined });
      this.paint.set(id, rows);
    }
  }
  private spanKey(body: VectorWallHypothesis): string | null {
    const paths = body.pathIds.map((id) => this.paths.get(id));
    if (
      paths.length !== 2 ||
      paths.some((p) => !p || !this.uniquePaths.get(p.key))
    )
      return null;
    const rows =
      this.paint.get([...body.pathIds].sort((a, b) => a - b).join(":")) ?? [];
    return hash(
      canonical([
        paths.map((p) => p!.key).sort(),
        body.a,
        body.b,
        body.thicknessFt,
        body.sourceBand ?? null,
        this.sx,
        this.sy,
        rows.map(canonical).sort(),
      ]),
    );
  }
  private measuredSpans() {
    if (this.spans) return this.spans;
    const network = sourceWallNetwork({
      evidence: this.evidence,
      sx: this.sx,
      sy: this.sy,
      textRuns: [],
      inspectUnfilledPairs: true,
    });
    if (network.limited)
      throw Error("Source wall facts exceeded their measurement budget.");
    this.spans = new Map();
    for (const body of network.candidates) {
      const key = this.spanKey(body);
      if (key) this.spans.set(key, this.spans.has(key) ? null : body);
    }
    return this.spans;
  }
  /** A binding must be the freshly reconstructed source body, including its
   * complete witness. Cached facts never create or extend a wall hypothesis. */
  keyForBinding(
    binding: NonNullable<
      AreaVisualObservation["suppliedWallHypotheses"]
    >[number],
  ) {
    for (const [key, body] of this.measuredSpans()) {
      if (
        !body ||
        !body.pathIds.every((id) => binding.pathIds.includes(id)) ||
        canonical([body.a, body.b, body.thicknessFt]) !==
          canonical([binding.a, binding.b, binding.thicknessFt])
      )
        continue;
      const measured = bindWallHypothesis(
        this.evidence,
        body,
        this.sx,
        this.sy,
      );
      if (measured && canonical(measured) === canonical(binding)) return key;
    }
    return null;
  }
  bindingForKey(key: string) {
    const body = this.measuredSpans().get(key);
    return body
      ? bindWallHypothesis(this.evidence, body, this.sx, this.sy)
      : null;
  }
}

export function createRecognitionSourceFacts(
  scope: string,
  index: RecognitionSourceFactIndex,
  observation: AreaVisualObservation,
): RecognitionSourceFacts | null {
  const image = observation.sourceImage;
  if (
    !keySchema.safeParse(scope).success ||
    !validRecognitionImageSource(image) ||
    image.kind !== "original-pdf" ||
    image.evidenceHash !== index.evidenceHash ||
    (index.evidence.raster &&
      (!image.nativeDensityPreserved ||
        image.sourceHash !== index.evidence.raster.sourceHash))
  )
    return null;
  const paths: RecognitionSourceFacts["paths"] = [],
    spans: RecognitionSourceFacts["spans"] = [],
    supplied = new Set(observation.suppliedPathIds);
  for (const element of observation.elements)
    for (const id of element.pathIds) {
      const p = index.paths.get(id),
        bounds = p && evidencePathBounds(p.path);
      if (
        !supplied.has(id) ||
        !p ||
        !index.uniquePaths.get(p.key) ||
        !bounds ||
        !inside(bounds, image.requestedRegion)
      )
        continue;
      paths.push({ key: p.key, kind: element.kind });
    }
  const bindings = new Map(
    observation.suppliedWallHypotheses?.map((b) => [b.id, b]),
  );
  for (const decision of observation.wallHypotheses ?? []) {
    const binding = bindings.get(decision.hypothesisId),
      key = binding && index.keyForBinding(binding);
    if (key && binding && inside(binding.region, image.requestedRegion))
      spans.push({ key, kind: decision.kind });
  }
  if (!paths.length && !spans.length) return null;
  const payload = {
    version: 1 as const,
    scope,
    sx: index.sx,
    sy: index.sy,
    sourceImage: image,
    paths,
    spans,
  };
  const record = { ...payload, digest: hash(canonical(payload)) };
  return factsSchema.safeParse(record).success ? record : null;
}

/** Keep the ORIGINAL pixels/overlay registration. Only exact source addresses
 * acquire current IDs/bindings. Proposals for opening geometry are never reused.
 * Separate observations preserve disagreements instead of overwriting votes. */
export function restoreRecognitionSourceFacts(
  value: unknown,
  scope: string,
  index: RecognitionSourceFactIndex,
  region: AreaRegion,
): AreaVisualObservation | null {
  const parsed = factsSchema.safeParse(value);
  if (!parsed.success) throw Error("Invalid persisted source facts.");
  const { digest, ...record } = parsed.data,
    image = record.sourceImage;
  if (
    record.scope !== scope ||
    record.sx !== index.sx ||
    record.sy !== index.sy ||
    digest !== hash(canonical(record)) ||
    !validRecognitionImageSource(image) ||
    image.kind !== "original-pdf" ||
    (index.evidence.raster &&
      (!image.nativeDensityPreserved ||
        image.sourceHash !== index.evidence.raster.sourceHash))
  )
    throw Error(
      "Persisted source facts have incompatible ownership or provenance.",
    );
  const elements: AreaVisualObservation["elements"] = [],
    bindings: NonNullable<AreaVisualObservation["suppliedWallHypotheses"]> = [],
    decisions: NonNullable<AreaVisualObservation["wallHypotheses"]> = [];
  for (const fact of record.paths) {
    const path = index.uniquePaths.get(fact.key),
      bounds = path && evidencePathBounds(path);
    if (
      path &&
      bounds &&
      inside(bounds, image.requestedRegion) &&
      inside(bounds, region)
    )
      elements.push({ pathIds: [path.id], kind: fact.kind });
  }
  for (const fact of record.spans) {
    const binding = index.bindingForKey(fact.key);
    if (
      binding &&
      inside(binding.region, image.requestedRegion) &&
      inside(binding.region, region)
    ) {
      bindings.push(binding);
      decisions.push({ hypothesisId: binding.id, kind: fact.kind });
    }
  }
  if (!elements.length && !bindings.length) return null;
  return {
    id: `source-facts:${digest}`,
    region: image.requestedRegion,
    sourceImage: image,
    suppliedPathIds: [...new Set(elements.flatMap((e) => e.pathIds))],
    elements,
    openings: [],
    ...(bindings.length
      ? { suppliedWallHypotheses: bindings, wallHypotheses: decisions }
      : {}),
    sourceReuse: {
      version: 1,
      recordDigest: digest,
      scope,
      priorEvidenceHash: image.evidenceHash,
      currentEvidenceHash: index.evidenceHash,
    },
  };
}
