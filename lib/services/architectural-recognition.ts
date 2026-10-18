import "server-only";
import {
  recognitionOverlaySvg,
  registerRecognitionImage,
} from "@/lib/drawings/recognition-overlay";
import { createHash } from "node:crypto";
import {
  downloadTilesObject,
  uploadTilesObject,
  listTilesObjectsBounded,
} from "@/lib/storage/drawings-tiles-storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AreaEvidence } from "@/lib/drawings/area-evidence";
import {
  areaRecognitionPrompt,
  type AreaRecognitionRequest,
  type AreaRecognizer,
} from "@/lib/drawings/area-engine";
import {
  visualInterpretationSchema,
  visualInterpretationProviderSchema,
  wallHypothesisInterpretationProviderSchema,
} from "@/lib/drawings/area-semantics";
import {
  RECOGNITION_IMAGE_SOURCE_PROFILE,
  preservesNativeRecognitionDensity,
  validRecognitionImageSource,
  type RecognitionImageSource,
} from "@/lib/drawings/recognition-image-source";
import { renderSheetWindowImage } from "@/lib/services/drawings-sheet-images";
import { openOriginalSheetRaster } from "./original-sheet-raster";
import { runDrawingsVisionObject } from "@/lib/services/ai/drawings-vision";
import { accountsForWallSpans, usableRecognitionAnswer } from "@/lib/drawings/recognition-answer";
import { RecognitionSourceFactIndex, createRecognitionSourceFacts, restoreRecognitionSourceFacts } from "@/lib/drawings/recognition-source-facts";
import type { AreaVisualObservation } from "@/lib/drawings/area-semantics";
import type { AreaRegion } from "@/lib/drawings/area-takeoff";

/** One source classifier for takeoff/3D. Original PDF pixels are registered to
 * immutable path IDs; provider output cannot supply final building geometry.
 * runAreaEngine disposes the shared original handle after all cache/crop work. */
export function createArchitecturalRecognizer(input: {
  supabase: SupabaseClient;
  orgId: string;
  sheetVersionId: string;
  tilesBasePath: string;
  imageWidth: number;
  imageHeight: number;
  evidence: AreaEvidence | null | undefined;
  feetPerImagePx?: number;
  budgetMs?: number;
  source?: { fileId: string; pageIndex: number };
}): AreaRecognizer {
  const sha = (bytes: Buffer | string) =>
    createHash("sha256").update(bytes).digest("hex");
  const evidenceHash = sha(JSON.stringify(input.evidence ?? null)),
    warnings = new Set<string>();
  let deadline: number | undefined,
    closed = false,
    sourcePromise:
      | Promise<Awaited<ReturnType<typeof openOriginalSheetRaster>>>
      | undefined;
  const original = async (request: AreaRecognitionRequest) => {
    if (closed) throw Error("Recognition source handle is closed");
    deadline ??= Date.now() + (input.budgetMs ?? 90000);
    if (!input.source) return null;
    sourcePromise ??= openOriginalSheetRaster({
      supabase: input.supabase,
      orgId: input.orgId,
      ...input.source,
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      region: request.region,
    });
    const source = await sourcePromise;
    const geometryHash = input.evidence?.raster?.sourceHash;
    if (geometryHash && source.sourceHash !== geometryHash)
      throw Error(
        "Original PDF differs from measured geometry. Refresh the drawing evidence before recognition.",
      );
    return source;
  };
  const fingerprintFor = async (request: AreaRecognitionRequest) => {
    const source = await original(request);
    return sha(
      JSON.stringify([
        8,
        RECOGNITION_IMAGE_SOURCE_PROFILE,
        input.orgId,
        evidenceHash,
        input.sheetVersionId,
        input.imageWidth,
        input.imageHeight,
        input.feetPerImagePx ?? null,
        input.source ?? null,
        source?.sourceHash ?? null,
        request.region,
        areaRecognitionPrompt(request),
      ]),
    );
  };
  const reads = new Map<string, Promise<unknown | null>>(),
    images = new Map<string, RecognitionImageSource>();
  const requestKey = (r: AreaRecognitionRequest) => sha(JSON.stringify(r));
  const noteImageQuality = (s: RecognitionImageSource) => {
    s.sampling?.warnings.forEach((w) => warnings.add(w));
    if (s.kind === "display-tiles")
      warnings.add(
        "Architectural classification used display tiles because the original PDF identity is unavailable. Source pixel density is unverified; inspect or reprocess the drawing.",
      );
  };
  const warn = (error: unknown) =>
    warnings.add(
      error instanceof Error
        ? error.message
        : "Original recognition imagery could not be read. Classification remains incomplete.",
    );
  let factIndex: RecognitionSourceFactIndex | undefined;
  const sourceFactScope = async (region: AreaRegion) => {
    if (!input.source || !input.evidence || !Number.isFinite(input.feetPerImagePx) || input.feetPerImagePx! <= 0) return null;
    const source = await original({ region, catalogue: [] });
    if (!source) return null;
    factIndex ??= new RecognitionSourceFactIndex(input.evidence, input.imageWidth * input.feetPerImagePx!, input.imageHeight * input.feetPerImagePx!);
    const scope = sha(JSON.stringify([1, input.orgId, input.sheetVersionId, input.source, source.sourceHash, input.imageWidth, input.imageHeight, input.feetPerImagePx]));
    return { scope, prefix: `${input.tilesBasePath}/architecture/source-facts-${scope}/`, source, index: factIndex };
  };
  const saveSourceFacts = async (request: AreaRecognitionRequest, sourceImage: RecognitionImageSource, answer: ReturnType<typeof visualInterpretationSchema.parse>) => {
    const owner = await sourceFactScope(request.region);
    if (!owner) return;
    const record = createRecognitionSourceFacts(owner.scope, owner.index, {
      id: 'source-cache-write', sourceImage, region: request.region,
      suppliedPathIds: request.catalogue.map(p => p.id), elements: answer.elements,
      suppliedWallHypotheses: request.wallHypotheses?.map(h => h.binding), wallHypotheses: answer.wallHypotheses,
    });
    if (!record) return;
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > 256 * 1024) throw Error('Source facts exceed the persisted record budget. The original classification remains usable.');
    await uploadTilesObject({ supabase: input.supabase, path: `${owner.prefix}fact-${record.digest}.json`, bytes, contentType: 'application/json', cacheControl: 'private, max-age=31536000, immutable' });
  };
  /** Append-only, source-scoped history preserves parallel writers and opposing
   * decisions. Incomplete reads cannot silently suppress a contradictory vote. */
  const prior = async (region: AreaRegion): Promise<AreaVisualObservation[]> => {
    try {
      const owner = await sourceFactScope(region);
      if (!owner) return [];
      const page = await listTilesObjectsBounded({ supabase: input.supabase, prefix: owner.prefix, limit: 129 }), records = page.objects;
      if (!page.complete || records.length > 128 || records.some(r => !r.name.startsWith(owner.prefix) || !/^fact-[a-f0-9]{64}\.json$/.test(r.name.slice(owner.prefix.length)) || r.size > 256 * 1024)) throw Error('Source fact history exceeds its bounded complete-read budget; previous votes were not reused.');
      const observations: AreaVisualObservation[] = [], seen = new Set<string>();
      let position = 0, aborted = false;
      const reads = await Promise.allSettled(Array.from({ length: Math.min(4, records.length) }, async () => {
        try { for (;;) {
          if (aborted) return;
          const entry = records[position++];
          if (!entry) return;
          if (Date.now() >= (deadline ?? 0) - 1000) throw Error('Source fact history could not be read completely before the recognition deadline.');
          const bytes = await downloadTilesObject({ supabase: input.supabase, path: entry.name, maxBytes: 256 * 1024 });
          if (bytes.length > 256 * 1024) throw Error('Persisted source fact size exceeds its budget.');
          const value = JSON.parse(bytes.toString('utf8')), image = value.sourceImage;
          if (!validRecognitionImageSource(image) || image.fileId !== input.source!.fileId || image.pageIndex !== input.source!.pageIndex || image.sourceHash !== owner.source.sourceHash || entry.name !== `${owner.prefix}fact-${value.digest}.json`) throw Error('Source facts have incompatible plan ownership.');
          const observation = restoreRecognitionSourceFacts(value, owner.scope, owner.index, region);
          if (observation && !seen.has(observation.id)) { seen.add(observation.id); observations.push(observation); }
        }} catch(error) { aborted = true; throw error; }
      }));
      const failure = reads.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      return observations.sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      warn(error); return [];
    }
  };
  // A complete listing establishes absent immutable request objects without
  // hundreds of remote misses. Incomplete/unavailable listings fall back to
  // exact reads; current writes also enter this process-local snapshot.
  let requestObjects: Promise<Set<string> | null> | undefined;
  const knownRequestObjects = () => requestObjects ??= (async () => {
    try {
      const page = await listTilesObjectsBounded({ supabase: input.supabase, prefix: `${input.tilesBasePath}/architecture/classification-`, limit: 1000 });
      return page.complete ? new Set(page.objects.map(o => o.name)) : null;
    } catch { return null; }
  })();
  const cached: NonNullable<AreaRecognizer["cached"]> = async (request) => {
    if (deadline !== undefined && Date.now() >= deadline - 1000) return null;
    let fingerprint: string;
    try {
      fingerprint = await fingerprintFor(request);
      if (Date.now() >= (deadline ?? 0) - 1000) return null;
    } catch (error) {
      warn(error);
      return null;
    }
    const previous = reads.get(fingerprint);
    if (previous) return previous;
    const path = `${input.tilesBasePath}/architecture/classification-${fingerprint}.json`;
    const known = await knownRequestObjects();
    if (known && !known.has(path)) return null;
    const read = (async () => {
      try {
        const saved = JSON.parse(
            (
              await downloadTilesObject({ supabase: input.supabase, path })
            ).toString("utf8"),
          ),
          parsed = visualInterpretationSchema.safeParse(saved.answer),
          s = saved.sourceImage;
        if (
          saved.fingerprint === fingerprint &&
          parsed.success &&
          usableRecognitionAnswer(request,parsed.data) &&
          accountsForWallSpans(request,parsed.data) &&
          validRecognitionImageSource(s) &&
          s.evidenceHash === evidenceHash &&
          ["x0", "y0", "x1", "y1"].every(
            (k) =>
              s.requestedRegion[k as keyof typeof s.requestedRegion] ===
              request.region[k as keyof typeof request.region],
          ) &&
          (input.source
            ? s.kind === "original-pdf" &&
              s.fileId === input.source.fileId &&
              s.pageIndex === input.source.pageIndex &&
              s.sourceHash === (await original(request))?.sourceHash
            : s.kind === "display-tiles")
        ) {
          images.set(requestKey(request), s);
          noteImageQuality(s);
          await saveSourceFacts(request, s, parsed.data).catch(warn);
          return parsed.data;
        }
      } catch {
        /* Missing/corrupt source classification is retryable. */
      }
      return null;
    })();
    reads.set(fingerprint, read);
    return read;
  };
  const recognize: AreaRecognizer = async (request) => {
    const previous = await cached(request);
    if (previous) return previous;
    try {
      if (closed) return null;
      const fingerprint = await fingerprintFor(request),
        path = `${input.tilesBasePath}/architecture/classification-${fingerprint}.json`;
      if (Date.now() >= (deadline ?? 0) - 1000) return null;
      const source = await original(request);
      if (source) {
        const sampling = source.inspectSampling(request.region);
        sampling.warnings.forEach((w) => warnings.add(w));
        if (
          sampling.kind === "native-raster" &&
          sampling.maximumSourceDpi! > 600.01
        )
          throw Error(
            "Original scan exceeds the 600 DPI recognition limit. Classification remains incomplete; source detail was not reduced.",
          );
      }
      const image = source
        ? await source.renderSourceWindow(request.region, 4096)
        : await renderSheetWindowImage({
            supabase: input.supabase,
            tilesBasePath: input.tilesBasePath,
            imageWidth: input.imageWidth,
            imageHeight: input.imageHeight,
            window: request.region,
            maxEdge: 2000,
            requireComplete: true,
            lossless: true,
          });
      if (!image || Date.now() >= (deadline ?? 0) - 1000) return null;
      if (
        source &&
        "sampling" in image &&
        image.sampling.kind === "native-raster" &&
        image.sampling.minimumSourceDpi! < 200
      )
        throw Error(
          "Original scan density is below 200 DPI. Supply a clearer plan before architectural classification.",
        );
      const sharp = (await import("sharp")).default,
        metadata = await sharp(image.data).metadata();
      if (!metadata.width || !metadata.height) return null;
      const region = image.sourceRegion ?? request.region,
        registered = registerRecognitionImage(request, region);
      const annotated = await sharp(image.data)
        .composite([
          {
            input: Buffer.from(
              recognitionOverlaySvg(
                registered,
                metadata.width,
                metadata.height,
              ),
            ),
          },
        ])
        .png()
        .toBuffer();
      const native = "sampling" in image ? image : null;
      const sourceImage: RecognitionImageSource = {
        profile: RECOGNITION_IMAGE_SOURCE_PROFILE,
        kind: source ? "original-pdf" : "display-tiles",
        fileId: input.source?.fileId ?? null,
        pageIndex: input.source?.pageIndex ?? null,
        sourceHash: source?.sourceHash ?? null,
        evidenceHash,
        requestedRegion: request.region,
        sourceRegion: region,
        width: metadata.width,
        height: metadata.height,
        nativeWidth: native?.nativeWidth ?? input.imageWidth,
        nativeHeight: native?.nativeHeight ?? input.imageHeight,
        renderDpi: native?.renderDpi ?? null,
        sampling: native?.sampling ?? null,
        nativeDensityPreserved:
          native !== null &&
          preservesNativeRecognitionDensity(native.sampling, native.renderDpi),
        imageSha256: sha(image.data),
        annotatedSha256: sha(annotated),
      };
      if (!validRecognitionImageSource(sourceImage))
        throw Error(
          "Recognition image source registration is invalid. Reprocess the drawing before classification.",
        );
      noteImageQuality(sourceImage);
      const answer = await runDrawingsVisionObject({
        orgId: input.orgId,
        entityType: "drawing_sheet_version",
        entityId: input.sheetVersionId,
        schema: request.wallHypotheses?.length ? wallHypothesisInterpretationProviderSchema : visualInterpretationProviderSchema,
        images: [image, { data: annotated, mediaType: "image/png" }],
        prompt: areaRecognitionPrompt(registered),
        tier: "standard",
        allowEscalation: false,
        allowFallback: false,
        verify: (answer) => ({ok:accountsForWallSpans(request,answer)&&usableRecognitionAnswer(request,answer),message:'Account for every measured wall span exactly once. Span-only requests must leave elements and openings empty.'}),
        timeoutMs: Math.max(
          1,
          Math.min(45000, (deadline ?? Date.now()) - Date.now()),
        ),
      });
      if (
        answer &&
        usableRecognitionAnswer(request,answer) && accountsForWallSpans(request,answer)
      ) {
        images.set(requestKey(request), sourceImage);
        await uploadTilesObject({
          supabase: input.supabase,
          path,
          bytes: Buffer.from(
            JSON.stringify({ fingerprint, sourceImage, answer }),
          ),
          contentType: "application/json",
        }).catch(() => {});
        reads.set(fingerprint, Promise.resolve(answer));
        (await knownRequestObjects())?.add(path);
        await saveSourceFacts(request, sourceImage, answer).catch(warn);
      }
      return answer && usableRecognitionAnswer(request,answer) && accountsForWallSpans(request,answer) ? answer : null;
    } catch (error) {
      warn(error);
      return null;
    }
  };
  recognize.cached = cached;
  recognize.prior = prior;
  recognize.windowBudget = async (region) => {
    try {
      const source = await original({ region, catalogue: [] });
      return source?.recognitionWindowBudget(region, 4096) ?? null;
    } catch (error) {
      warn(error);
      return null;
    }
  };
  recognize.sourceImage = (request) => images.get(requestKey(request));
  recognize.warnings = () => [...warnings];
  recognize.close = async () => {
    closed = true;
    const source = await sourcePromise?.catch(() => null);
    try {
      source?.close();
    } catch {
      warnings.add("Original recognition source cleanup failed.");
    }
  };
  return recognize;
}
