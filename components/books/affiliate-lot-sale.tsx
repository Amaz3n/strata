"use client"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { sellLotToAffiliateAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { parseMoneyToCents } from "@/lib/financials/money-input"

/**
 * The home's lot bought from the affiliated company that holds it: that company
 * records the sale, this home takes the lot in at the price, and group results
 * hold back the profit until the home sells.
 */
export function AffiliateLotSale({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ date: "", price: "", evidenceUrl: "" })
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => { const value = event.target.value; setForm(current => ({ ...current, [key]: value })) }
  return <details className="border p-3">
    <summary className="cursor-pointer text-sm font-medium">Lot bought from an affiliated company</summary>
    <p className="my-2 text-xs text-muted-foreground">Use when another of your companies holds this lot and sells it to this home. That company records the sale; group statements keep the lot at its cost until the home sells.</p>
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1"><Label htmlFor="affiliate-lot-date">Sale date</Label><Input id="affiliate-lot-date" type="date" value={form.date} onChange={set("date")} /></div>
      <div className="space-y-1"><Label htmlFor="affiliate-lot-price">Price</Label><Input id="affiliate-lot-price" inputMode="decimal" value={form.price} onChange={set("price")} /></div>
      <div className="space-y-1"><Label htmlFor="affiliate-lot-evidence">Sale agreement URL</Label><Input id="affiliate-lot-evidence" type="url" value={form.evidenceUrl} onChange={set("evidenceUrl")} /></div>
    </div>
    <Button className="mt-3" size="sm" disabled={pending || !form.date || !form.evidenceUrl} onClick={() => startTransition(async () => {
      const priceCents = parseMoneyToCents(form.price)
      if (priceCents === null || priceCents <= 0) { toast.error("Enter the sale price"); return }
      const result = await sellLotToAffiliateAction({ projectId, date: form.date, priceCents, evidenceUrl: form.evidenceUrl })
      if (!result.success) { toast.error(result.error); return }
      toast.success("Lot sale recorded for both companies"); router.refresh()
    })}>{pending ? "Recording…" : "Record lot sale"}</Button>
  </details>
}
