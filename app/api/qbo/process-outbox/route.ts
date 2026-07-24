import { NextRequest, NextResponse } from "next/server"

function redirectToAccountingRoute(request: NextRequest) {
  const url = new URL("/api/accounting/process-outbox", request.url)
  url.search = request.nextUrl.search
  return NextResponse.redirect(url, 307)
}

export const GET = redirectToAccountingRoute
export const POST = redirectToAccountingRoute
export const runtime = "nodejs"
