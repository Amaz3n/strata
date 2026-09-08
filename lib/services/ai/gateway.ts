import "server-only"

import { consumeObjectStream } from "@/lib/services/ai/consume-object-stream"
import { generateObject, streamObject, generateText, NoObjectGeneratedError } from "ai"
import type { z } from "zod"

import {
  getAiFeatureTierConfig,
  nextTier,
  supportsPdfInput,
  AI_FEATURE_BASE_TIER,
  type AiFeature,
  type AiProvider,
  type AiTier,
} from "@/lib/services/ai-config"
import { rasterizePdfToImages } from "@/lib/services/ai/pdf-raster"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai/provider"
import { recordAiUsage, type AiTokenUsage } from "@/lib/services/ai/usage"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The one door every AI call in Arc goes through.
 *
 * Before this existed, each feature hand-rolled its own provider lookup, its own
 * JSON scraping, and its own idea of a timeout — which is why two call sites had
 * retries, one had none, and two had no timeout at all. Centralising that is not
 * tidiness: it is what makes "escalate to a better model when the numbers do not
 * reconcile" a parameter instead of a project.
 *
 * Four guarantees:
 *
 * - SCHEMA, NOT PROSE. Callers pass a Zod schema and get a typed object. There
 *   is no fence-stripping or brace-slicing anywhere behind this door.
 * - VERIFY THEN ESCALATE. A caller may supply a deterministic `verify` — sums
 *   that must reconcile, IDs that must exist. A result that fails verification
 *   is not returned; it escalates a tier and tries again. The model never gets
 *   the final say on something code can check.
 * - EVERY ATTEMPT IS BILLED AND LOGGED. One usage row per attempt, including the
 *   ones that failed, so the platform page shows what escalation actually costs.
 * - FAILURE IS DATA. Callers get a discriminated result, not an exception, so a
 *   scan that fails leaves the user's sheet open instead of throwing a digest.
 */

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ATTEMPTS_PER_TIER = 2
const AI_ENABLED_FLAG_KEY = "ai_enabled"

/** A file part for vision calls — images and PDFs alike. */
export interface AiFilePart {
  data: Buffer | Uint8Array | string
  mediaType: string
  filename?: string
}

export type AiFailureReason =
  | "disabled"
  | "not_configured"
  | "timeout"
  | "invalid_output"
  | "verification_failed"
  | "provider_error"

export interface AiCallMeta {
  provider: AiProvider
  model: string
  tier: AiTier
  latencyMs: number
  attempts: number
  escalated: boolean
  usage: AiTokenUsage
}

export type AiObjectResult<T> =
  | { ok: true; object: T; meta: AiCallMeta }
  | { ok: false; reason: AiFailureReason; message: string; meta: AiCallMeta | null }

export interface VerifyOutcome {
  ok: boolean
  /** Shown in logs and used to nudge the retry prompt. */
  message?: string
}

export interface RunAiObjectInput<T> {
  feature: AiFeature
  /** Starting tier. Defaults to the feature's base tier. */
  tier?: AiTier
  schema: z.ZodType<T>
  /** Provisional display data only; never bypasses final schema verification. */
  onPartial?: (value: unknown) => void | Promise<void>
  system?: string
  prompt: string
  files?: AiFilePart[]
  orgId?: string | null
  /** Correlation for the usage row, e.g. the bill being scanned. */
  entityType?: string
  entityId?: string
  timeoutMs?: number
  /** Total model-work budget across tiers, including preparation. */
  totalTimeoutMs?: number
  /** Attempts at a single tier before escalating. */
  maxAttemptsPerTier?: number
  /**
   * Deterministic gate. Return `{ok:false}` and the gateway escalates rather
   * than handing back a result that code already knows is wrong.
   */
  verify?: (value: T) => VerifyOutcome
  /** Allow moving up a tier on failure. Off for cost-capped background work. */
  allowEscalation?: boolean
  /** Skip the per-org AI kill switch. Only for platform-internal calls. */
  ignoreKillSwitch?: boolean
}

function toTokenUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): AiTokenUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  }
}

const EMPTY_USAGE: AiTokenUsage = { inputTokens: null, outputTokens: null, totalTokens: null }

function classifyError(error: unknown): { reason: AiFailureReason; kind: string } {
  if (NoObjectGeneratedError.isInstance(error)) {
    return { reason: "invalid_output", kind: "no_object_generated" }
  }
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : String(error)
  if (name === "AbortError" || name === "TimeoutError" || /timeout|aborted/i.test(message)) {
    return { reason: "timeout", kind: "timeout" }
  }
  if (/rate.?limit|429/i.test(message)) return { reason: "provider_error", kind: "rate_limit" }
  if (/quota|billing/i.test(message)) return { reason: "provider_error", kind: "quota" }
  return { reason: "provider_error", kind: "provider_error" }
}

function isRetryable(kind: string) {
  return kind === "rate_limit" || kind === "timeout" || kind === "provider_error" || kind === "no_object_generated"
}

/** Exponential backoff with jitter, so a rate limit does not resolve into a stampede. */
function backoffMs(attempt: number) {
  return Math.min(4_000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250)
}

// ---------------------------------------------------------------------------
// PDF handling
// ---------------------------------------------------------------------------

function toBuffer(data: Buffer | Uint8Array | string): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (typeof data === "string") {
    const base64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data
    try {
      return Buffer.from(base64, "base64")
    } catch {
      return null
    }
  }
  return null
}

interface PreparedFiles {
  files: AiFilePart[]
  /** Non-null when rasterisation had to drop pages the model will never see. */
  disclosure: string | null
}

/**
 * Make the attachments legible to whichever model this tier resolved to.
 *
 * This is the reason the gateway is the right home for rasterisation rather than
 * each caller: escalation can move a call from Gemini (reads PDFs) to a model
 * behind OpenRouter (does not) mid-flight, so the decision has to be re-made per
 * attempt, against the provider that is actually about to run.
 *
 * Results are cached per call, keyed on the file's position, so a three-rung
 * escalation ladder rasterises a document once rather than three times.
 */
async function prepareFilesForProvider(
  files: AiFilePart[],
  provider: AiProvider,
  cache: Map<number, PreparedFiles | null>,
): Promise<PreparedFiles> {
  if (files.length === 0 || supportsPdfInput(provider)) return { files, disclosure: null }

  const prepared: AiFilePart[] = []
  const disclosures: string[] = []

  for (const [index, file] of files.entries()) {
    if (file.mediaType !== "application/pdf") {
      prepared.push(file)
      continue
    }

    if (!cache.has(index)) {
      const bytes = toBuffer(file.data)
      let result: PreparedFiles | null = null
      if (bytes) {
        try {
          const raster = await rasterizePdfToImages(bytes, {
            label: file.filename?.replace(/\.pdf$/i, "") || "page",
          })
          if (raster) {
            result = {
              files: raster.images.map((image) => ({
                data: image.data,
                mediaType: image.mediaType,
                filename: image.filename,
              })),
              disclosure: raster.plan.disclosure,
            }
          }
        } catch (error) {
          console.warn("[ai-gateway] PDF rasterisation failed; sending the original file", error)
        }
      }
      cache.set(index, result)
    }

    const cached = cache.get(index) ?? null
    if (cached) {
      prepared.push(...cached.files)
      if (cached.disclosure) disclosures.push(cached.disclosure)
    } else {
      // Rasterisation failed. Sending the PDF anyway lets the provider return a
      // real error instead of us inventing one, and costs nothing when the
      // provider turns out to handle it after all.
      prepared.push(file)
    }
  }

  return { files: prepared, disclosure: disclosures.length > 0 ? disclosures.join("\n") : null }
}

async function isAiEnabled(orgId: string | null | undefined) {
  if (!orgId) return true
  try {
    return await isFeatureEnabledForOrg({
      supabase: createServiceSupabaseClient(),
      orgId,
      flagKey: AI_ENABLED_FLAG_KEY,
      defaultEnabled: true,
    })
  } catch {
    // A flag lookup failure must not take AI down.
    return true
  }
}

/**
 * Run one structured-output call, escalating tiers until the result verifies or
 * the ladder runs out.
 */
export async function runAiObject<T>(input: RunAiObjectInput<T>): Promise<AiObjectResult<T>> {
  const {
    feature,
    schema,
    system,
    prompt,
    files = [],
    orgId = null,
    entityType,
    entityId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttemptsPerTier = DEFAULT_MAX_ATTEMPTS_PER_TIER,
    verify,
    allowEscalation = true,
    ignoreKillSwitch = false,
  } = input

  if (!ignoreKillSwitch && !(await isAiEnabled(orgId))) {
    return { ok: false, reason: "disabled", message: "AI features are turned off for this organization.", meta: null }
  }

  const deadline = input.totalTimeoutMs ? Date.now() + input.totalTimeoutMs : Infinity
  const supabase = createServiceSupabaseClient()
  const startTier = input.tier ?? AI_FEATURE_BASE_TIER[feature]

  let tier: AiTier | null = startTier
  let totalAttempts = 0
  let lastFailure: { reason: AiFailureReason; message: string } = {
    reason: "provider_error",
    message: "The model could not be reached.",
  }
  let lastMeta: AiCallMeta | null = null
  const rasterCache = new Map<number, PreparedFiles | null>()

  while (tier) {
    const config = await getAiFeatureTierConfig({ supabase, feature, tier })
    const apiKey = getApiKeyForProvider(config.provider)

    if (!apiKey) {
      if (totalAttempts === 0) lastFailure = {
        reason: "not_configured",
        message: `${config.provider} is not configured for ${feature}.`,
      }
      // No key at this tier is not something a retry fixes; try the next rung.
      tier = allowEscalation ? nextTier(tier) : null
      continue
    }

    const model = resolveLanguageModel(config.provider, apiKey, config.model)
    const prepared = await prepareFilesForProvider(files, config.provider, rasterCache)
    // Truncation is disclosed to the model, not swallowed: a bill whose last
    // pages were dropped must not be summarised as though it were complete.
    const tierPrompt = prepared.disclosure ? `${prompt}\n\n${prepared.disclosure}` : prompt

    for (let attempt = 1; attempt <= maxAttemptsPerTier; attempt += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return { ok: false, reason: "timeout", message: "The scan took too long. Please retry or enter the details manually.", meta: lastMeta }
      totalAttempts += 1
      const startedAt = Date.now()

      // A retry at the same tier tells the model what was wrong with the last
      // answer; a first attempt stays clean so the prompt cache can hit.
      const attemptPrompt =
        attempt === 1
          ? tierPrompt
          : `${tierPrompt}\n\nYour previous answer was rejected: ${lastFailure.message}\nReturn a corrected answer that satisfies the schema.`

      try {
        const options = {
          model,
          schema,
          system,
          messages: [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: attemptPrompt },
                ...prepared.files.map((file) => ({
                  type: "file" as const,
                  data: file.data,
                  mediaType: file.mediaType,
                  filename: file.filename,
                })),
              ],
            },
          ],
          // The gateway owns retries; SDK retries would multiply every attempt.
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
          experimental_telemetry: {
            isEnabled: true,
            functionId: `ai.${feature}`,
            metadata: { feature, tier, provider: config.provider, model: config.model, orgId: orgId ?? "unknown" },
          },
        }
        const result = await (async () => {
          if (!input.onPartial) return generateObject(options)
          const stream = streamObject({ ...options, onError: () => {} })
          return consumeObjectStream(stream, input.onPartial)
        })()

        const usage = toTokenUsage(result.usage)
        const latencyMs = Date.now() - startedAt
        const meta: AiCallMeta = {
          provider: config.provider,
          model: config.model,
          tier,
          latencyMs,
          attempts: totalAttempts,
          escalated: tier !== startTier,
          usage,
        }
        lastMeta = meta

        const verdict = verify ? verify(result.object) : { ok: true }

        void recordAiUsage(supabase, {
          orgId,
          feature,
          tier,
          provider: config.provider,
          model: config.model,
          usage,
          latencyMs,
          attempt: totalAttempts,
          escalatedFrom: tier === startTier ? null : startTier,
          status: verdict.ok ? "ok" : "error",
          errorKind: verdict.ok ? null : "verification_failed",
          errorMessage: verdict.ok ? null : verdict.message ?? null,
          entityType: entityType ?? null,
          entityId: entityId ?? null,
        })

        if (verdict.ok) {
          return { ok: true, object: result.object, meta }
        }

        lastFailure = {
          reason: "verification_failed",
          message: verdict.message ?? "The extracted values did not reconcile.",
        }
      } catch (error) {
        const { reason, kind } = classifyError(error)
        const latencyMs = Date.now() - startedAt
        lastFailure = { reason, message: error instanceof Error ? error.message : String(error) }

        void recordAiUsage(supabase, {
          orgId,
          feature,
          tier,
          provider: config.provider,
          model: config.model,
          usage: EMPTY_USAGE,
          latencyMs,
          attempt: totalAttempts,
          escalatedFrom: tier === startTier ? null : startTier,
          status: "error",
          errorKind: kind,
          errorMessage: lastFailure.message,
          entityType: entityType ?? null,
          entityId: entityId ?? null,
        })

        if (!isRetryable(kind)) break
        if (attempt < maxAttemptsPerTier) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)))
        }
      }
    }

    tier = allowEscalation ? nextTier(tier) : null
  }

  return { ok: false, reason: lastFailure.reason, message: lastFailure.message, meta: lastMeta }
}

export type AiTextResult =
  | { ok: true; text: string; meta: AiCallMeta }
  | { ok: false; reason: AiFailureReason; message: string; meta: AiCallMeta | null }

/**
 * Freeform text, for the handful of cases with no useful schema (transcription
 * prompts, narration). Same telemetry and kill switch; no escalation ladder,
 * because there is nothing deterministic to verify against.
 */
export async function runAiText(input: {
  feature: AiFeature
  tier?: AiTier
  system?: string
  prompt: string
  files?: AiFilePart[]
  orgId?: string | null
  entityType?: string
  entityId?: string
  timeoutMs?: number
  ignoreKillSwitch?: boolean
}): Promise<AiTextResult> {
  const {
    feature,
    system,
    prompt,
    files = [],
    orgId = null,
    entityType,
    entityId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ignoreKillSwitch = false,
  } = input

  if (!ignoreKillSwitch && !(await isAiEnabled(orgId))) {
    return { ok: false, reason: "disabled", message: "AI features are turned off for this organization.", meta: null }
  }

  const supabase = createServiceSupabaseClient()
  const tier = input.tier ?? AI_FEATURE_BASE_TIER[feature]
  const config = await getAiFeatureTierConfig({ supabase, feature, tier })
  const apiKey = getApiKeyForProvider(config.provider)
  if (!apiKey) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${config.provider} is not configured for ${feature}.`,
      meta: null,
    }
  }

  const prepared = await prepareFilesForProvider(files, config.provider, new Map())
  const startedAt = Date.now()
  try {
    const result = await generateText({
      model: resolveLanguageModel(config.provider, apiKey, config.model),
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prepared.disclosure ? `${prompt}\n\n${prepared.disclosure}` : prompt },
            ...prepared.files.map((file) => ({
              type: "file" as const,
              data: file.data,
              mediaType: file.mediaType,
              filename: file.filename,
            })),
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(timeoutMs),
      experimental_telemetry: {
        isEnabled: true,
        functionId: `ai.${feature}`,
        metadata: { feature, tier, provider: config.provider, model: config.model, orgId: orgId ?? "unknown" },
      },
    })

    const usage = toTokenUsage(result.usage)
    const latencyMs = Date.now() - startedAt
    const meta: AiCallMeta = {
      provider: config.provider,
      model: config.model,
      tier,
      latencyMs,
      attempts: 1,
      escalated: false,
      usage,
    }

    void recordAiUsage(supabase, {
      orgId,
      feature,
      tier,
      provider: config.provider,
      model: config.model,
      usage,
      latencyMs,
      attempt: 1,
      escalatedFrom: null,
      status: "ok",
      errorKind: null,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
    })

    return { ok: true, text: result.text.trim(), meta }
  } catch (error) {
    const { reason, kind } = classifyError(error)
    void recordAiUsage(supabase, {
      orgId,
      feature,
      tier,
      provider: config.provider,
      model: config.model,
      usage: EMPTY_USAGE,
      latencyMs: Date.now() - startedAt,
      attempt: 1,
      escalatedFrom: null,
      status: "error",
      errorKind: kind,
      errorMessage: error instanceof Error ? error.message : String(error),
      entityType: entityType ?? null,
      entityId: entityId ?? null,
    })
    return { ok: false, reason, message: error instanceof Error ? error.message : String(error), meta: null }
  }
}
