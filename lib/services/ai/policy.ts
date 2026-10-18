import type { AiFeature, AiProvider, AiTier } from "@/lib/services/ai-config"
import type { generateText } from "ai"

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high"

/** Explicit GPT-6 support for SDK versions whose model allowlist predates it. */
export function generationOptions(provider: AiProvider, model: string, feature: AiFeature, effort?: ReasoningEffort): Pick<Parameters<typeof generateText>[0], "providerOptions"> {
  // Gemini 3 uses thinkingLevel, not the earlier token thinkingBudget. Preserve
  // provider defaults unless the caller explicitly selects an effort.
  if (provider === "google" && /^gemini-3(?:[.-])/.test(model) && effort) {
    const thinkingLevel = effort === "none" || effort === "minimal" ? "low" : effort;
    return { providerOptions: { google: { thinkingConfig: { thinkingLevel } } } };
  }
  if (provider === "openai" && /^gpt-(5|6)/.test(model)) {
    const supportsNone = /^gpt-6-(luna|sol)/.test(model) || /^gpt-5\.[1-9]/.test(model)
    let selected = effort ?? (!supportsNone || /sol|terra/.test(model) || feature === "bank_transaction_coding" ? "low" : "none")
    if ((!supportsNone && selected === "none") || (model.startsWith("gpt-6") && selected === "minimal")) selected = "low"
    return { providerOptions: { openai: { forceReasoning: true, reasoningEffort: selected } } }
  }
  return {}
}

export type AiErrorKind = "authentication" | "invalid_schema" | "invalid_request" | "quota" | "rate_limit" | "unavailable" | "timeout" | "no_object_generated" | "provider_error"

export function classifyAiError(error: unknown): AiErrorKind {
  const value = error as { name?: string; message?: string; statusCode?: number }
  const message = value?.message ?? String(error)
  if (value?.statusCode === 401 || value?.statusCode === 403 || /incorrect api key|invalid api key|unauthorized|authentication/i.test(message)) return "authentication"
  if (/invalid schema|response_schema|response_format.*invalid|generation_config.*schema/i.test(message)) return "invalid_schema"
  if (/quota|billing|insufficient_quota/i.test(message)) return "quota"
  if (value?.statusCode === 429 || /rate.?limit|\b429\b/i.test(message)) return "rate_limit"
  if (value?.name === "AbortError" || value?.name === "TimeoutError" || /timeout|timed out|aborted/i.test(message)) return "timeout"
  if ((value?.statusCode ?? 0) >= 500 || /high demand|overloaded|unavailable|fetch failed|Cannot connect to API|ENOTFOUND|ECONNRESET/i.test(message)) return "unavailable"
  if (/NoObjectGenerated/.test(value?.name ?? "")) return "no_object_generated"
  if (value?.statusCode === 400 || value?.statusCode === 404 || value?.statusCode === 422) return "invalid_request"
  return "provider_error"
}

export function isAvailabilityError(kind: AiErrorKind) {
  return kind === "rate_limit" || kind === "unavailable" || kind === "timeout"
}

export function isTerminalAiError(kind: AiErrorKind) {
  return ["authentication", "invalid_schema", "invalid_request", "quota", "provider_error"].includes(kind)
}

/** Routing hint only. Ambiguous queries stay on the economical route. */
export function assistantTier(query: string): AiTier {
  return /\b(reconcile|root cause|trade.?offs?|scenario|forecast|compare.+(?:projects|budgets|bids)|across all projects)\b/i.test(query) ? "heavy" : "standard"
}

/** Never replay a stream after an answer or a tool call: tools may create drafts. */
export function canRetryAssistant(input: { kind: AiErrorKind; emittedText: boolean; calledTool: boolean; aborted: boolean; remainingMs: number }) {
  return isAvailabilityError(input.kind) && !input.emittedText && !input.calledTool && !input.aborted && input.remainingMs > 1000
}

export function redactAiError(message: string) {
  return message.replace(/\bsk-[^\s"']+/g, "[redacted]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").slice(0, 500)
}
