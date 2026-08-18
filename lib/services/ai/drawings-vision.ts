import "server-only"

import type { z } from "zod"

import { getAiFeatureTierConfig, type AiTier } from "@/lib/services/ai-config"
import { runAiObject } from "@/lib/services/ai/gateway"
import { isProviderConfigured } from "@/lib/services/ai/provider"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The one door drawings vision goes through.
 *
 * Until this existed, drawings kept a private request path: hand-rolled fetches
 * to `generativelanguage.googleapis.com` and `/v1/responses`, two bespoke
 * response-shape extractors, a fence-stripping JSON scraper, and a provider
 * resolution chain of its own. The visible cost was that drawings vision spent
 * real money and reported none of it — a symbol count that quietly turned into
 * nine model calls showed up on the AI console as nothing at all.
 *
 * The invisible cost was worse: the private path could not escalate, could not
 * be verified, ignored the per-org AI kill switch, and could only speak to two
 * of the three providers the registry offers. Routing through `runAiObject`
 * fixes all of that at once, and deletes ~200 lines of transport code.
 *
 * One copy of that transport still exists, in `workers/drawings-worker/` — the
 * retired Cloud Run worker. Nothing calls it (see its README) and it is kept
 * only until the in-app migration has soaked in prod; it is not a live
 * unmetered path, and it should be deleted rather than maintained.
 *
 * Vision failures return null rather than throwing. Every caller here is
 * best-effort by contract — assist must never make interpretation WORSE — and
 * the one place that does want a retry (metadata enrichment) turns null into a
 * throw itself, so the outbox owns its own recovery.
 */

export interface VisionImage {
  data: Buffer
  /** `image/webp` for everything the tile pyramid and page renderer produce. */
  mediaType: string
  filename?: string
}

/**
 * Is a drawings-vision provider reachable for this deployment?
 *
 * Resolved through the registry rather than off an env chain, so the model
 * chosen on the AI console is the one this answers about. Callers ask before
 * offering vision assist at all, so that a sheet with no vectors on an org with
 * no provider says "no help available here" instead of spinning and failing.
 */
export async function drawingsVisionConfigured(): Promise<boolean> {
  try {
    const config = await getAiFeatureTierConfig({
      supabase: createServiceSupabaseClient(),
      feature: "drawings_vision",
    })
    return isProviderConfigured(config.provider)
  } catch {
    return false
  }
}

export async function runDrawingsVisionObject<T>(input: {
  schema: z.ZodType<T>
  system?: string
  prompt: string
  images: VisionImage[]
  orgId?: string | null
  entityType?: string
  entityId?: string
  tier?: AiTier
  timeoutMs?: number
  /** Off for interactive callers: a user waiting on a sheet will not wait twice. */
  allowEscalation?: boolean
  verify?: (value: T) => { ok: boolean; message?: string }
}): Promise<T | null> {
  const result = await runAiObject({
    feature: "drawings_vision",
    schema: input.schema,
    system: input.system,
    prompt: input.prompt,
    files: input.images.map((image) => ({
      data: image.data,
      mediaType: image.mediaType,
      filename: image.filename,
    })),
    orgId: input.orgId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
    tier: input.tier,
    timeoutMs: input.timeoutMs,
    allowEscalation: input.allowEscalation ?? false,
    verify: input.verify,
  })

  if (!result.ok) {
    // Worth a line in the log: a provider that has started refusing is invisible
    // otherwise, because every caller degrades silently by design.
    if (result.reason !== "disabled" && result.reason !== "not_configured") {
      console.warn(`[drawings-vision] ${result.reason}: ${result.message}`)
    }
    return null
  }

  return result.object
}
