import { NextRequest, NextResponse } from "next/server"

import { releaseInvoiceNumberReservation } from "@/lib/services/invoice-numbers"
import { requireOrgContext } from "@/lib/services/context"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const reservationId = body?.reservation_id as string | undefined

    if (!reservationId) {
      return NextResponse.json({ error: "reservation_id required" }, { status: 400 })
    }

    const { orgId } = await requireOrgContext()
    await releaseInvoiceNumberReservation(reservationId, orgId)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("Failed to release reservation", error)
    return NextResponse.json({ error: error?.message ?? "Unable to release reservation" }, { status: 500 })
  }
}
