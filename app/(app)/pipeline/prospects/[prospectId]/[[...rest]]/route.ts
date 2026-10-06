import { NextRequest, NextResponse } from "next/server"

type Context = {
  params: Promise<{ prospectId: string; rest?: string[] }>
}

// Old opportunity URLs have no UI; forward them to the current deal workspace.
export async function GET(request: NextRequest, { params }: Context) {
  const { prospectId, rest = [] } = await params
  const query = request.nextUrl.searchParams
  const search = new URLSearchParams()
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key)
    if (values.length === 1 && key !== "tab" && key !== "prepare") {
      search.set(key, values[0])
    }
  }
  const suffix = search.size ? `?${search}` : ""
  const base = `/pipeline/${encodeURIComponent(prospectId)}`
  const [section, packageId] = rest
  let destination = base
  if (section === "drawings") destination = `${base}/plans${suffix}`
  else if (section === "documents") destination = `${base}/files${suffix}`
  else if (section === "bids" && packageId) destination = `${base}/quotes/${encodeURIComponent(packageId)}`
  else if (search.get("row")) destination = `${base}?row=${encodeURIComponent(search.get("row")!)}`

  // A relative Location preserves the browser's host, including local aliases
  // and reverse-proxy domains, instead of using the server's internal origin.
  return new NextResponse(null, {
    status: 307,
    headers: { Location: destination, "Cache-Control": "private, no-store" },
  })
}
