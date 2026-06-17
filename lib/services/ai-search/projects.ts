import "server-only"

import { PROJECT_NAME_NOISE_TOKENS } from "@/lib/services/ai-search/config"
import type { requireOrgContext } from "@/lib/services/context"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

export type ProjectRef = {
  id: string
  name: string
}

function normalizeLookupText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenizeProjectName(value: string) {
  return normalizeLookupText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !PROJECT_NAME_NOISE_TOKENS.has(token))
}

export function buildProjectCandidateScore(query: string, projectName: string) {
  const normalizedQuery = normalizeLookupText(query)
  const normalizedProjectName = normalizeLookupText(projectName)
  if (!normalizedQuery || !normalizedProjectName) return 0

  if (normalizedProjectName === normalizedQuery) return 10_000
  if (normalizedProjectName.includes(normalizedQuery)) return 5_000

  const queryTokens = tokenizeProjectName(normalizedQuery)
  if (queryTokens.length === 0) return 0
  const projectTokens = tokenizeProjectName(normalizedProjectName)
  const projectTokenSet = new Set(projectTokens)

  let score = 0
  for (const token of queryTokens) {
    if (projectTokenSet.has(token)) {
      score += 100
      continue
    }

    const startsWithMatch = projectTokens.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))
    if (startsWithMatch) {
      score += 45
    }
  }

  const queryBigrams = new Set<string>()
  for (let index = 0; index < queryTokens.length - 1; index += 1) {
    const first = queryTokens[index]
    const second = queryTokens[index + 1]
    if (first && second) {
      queryBigrams.add(`${first} ${second}`)
    }
  }
  for (const bigram of queryBigrams) {
    if (normalizedProjectName.includes(bigram)) {
      score += 80
    }
  }

  score += Math.round((queryTokens.length / Math.max(1, projectTokens.length)) * 10)
  return score
}

export async function resolveProjectByName(projectName: string, context: ResolvedOrgContext): Promise<ProjectRef | null> {
  const trimmed = projectName.trim()
  if (!trimmed) return null

  const exact = await context.supabase
    .from("projects")
    .select("id,name")
    .eq("org_id", context.orgId)
    .ilike("name", `%${trimmed}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!exact.error && exact.data?.id && exact.data?.name) {
    return { id: exact.data.id, name: exact.data.name }
  }

  const tokens = tokenizeProjectName(trimmed).slice(0, 6)
  if (tokens.length === 0) return null

  const tokenOrCondition = tokens
    .map((token) => token.replace(/[^a-z0-9&-]/gi, ""))
    .filter((token) => token.length >= 2)
    .map((token) => `name.ilike.%${token}%`)
    .join(",")

  let queryBuilder = context.supabase
    .from("projects")
    .select("id,name")
    .eq("org_id", context.orgId)
    .order("updated_at", { ascending: false })
    .limit(40)

  if (tokenOrCondition) {
    queryBuilder = queryBuilder.or(tokenOrCondition)
  }

  const fuzzy = await queryBuilder
  if (fuzzy.error || !Array.isArray(fuzzy.data) || fuzzy.data.length === 0) {
    return null
  }

  const ranked = fuzzy.data
    .map((candidate) => {
      const id = typeof candidate.id === "string" ? candidate.id : ""
      const name = typeof candidate.name === "string" ? candidate.name : ""
      if (!id || !name) return null
      return {
        id,
        name,
        score: buildProjectCandidateScore(trimmed, name),
      }
    })
    .filter((candidate): candidate is { id: string; name: string; score: number } => Boolean(candidate))
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0) return null
  const best = ranked[0]
  if (!best || best.score < 120) {
    return null
  }

  return { id: best.id, name: best.name }
}

export async function resolveProjectById(projectId: string, context: ResolvedOrgContext): Promise<ProjectRef | null> {
  const trimmed = projectId.trim()
  if (!trimmed) return null

  const { data, error } = await context.supabase
    .from("projects")
    .select("id,name")
    .eq("org_id", context.orgId)
    .eq("id", trimmed)
    .maybeSingle()

  if (error || !data?.id || !data?.name) return null
  return { id: data.id, name: data.name }
}

export async function resolveProjectFromHints(
  context: ResolvedOrgContext,
  ...hints: Array<string | undefined>
): Promise<ProjectRef | null> {
  for (const hint of hints) {
    if (!hint) continue
    const candidate = hint.trim()
    if (candidate.length < 3) continue
    if (tokenizeProjectName(candidate).length === 0) continue

    const resolved = await resolveProjectByName(candidate, context)
    if (resolved) return resolved
  }

  return null
}
