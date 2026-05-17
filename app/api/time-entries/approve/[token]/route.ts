import { NextResponse } from "next/server"

import { approveTimeEntryByToken } from "@/lib/services/cost-plus"

interface Params {
  params: Promise<{ token: string }>
}

export async function GET(_request: Request, { params }: Params) {
  const { token } = await params
  try {
    const entry = await approveTimeEntryByToken(token)
    return new NextResponse(
      `<!doctype html>
      <html>
        <head><title>Time approved</title><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
        <body style="font-family: system-ui, sans-serif; padding: 32px; line-height: 1.5;">
          <h1>Time entry approved</h1>
          <p>Thanks. ${entry.worker_name ? `${entry.worker_name}'s ` : "This "}time entry is approved for billing.</p>
        </body>
      </html>`,
      { headers: { "content-type": "text/html" } },
    )
  } catch (error) {
    return new NextResponse(
      `<!doctype html>
      <html>
        <head><title>Approval unavailable</title><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
        <body style="font-family: system-ui, sans-serif; padding: 32px; line-height: 1.5;">
          <h1>Approval unavailable</h1>
          <p>${error instanceof Error ? error.message : "This approval link cannot be used."}</p>
        </body>
      </html>`,
      { status: 400, headers: { "content-type": "text/html" } },
    )
  }
}

export async function POST(request: Request, context: Params) {
  const response = await GET(request, context)
  if (response.status >= 400) {
    return NextResponse.json({ ok: false }, { status: response.status })
  }
  return NextResponse.json({ ok: true })
}
