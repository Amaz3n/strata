import "server-only"

import {
  ENTITY_ATTRIBUTE_CONFIGS,
  ENTITY_HREF_FALLBACKS,
  ENTITY_INTENTS,
  normalizeAttributeScalar,
} from "@/lib/services/ai-search/config"
import { buildProjectCandidateScore, resolveProjectByName } from "@/lib/services/ai-search/projects"
import type { requireOrgContext } from "@/lib/services/context"
import { searchEntities, type SearchEntityType, type SearchResult } from "@/lib/services/search"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

export type EntityAttributeIntent = {
  entityType: SearchEntityType
  fieldKey: string
  targetHint?: string
}

export type EntityAttributeExecution = {
  answer: string
  relatedResult?: SearchResult
  confidence: "low" | "medium" | "high"
  missingData: string[]
}

type EntityAttributeCandidateResolution = {
  reason: "match" | "ambiguous" | "not_found"
  candidate?: SearchResult
  suggestions: SearchResult[]
}

function formatEntityType(type: SearchEntityType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

async function resolveEntityAttributeCandidate(
  context: ResolvedOrgContext,
  intent: EntityAttributeIntent,
  query: string,
): Promise<EntityAttributeCandidateResolution> {
  const target = intent.targetHint?.trim() ?? ""

  if (intent.entityType === "project" && target.length >= 2) {
    const project = await resolveProjectByName(target, context)
    if (project) {
      return {
        reason: "match",
        candidate: {
          id: project.id,
          type: "project",
          title: project.name,
          href: ENTITY_HREF_FALLBACKS.project.replace("{id}", project.id),
        },
        suggestions: [],
      }
    }
  }

  const lookupQuery = target.length > 0 ? target : query
  const candidates = await searchEntities(
    lookupQuery,
    [intent.entityType],
    {},
    { limit: 8, sortBy: "updated_at" },
    context.orgId,
    context,
  )
  if (candidates.length === 0) {
    return {
      reason: "not_found",
      suggestions: [],
    }
  }
  if (!target) {
    return {
      reason: "match",
      candidate: candidates[0] ?? undefined,
      suggestions: candidates.slice(0, 3),
    }
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: buildProjectCandidateScore(target, candidate.title),
    }))
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]
  if (!best) {
    return {
      reason: "not_found",
      suggestions: candidates.slice(0, 3),
    }
  }

  const runnerUp = ranked[1]
  const suggestions = ranked.slice(0, 3).map((item) => item.candidate)
  if (best.score < 60) {
    return {
      reason: "not_found",
      suggestions,
    }
  }
  if (runnerUp && best.score < 90 && best.score - runnerUp.score < 10) {
    return {
      reason: "ambiguous",
      suggestions,
    }
  }

  return {
    reason: "match",
    candidate: best.candidate,
    suggestions,
  }
}

export async function executeEntityAttributeLookupIntent(
  intent: EntityAttributeIntent,
  query: string,
  context: ResolvedOrgContext,
): Promise<EntityAttributeExecution> {
  const entityConfig = ENTITY_ATTRIBUTE_CONFIGS[intent.entityType]
  if (!entityConfig) {
    return {
      answer: "I couldn't identify a supported entity for that field lookup.",
      confidence: "low",
      missingData: ["Unsupported entity for field lookup."],
    }
  }

  const fieldConfig = entityConfig.fields.find((field) => field.key === intent.fieldKey)
  if (!fieldConfig) {
    return {
      answer: "I couldn't map that field request to a supported attribute.",
      confidence: "low",
      missingData: ["Unsupported field lookup."],
    }
  }

  const entityLabel = ENTITY_INTENTS.find((entity) => entity.type === intent.entityType)?.label ?? formatEntityType(intent.entityType).toLowerCase()

  if (!intent.targetHint) {
    return {
      answer: `I can fetch ${fieldConfig.label}, but I need the specific ${entityLabel} name. Try quoting it, for example: "${fieldConfig.label} for \\\"Project Name\\\""`,
      confidence: "low",
      missingData: [`Missing ${entityLabel} identifier for field lookup.`],
    }
  }

  const candidateResolution = await resolveEntityAttributeCandidate(context, intent, query)
  const suggestionText =
    candidateResolution.suggestions.length > 0
      ? ` Closest matches: ${candidateResolution.suggestions
          .slice(0, 3)
          .map((result) => `"${result.title}"`)
          .join(", ")}.`
      : ""

  if (candidateResolution.reason === "ambiguous") {
    return {
      answer: `I found multiple ${entityLabel} matches for "${intent.targetHint}". Please specify which one.${suggestionText}`,
      confidence: "low",
      missingData: [`Multiple ${entityLabel} records matched the provided identifier.`],
    }
  }

  const candidate = candidateResolution.candidate
  if (!candidate) {
    return {
      answer: `I couldn’t find a ${entityLabel} matching "${intent.targetHint}" in your org.${suggestionText}`,
      confidence: "low",
      missingData: [`No ${entityLabel} matched the provided identifier.`],
    }
  }

  const { data, error } = await context.supabase
    .from(entityConfig.table)
    .select(entityConfig.rowSelect)
    .eq("org_id", context.orgId)
    .eq("id", candidate.id)
    .maybeSingle()

  if (error || !data) {
    return {
      answer: `I found ${entityLabel} "${candidate.title}" but couldn't load ${fieldConfig.label} right now.`,
      relatedResult: candidate,
      confidence: "low",
      missingData: [`Failed to load ${fieldConfig.label} from ${entityLabel} record.`],
    }
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    return {
      answer: `I found ${entityLabel} "${candidate.title}" but couldn't interpret ${fieldConfig.label} from that record.`,
      relatedResult: candidate,
      confidence: "low",
      missingData: [`Unexpected ${entityLabel} payload shape while reading ${fieldConfig.label}.`],
    }
  }

  const row = data as Record<string, unknown>
  const resolvedTitle = normalizeAttributeScalar(row[entityConfig.titleField]) ?? candidate.title
  const value = fieldConfig.extract(row)
  const resolvedProjectId = (row.project_id || candidate.project_id) as string || ""
  const fallbackHref = ENTITY_HREF_FALLBACKS[intent.entityType]
    ?.replace("{id}", candidate.id)
    ?.replace("{project_id}", resolvedProjectId) ?? candidate.href
  const relatedResult: SearchResult = {
    ...candidate,
    title: resolvedTitle,
    href: fallbackHref,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : candidate.updated_at,
  }

  if (!value) {
    return {
      answer: `The ${entityLabel} "${resolvedTitle}" does not have ${fieldConfig.label} set.`,
      relatedResult,
      confidence: "medium",
      missingData: [`${fieldConfig.label} is missing on the matched ${entityLabel}.`],
    }
  }

  return {
    answer: `The ${fieldConfig.label} for ${entityLabel} "${resolvedTitle}" is ${value}.`,
    relatedResult,
    confidence: "high",
    missingData: [],
  }
}
