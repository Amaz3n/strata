import "server-only"

import { generationOptions, classifyAiError, isAvailabilityError, isTerminalAiError } from "@/lib/services/ai/policy"
import { consumeObjectStream } from "@/lib/services/ai/consume-object-stream"
import { generateObject, streamObject, generateText } from "ai"
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
import { recordAiUsage, toTokenUsage, usageFromError, type AiTokenUsage } from "@/lib/services/ai/usage"
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
const DEFAULT_MAX_ATTEMPTS_PER_TIER = 1
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
  /** Hard output budget for small background classifiers. */
  maxOutputTokens?: number
  /** Override the feature/model reasoning policy. */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high"
  /**
   * Deterministic gate. Return `{ok:false}` and the gateway escalates rather
   * than handing back a result that code already knows is wrong.
   */
  verify?: (value: T) => VerifyOutcome
  /** Allow moving up a tier on failure. Off for cost-capped background work. */
  allowEscalation?: boolean
  /** Optional local diagnostics; never changes retry or validation decisions. */
  onFailure?: (error: unknown) => void
  /** One cross-provider recovery for transient failures, even on cost-capped work. */
  allowFallback?: boolean
  /** Skip the per-org AI kill switch. Only for platform-internal calls. */
  ignoreKillSwitch?: boolean
}

function classifyError(error: unknown): { reason: AiFailureReason; kind: ReturnType<typeof classifyAiError> } {
  const kind = classifyAiError(error)
  return { kind, reason: kind === "timeout" ? "timeout" : kind === "no_object_generated" ? "invalid_output" : "provider_error" }
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
    allowFallback = true,
    ignoreKillSwitch = false,
  } = input

  if (!ignoreKillSwitch && !(await isAiEnabled(orgId))) {
    return { ok: false, reason: "disabled", message: "AI features are turned off for this organization.", meta: null }
  }

  const deadline = Date.now() + (input.totalTimeoutMs ?? timeoutMs)
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
  const unavailableProviders = new Set<AiProvider>()
  const attemptedModels = new Set<string>()
  let availabilityFallback = false

  while (tier) {
    const config = await getAiFeatureTierConfig({ supabase, feature, tier })
    if (unavailableProviders.has(config.provider) || attemptedModels.has(`${config.provider}:${config.model}`)) {
      tier = nextTier(tier)
      continue
    }
    const apiKey = getApiKeyForProvider(config.provider)

    if (!apiKey) {
      if (totalAttempts === 0) lastFailure = {
        reason: "not_configured",
        message: `${config.provider} is not configured for ${feature}.`,
      }
      // No key at this tier is not something a retry fixes; try the next rung.
      unavailableProviders.add(config.provider)
      availabilityFallback = allowFallback
      tier = allowEscalation || allowFallback ? nextTier(tier) : null
      continue
    }

    attemptedModels.add(`${config.provider}:${config.model}`)
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
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...generationOptions(config.provider, config.model, feature, input.reasoningEffort),
          // Reserve time for one recovery instead of spending the entire budget
          // waiting on a provider that may be overloaded.
          abortSignal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs,
            nextTier(tier) && (allowEscalation || (allowFallback && !availabilityFallback)) ? Math.floor(remainingMs / 2) : remainingMs))),
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

        const usage = toTokenUsage(result.usage, result.providerMetadata)
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

        await recordAiUsage(supabase, {
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
        try { input.onFailure?.(error) } catch { /* Diagnostics cannot affect generation. */ }
        const { reason, kind } = classifyError(error)
        const latencyMs = Date.now() - startedAt
        lastFailure = { reason, message: error instanceof Error ? error.message : String(error) }

        await recordAiUsage(supabase, {
          orgId,
          feature,
          tier,
          provider: config.provider,
          model: config.model,
          usage: usageFromError(error),
          latencyMs,
          attempt: totalAttempts,
          escalatedFrom: tier === startTier ? null : startTier,
          status: "error",
          errorKind: kind,
          errorMessage: lastFailure.message,
          entityType: entityType ?? null,
          entityId: entityId ?? null,
        })

        if (isTerminalAiError(kind)) return { ok: false, reason, message: lastFailure.message, meta: lastMeta }
        if (isAvailabilityError(kind)) {
          unavailableProviders.add(config.provider)
          if (!allowFallback || availabilityFallback) return { ok: false, reason, message: lastFailure.message, meta: lastMeta }
          availabilityFallback = true
          break
        }
        // Only invalid output is retried at the same tier; infrastructure errors
        // must not stampede an overloaded provider.
        if (kind !== "no_object_generated") break
      }
    }

    tier = allowEscalation || (allowFallback && unavailableProviders.has(config.provider)) ? nextTier(tier) : null
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
      maxRetries: 0,
      ...generationOptions(config.provider, config.model, feature),
      abortSignal: AbortSignal.timeout(timeoutMs),
      experimental_telemetry: {
        isEnabled: true,
        functionId: `ai.${feature}`,
        metadata: { feature, tier, provider: config.provider, model: config.model, orgId: orgId ?? "unknown" },
      },
    })

    const usage = toTokenUsage(result.usage, result.providerMetadata)
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

    await recordAiUsage(supabase, {
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
    await recordAiUsage(supabase, {
      orgId,
      feature,
      tier,
      provider: config.provider,
      model: config.model,
      usage: usageFromError(error),
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
