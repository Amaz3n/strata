import { NextResponse } from "next/server"

import { renderEstimatePdfByToken } from "@/lib/services/estimate-portal"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const result = await renderEstimatePdfByToken(token)

  if (!result) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${result.fileName}"`,
      "Cache-Control": "no-store",
    },
  })
}
