import { NextRequest, NextResponse } from "next/server"

import { getEntityPreview } from "@/lib/services/search-preview"
import { SEARCH_CONFIGS, type SearchEntityType } from "@/lib/services/search-config"

function isSearchEntityType(value: string): value is SearchEntityType {
  return Object.prototype.hasOwnProperty.call(SEARCH_CONFIGS, value)
}

export async function GET(request: NextRequest) {
  const type = (request.nextUrl.searchParams.get("type") ?? "").trim()
  const id = (request.nextUrl.searchParams.get("id") ?? "").trim()

  if (!type || !id || !isSearchEntityType(type)) {
    return NextResponse.json({ preview: null }, { status: 400 })
  }

  try {
    const preview = await getEntityPreview({ type, id })
    return NextResponse.json({ preview })
  } catch (error) {
    console.error("Entity preview request failed", error)
    return NextResponse.json({ preview: null }, { status: 200 })
  }
}
