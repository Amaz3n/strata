import { NextResponse } from "next/server"

import { receivePlaidWebhook } from "@/lib/services/books/bank-feeds"

export async function POST(request: Request) {
  const rawBody = await request.text()
  const result = await receivePlaidWebhook(rawBody, request.headers.get("plaid-verification"))
  if (!result) return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  return NextResponse.json({ received: true })
}

