import { NextResponse } from "next/server"

import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { requireOrgContext } from "@/lib/services/context"

export async function GET() {
  try {
    await requireOrgContext()
    const result = await getNextInvoiceNumber()
    return NextResponse.json(result)
  } catch (error: any) {
    console.error("Failed to fetch next invoice number", error)
    return NextResponse.json({ error: error?.message ?? "Unable to get next invoice number" }, { status: 500 })
  }
}
