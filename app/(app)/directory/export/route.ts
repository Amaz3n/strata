import { NextRequest, NextResponse } from "next/server"

import type { PartyKind } from "@/lib/directory/roles"
import { toCsv, type CsvColumn } from "@/lib/services/reports/csv"
import {
  listDirectoryPage,
  type DirectoryEntry,
  type DirectorySortDirection,
  type DirectorySortKey,
} from "@/lib/services/directory"

/**
 * The directory as a spreadsheet.
 *
 * Exporting the directory has been on the "sweep and fill" list since the
 * commercial expansion and never shipped, which meant the one list a builder is
 * most often asked to hand over — every sub, with contacts and roles — could
 * only leave Arc by copy-paste.
 *
 * Exports what the filters currently select, so the file matches the screen the
 * user is looking at rather than being a second, differently-scoped thing.
 * `listDirectoryPage` enforces org scope and the read permission.
 */

const PAGE_SIZE = 200
// Ten pages. High enough for a real vendor list, bounded so one request cannot
// stream an unbounded org into memory; the response says when it stopped.
const MAX_PAGES = 10

const COLUMNS: CsvColumn<DirectoryEntry & { roles_text: string }>[] = [
  { key: "kind", header: "Type" },
  { key: "name", header: "Name" },
  { key: "roles_text", header: "Roles" },
  { key: "detail", header: "Trade / Title" },
  { key: "email", header: "Email" },
  { key: "phone", header: "Phone" },
  { key: "primary_company_name", header: "Company" },
  {
    key: "created_at",
    header: "Added",
    format: (value) => (value ? new Date(String(value)).toISOString().slice(0, 10) : ""),
  },
]

function resolveKind(value: string | null): PartyKind {
  return value === "contact" ? "contact" : "company"
}

function resolveSort(value: string | null): DirectorySortKey {
  return value === "detail" || value === "recent" ? value : "name"
}

function resolveDirection(value: string | null): DirectorySortDirection {
  return value === "desc" ? "desc" : "asc"
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const kind = resolveKind(params.get("kind"))
    const input = {
      kind,
      pageSize: PAGE_SIZE,
      search: params.get("q")?.trim() ?? "",
      role: params.get("role") ?? "all",
      trade: params.get("trade") ?? "all",
      sort: resolveSort(params.get("sort")),
      direction: resolveDirection(params.get("direction")),
    }

    const entries: DirectoryEntry[] = []
    let total = 0
    let page = 1
    for (; page <= MAX_PAGES; page += 1) {
      const result = await listDirectoryPage({ ...input, page })
      total = result.total
      entries.push(...result.entries)
      if (entries.length >= result.total || result.entries.length === 0) break
    }

    const rows = entries.map((entry) => ({
      ...entry,
      // Roles are the point of the export: "who is this to us" is exactly what
      // the type column could never say.
      roles_text: entry.roles.map((role) => `${role.label} (${role.status})`).join("; "),
    }))

    const csv = toCsv(rows, COLUMNS)
    const truncated = entries.length < total
    const stamp = new Date().toISOString().slice(0, 10)
    const fileName = `directory-${kind === "company" ? "companies" : "contacts"}-${stamp}.csv`

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        // A silently short file reads as a complete one, so the cap is stated
        // where a script can see it too.
        "X-Directory-Export-Total": String(total),
        "X-Directory-Export-Truncated": String(truncated),
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed" },
      { status: 400 },
    )
  }
}
