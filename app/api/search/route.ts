import { NextRequest, NextResponse } from "next/server"
import { searchAll, searchEntities } from "@/lib/services/search"
import { SEARCH_CONFIGS, type SearchEntityType } from "@/lib/services/search-config"

const MIN_QUERY_LENGTH = 2
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function clampLimit(raw: string | null) {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, parsed))
}

function parseEntityTypes(raw: string | null): SearchEntityType[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is SearchEntityType =>
      Object.prototype.hasOwnProperty.call(SEARCH_CONFIGS, value),
    )
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const query = (params.get("q") ?? "").trim()
  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ results: [] })
  }

  const limit = clampLimit(params.get("limit"))
  const entityTypes = parseEntityTypes(params.get("types"))
  const projectId = params.get("projectId")?.trim() || undefined
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0)

  try {
    const filters = projectId ? { projectId } : {}
    // A scoped (typed/project/paginated) request goes through searchEntities so
    // the filters apply; the default fast header search keeps using searchAll.
    const results =
      entityTypes.length > 0 || projectId || offset > 0
        ? await searchEntities(query, entityTypes, filters, {
            limit,
            offset,
            sortBy: "relevance",
            preferFast: offset === 0,
          })
        : await searchAll(query, {}, { limit, sortBy: "relevance", preferFast: true })
    return NextResponse.json({ results })
  } catch (error) {
    console.error("Command search request failed", error)
    return NextResponse.json({ results: [] }, { status: 200 })
  }
}
