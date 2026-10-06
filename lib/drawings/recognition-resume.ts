import type { AreaRecognitionRequest } from "./area-engine";
import type { AreaVisualObservation } from "./area-semantics";
import { validRecognitionImageSource } from "./recognition-image-source";
import type { AreaEvidence } from "./area-evidence";

export function settledSourceWallSpans(
  evidence: AreaEvidence,
  observations: readonly AreaVisualObservation[],
): Set<string> {
  const votes = new Map<string, Set<string>>();
  for (const o of observations) {
    const image = o.sourceImage;
    if (
      !validRecognitionImageSource(image) ||
      image.kind !== "original-pdf" ||
      !image.nativeDensityPreserved ||
      image.sourceHash !== evidence.raster?.sourceHash ||
      ![image.requestedRegion, image.sourceRegion].some((r) =>
        ["x0", "y0", "x1", "y1"].every(
          (k) => r[k as keyof typeof r] === o.region[k as keyof typeof r],
        ),
      )
    )
      continue;
    const supplied = new Map(o.suppliedWallHypotheses?.map((b) => [b.id, b])),
      seen = new Set<string>();
    if (supplied.size !== o.suppliedWallHypotheses?.length) continue;
    for (const d of o.wallHypotheses ?? []) {
      const binding = supplied.get(d.hypothesisId);
      if (!binding) continue;
      const set = votes.get(binding.witness) ?? new Set<string>();
      if (seen.has(d.hypothesisId)) set.add("duplicate");
      seen.add(d.hypothesisId);
      if (d.kind !== "unknown") set.add(d.kind);
      votes.set(binding.witness, set);
    }
  }
  return new Set(
    [...votes]
      .filter(([, v]) => v.size === 1 && (v.has("wall") || v.has("not-wall")))
      .map(([w]) => w),
  );
}

/** Unknown/contradictory targets stay in the workload. Source paths whose role
 * is already settled remain visible as nonvoting context for other assemblies. */
export function pruneRecognizedSourceRequest(
  request: AreaRecognitionRequest,
  resolvedPaths: ReadonlySet<number>,
  resolvedSpans: ReadonlySet<string>,
): AreaRecognitionRequest | null {
  const catalogue = request.catalogue.filter((p) => !resolvedPaths.has(p.id)),
    removed = request.catalogue.filter((p) => resolvedPaths.has(p.id)),
    wallHypotheses = request.wallHypotheses?.filter(
      (h) => !resolvedSpans.has(h.binding.witness),
    );
  if (!catalogue.length && !wallHypotheses?.length) return null;
  const context = new Map(
    [...(request.contextCatalogue ?? []), ...removed].map((p) => [p.id, p]),
  );
  return {
    ...request,
    catalogue,
    wallHypotheses,
    ...(context.size ? { contextCatalogue: [...context.values()] } : {}),
  };
}
