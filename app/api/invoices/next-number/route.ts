import { NextRequest, NextResponse } from "next/server"
import { unstable_rethrow } from "next/navigation"

import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { z } from "zod"

export async function GET(request: NextRequest) {
  try {
    const projectId = request.nextUrl.searchParams.get("projectId")
    if (projectId && !z.string().uuid().safeParse(projectId).success) return NextResponse.json({ error: "Invalid project ID" }, { status: 400 })
    const result = await getNextInvoiceNumber(undefined, projectId)
    return NextResponse.json(result)
  } catch (error: any) {
    unstable_rethrow(error)
    console.error("Failed to fetch next invoice number", error)
    return NextResponse.json({ error: error?.message ?? "Unable to get next invoice number" }, { status: 500 })
  }
}
