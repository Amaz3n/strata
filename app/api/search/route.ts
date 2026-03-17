import { NextRequest, NextResponse } from "next/server"
import { searchAll } from "@/lib/services/search"

const MIN_QUERY_LENGTH = 2
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30

function clampLimit(raw: string | null) {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, parsed))
}

export async function GET(request: NextRequest) {
  const query = (request.nextUrl.searchParams.get("q") ?? "").trim()
  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ results: [] })
  }

  const limit = clampLimit(request.nextUrl.searchParams.get("limit"))

  try {
    const results = await searchAll(
      query,
      {},
      {
        limit,
        sortBy: "relevance",
        preferFast: true,
      },
    )
    return NextResponse.json({ results })
  } catch (error) {
    console.error("Command search request failed", error)
    return NextResponse.json({ results: [] }, { status: 200 })
  }
}
