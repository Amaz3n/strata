import "server-only"

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { AiProvider } from "@/lib/services/ai-config"
import type { SearchResult } from "@/lib/services/search"

const REQUEST_TIMEOUT_MS = 12_000

const LLM_SYSTEM_PROMPT =
  "You are an org data assistant for builders. Only answer from provided sources. If evidence is weak, say what is missing. Return strict JSON with keys: answer (string), citation_ids (string[]). Keep answer concise and actionable."

const GENERAL_ASSISTANT_SYSTEM_PROMPT = `You are a helpful assistant for construction teams.
- You can answer broad questions, even when they are not about org records.
- Be direct, practical, and concise.
- If a question needs org-specific facts, say you cannot verify it without org data context.
- Do not fabricate org-specific details.
- Return plain text only.`

type RetrievedSource = {
  sourceId: string
  result: SearchResult
}

type ParsedModelAnswer = {
  answer: string
  citation_ids: string[]
}

export type LlmAnswer = {
  answer: string
  citationIds: string[]
  provider: AiProvider
  model: string
}

export type GeneralAssistantAnswer = {
  answer: string
  provider: AiProvider
  model: string
}

function formatEntityType(type: string) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatSourceContext(sources: RetrievedSource[]) {
  return sources
    .map(({ sourceId, result }) => {
      const lines = [
        `[${sourceId}]`,
        `Type: ${formatEntityType(result.type)}`,
        `Title: ${result.title}`,
      ]

      if (result.subtitle) lines.push(`Subtitle: ${result.subtitle}`)
      if (result.description) lines.push(`Description: ${result.description}`)
      if (result.project_name) lines.push(`Project: ${result.project_name}`)
      if (result.updated_at) lines.push(`Updated: ${result.updated_at}`)
      lines.push(`Href: ${result.href}`)

      return lines.join("\n")
    })
    .join("\n\n")
}

function cleanJsonCandidate(raw: string) {
  const trimmed = raw.trim()

  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim()
  }

  return trimmed
}

function parseModelAnswer(raw: string): ParsedModelAnswer | null {
  const candidates = [cleanJsonCandidate(raw)]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1).trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown
        citation_ids?: unknown
      }

      if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
        continue
      }

      const citationIds = Array.isArray(parsed.citation_ids)
        ? parsed.citation_ids.filter((item): item is string => typeof item === "string")
        : []

      return {
        answer: parsed.answer.trim(),
        citation_ids: citationIds,
      }
    } catch {
      continue
    }
  }

  return null
}

export function getApiKeyForProvider(provider: AiProvider) {
  if (provider === "openai") {
    const configuredKey = process.env.OPENAI_API_KEY?.trim()
    if (configuredKey) return configuredKey

    if (getOpenAiBaseUrl()) {
      return process.env.OPENAI_COMPAT_API_KEY?.trim() || "local-dev-key"
    }

    return undefined
  }
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY?.trim() || undefined
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || undefined
}

export function getOpenAiBaseUrl() {
  const configured = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_COMPAT_BASE_URL
  if (!configured) return undefined
  const normalized = configured.trim()
  return normalized.length > 0 ? normalized : undefined
}

function buildPrompt(query: string, sources: RetrievedSource[], additionalContext?: string) {
  const sourceContext = formatSourceContext(sources)
  const contextBlock = additionalContext?.trim() ? `\n\nAdditional context:\n${additionalContext.trim()}` : ""
  return `Question:\n${query}${contextBlock}\n\nSources:\n${sourceContext}`
}

export function resolveLanguageModel(provider: AiProvider, apiKey: string, model: string) {
  const normalizedModel = provider === "google" && model.startsWith("models/") ? model.slice("models/".length) : model

  if (provider === "openai") {
    return createOpenAI({
      apiKey,
      baseURL: getOpenAiBaseUrl(),
    })(normalizedModel)
  }

  if (provider === "anthropic") {
    return createAnthropic({ apiKey })(normalizedModel)
  }

  return createGoogleGenerativeAI({ apiKey })(normalizedModel)
}

export async function generateAnswerWithLlm(
  query: string,
  sources: RetrievedSource[],
  provider: AiProvider,
  model: string,
  additionalContext?: string,
): Promise<LlmAnswer | null> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey || sources.length === 0) {
    return null
  }
  const languageModel = resolveLanguageModel(provider, apiKey, model)

  try {
    const result = await generateText({
      model: languageModel,
      system: LLM_SYSTEM_PROMPT,
      prompt: buildPrompt(query, sources, additionalContext),
      temperature: 0.2,
      maxOutputTokens: 700,
      timeout: REQUEST_TIMEOUT_MS,
    })
    const parsed = parseModelAnswer(result.text)
    if (!parsed) {
      return null
    }
    return {
      answer: parsed.answer,
      citationIds: parsed.citation_ids,
      provider,
      model,
    }
  } catch (error) {
    console.error("AI search generation failed", error)
    return null
  }
}

export async function generateGeneralAssistantAnswer({
  query,
  provider,
  model,
  sessionContext,
}: {
  query: string
  provider: AiProvider
  model: string
  sessionContext?: string
}): Promise<GeneralAssistantAnswer | null> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const contextBlock = sessionContext?.trim() ? `\n\nRecent conversation context:\n${sessionContext.trim()}` : ""
    const result = await generateText({
      model: languageModel,
      system: GENERAL_ASSISTANT_SYSTEM_PROMPT,
      prompt: `User question:\n${query}${contextBlock}`,
      temperature: 0.4,
      maxOutputTokens: 700,
      timeout: REQUEST_TIMEOUT_MS,
    })

    const answer = result.text.trim()
    if (!answer) return null
    return {
      answer,
      provider,
      model,
    }
  } catch (error) {
    console.error("General assistant generation failed", error)
    return null
  }
}
