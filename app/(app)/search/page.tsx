import Link from "next/link"
import { searchEntities } from "@/lib/services/search"
import { SEARCH_CONFIGS, type SearchEntityType } from "@/lib/services/search-config"

const PAGE_SIZE = 25

function formatType(type: string) {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function parseTypes(raw: string | undefined): SearchEntityType[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is SearchEntityType => Object.prototype.hasOwnProperty.call(SEARCH_CONFIGS, value))
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; types?: string; projectId?: string; offset?: string }>
}) {
  const params = await searchParams
  const query = (params.q ?? "").trim()
  const types = parseTypes(params.types)
  const projectId = params.projectId?.trim() || undefined
  const offset = Math.max(0, Number.parseInt(params.offset ?? "0", 10) || 0)

  const results =
    query.length >= 2
      ? await searchEntities(query, types, projectId ? { projectId } : {}, {
          limit: PAGE_SIZE,
          offset,
          sortBy: "relevance",
        })
      : []

  const buildHref = (nextOffset: number) => {
    const sp = new URLSearchParams()
    if (query) sp.set("q", query)
    if (params.types) sp.set("types", params.types)
    if (projectId) sp.set("projectId", projectId)
    if (nextOffset > 0) sp.set("offset", String(nextOffset))
    return `/search?${sp.toString()}`
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-4 text-lg font-medium text-foreground">
        {query ? `Search results for “${query}”` : "Search"}
      </h1>

      <form action="/search" method="get" className="mb-6">
        {params.types && <input type="hidden" name="types" value={params.types} />}
        {projectId && <input type="hidden" name="projectId" value={projectId} />}
        <input
          name="q"
          defaultValue={query}
          placeholder="Search records..."
          className="h-10 w-full rounded-none border border-border/80 bg-background px-3 text-sm outline-none focus:border-foreground/40"
        />
      </form>

      {query.length < 2 ? (
        <p className="text-sm text-muted-foreground">Enter at least 2 characters to search.</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records found.</p>
      ) : (
        <ul className="divide-y divide-border/40 border-y border-border/40">
          {results.map((result) => (
            <li key={`${result.type}-${result.id}`}>
              <Link href={result.href} className="flex items-center gap-3 px-1 py-3 transition-colors hover:bg-accent/40">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{result.title}</div>
                  {result.subtitle && <div className="truncate text-xs text-muted-foreground">{result.subtitle}</div>}
                </div>
                {result.project_name && (
                  <span className="hidden shrink-0 text-xs text-muted-foreground/60 sm:block">{result.project_name}</span>
                )}
                <span className="shrink-0 rounded-none border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {formatType(result.type)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {query.length >= 2 && (offset > 0 || results.length === PAGE_SIZE) && (
        <div className="mt-6 flex items-center justify-between">
          {offset > 0 ? (
            <Link href={buildHref(Math.max(0, offset - PAGE_SIZE))} className="text-sm text-muted-foreground hover:text-foreground">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {results.length === PAGE_SIZE ? (
            <Link href={buildHref(offset + PAGE_SIZE)} className="text-sm text-muted-foreground hover:text-foreground">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  )
}
