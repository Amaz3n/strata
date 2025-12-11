import { NextResponse } from "next/server"

import { acknowledgeVarianceAlert } from "@/lib/services/budgets"

export async function POST(request: Request) {
  try {
    const { id, status } = await request.json()
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 })
    }

    const result = await acknowledgeVarianceAlert(id, status === "resolved" ? "resolved" : "acknowledged")
    return NextResponse.json({ ok: true, alert: result })
  } catch (error: any) {
    console.error(error)
    return NextResponse.json({ error: error?.message ?? "Failed to acknowledge alert" }, { status: 500 })
  }
}

