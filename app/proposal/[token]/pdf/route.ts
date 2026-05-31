import { NextResponse } from "next/server"

import { renderProposalPdfByToken } from "@/lib/services/proposal-documents"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const result = await renderProposalPdfByToken(token)

  if (!result) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${result.fileName}"`,
      "Cache-Control": "no-store",
    },
  })
}
