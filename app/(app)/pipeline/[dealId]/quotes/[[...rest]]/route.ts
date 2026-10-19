import { NextRequest, NextResponse } from "next/server"

type Context = {
  params: Promise<{ dealId: string; rest?: string[] }>
}

// The Quotes tab is Bids now; links already sent in emails and from plans land there.
export async function GET(_request: NextRequest, { params }: Context) {
  const { dealId, rest = [] } = await params
  const [packageId] = rest
  const base = `/pipeline/${encodeURIComponent(dealId)}/bids`
  return new NextResponse(null, {
    status: 307,
    headers: {
      Location: packageId ? `${base}/${encodeURIComponent(packageId)}` : base,
      "Cache-Control": "private, no-store",
    },
  })
}
