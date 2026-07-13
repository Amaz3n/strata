"use client"

import { useTransition } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { uploadSubtierWaiverAction } from "./actions"

export function SubtierWaiversClient({ token, requirements }: { token: string; requirements: any[] }) {
  const [pending, startTransition] = useTransition()
  if (!requirements.length) return <div className="border border-dashed px-5 py-16 text-center"><p className="text-sm font-medium">No sub-tier waivers requested</p><p className="mt-1 text-xs text-muted-foreground">Requests from the GC will appear here by pay period and claimant.</p></div>
  return <div className="divide-y border">{requirements.map((requirement) => {
    const received = (requirement.waivers ?? []).some((waiver: any) => waiver.status === "signed")
    const commitment = Array.isArray(requirement.commitment) ? requirement.commitment[0] : requirement.commitment
    return <section key={requirement.id} className="p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold">{requirement.claimant_company_name}</p><p className="text-xs text-muted-foreground">{commitment?.title ?? "Commitment"} · period ending {requirement.period_end}</p></div><Badge variant={received ? "secondary" : "outline"}>{received ? "Received" : "Required"}</Badge></div>{received ? null : <form className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); startTransition(async () => { try { await uploadSubtierWaiverAction(token, form); toast.success("Sub-tier waiver uploaded"); location.reload() } catch (error) { toast.error(error instanceof Error ? error.message : "Upload failed") } }) }}><input type="hidden" name="requirement_id" value={requirement.id} /><input type="hidden" name="claimant_company_name" value={requirement.claimant_company_name} /><div><Label className="text-xs">Amount</Label><Input name="amount_dollars" type="number" min="0" step="0.01" defaultValue={(Number(requirement.amount_cents ?? 0) / 100).toFixed(2)} required /></div><div><Label className="text-xs">Waiver type</Label><Select name="waiver_type" defaultValue={requirement.waiver_type}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="conditional">Conditional</SelectItem><SelectItem value="unconditional">Unconditional</SelectItem><SelectItem value="final">Final</SelectItem></SelectContent></Select></div><div><Label className="text-xs">Through date</Label><Input name="through_date" type="date" defaultValue={requirement.period_end} required /></div><div><Label className="text-xs">Signed waiver</Label><Input name="file" type="file" accept="application/pdf,image/*" required /></div><div className="flex items-end"><Button type="submit" disabled={pending} className="w-full">Upload waiver</Button></div></form>}</section>
  })}</div>
}
