"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { submitRfqResponse } from "./actions"

export function RfqResponseForm({ token, status, initialAmount, initialNotes }: { token: string; status: string; initialAmount: number | null; initialNotes: string | null }) {
  const [amount, setAmount] = useState(initialAmount == null ? "" : String(initialAmount / 100))
  const [notes, setNotes] = useState(initialNotes ?? "")
  const [message, setMessage] = useState(status === "responded" || status === "declined" ? "Your response has been recorded." : "")
  const [pending, startTransition] = useTransition()
  const closed = Boolean(message)
  function submit(declined: boolean) { startTransition(async () => { const result = await submitRfqResponse(token, { amount_cents: Math.round(Number(amount || 0) * 100), notes, declined }); setMessage(result.success ? (declined ? "Decline recorded. Thank you." : "Pricing submitted. Thank you.") : result.error) }) }
  if (closed) return <p className="border bg-muted p-4 text-sm font-medium">{message}</p>
  return <div className="space-y-4"><div><Label>Price</Label><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></div><div><Label>Notes</Label><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></div><div className="flex gap-2"><Button disabled={pending || !Number.isFinite(Number(amount))} onClick={() => submit(false)}>Submit pricing</Button><Button disabled={pending} variant="outline" onClick={() => submit(true)}>Decline</Button></div>{message && <p className="text-sm text-destructive">{message}</p>}</div>
}
