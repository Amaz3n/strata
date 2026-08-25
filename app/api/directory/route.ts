import { NextRequest, NextResponse } from "next/server"

import { logger } from "@/lib/logging/logger"
import {
  listDirectoryPage,
  type DirectorySortDirection,
  type DirectorySortKey,
} from "@/lib/services/directory"

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, maximum)
}

function resolveSort(value: string | null): DirectorySortKey {
  return value === "detail" || value === "recent" ? value : "name"
}

function resolveDirection(value: string | null): DirectorySortDirection {
  return value === "desc" ? "desc" : "asc"
}

/**
 * Cache-semantic read path for infinite scroll. First-page navigation remains a
 * direct RSC database read; the client uses this GET endpoint only for page 2+
 * so requests can be cancelled when filters change.
 */
export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams
  try {
    const result = await listDirectoryPage({
      kind: query.get("kind") === "contact" ? "contact" : "company",
      page: positiveInteger(query.get("page"), 1, 10_000),
      pageSize: positiveInteger(query.get("pageSize"), 25, 100),
      search: query.get("q")?.trim() || undefined,
      role: query.get("role") || undefined,
      trade: query.get("trade") || undefined,
      sort: resolveSort(query.get("sort")),
      direction: resolveDirection(query.get("direction")),
    })
    const page = {
      entries: result.entries,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    }

    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    logger.error("api.directory.list_failed", { route: "/api/directory", error })
    return NextResponse.json(
      { error: "Unable to load the directory." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    )
  }
}
