"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { SettingsGroup } from "@/components/settings/settings-section"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { unwrapAction } from "@/lib/action-result"
import { DELIVERY_REASON_LABELS, MILESTONE_KINDS, MILESTONE_KIND_LABELS } from "@/lib/sales/agreement-milestones"
import type { listMilestoneSources } from "@/lib/services/agreement-milestones"

import { createMilestoneSourceAction, disableMilestoneSourceAction, rotateMilestoneSourceSecretAction } from "./actions"

type Feeds = Awaited<ReturnType<typeof listMilestoneSources>>

const CONTAINER = "mx-auto w-full max-w-4xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"
const ENDPOINT = "/api/inbound/v1/agreement-milestones"
const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const REJECTION_LABELS: Record<string, string> = {
  missing_signature: "unsigned request",
  stale_timestamp: "timestamp too old",
  bad_signature: "wrong signature",
}

function kindLabel(value: unknown) {
  const kind = MILESTONE_KINDS.find((option) => option === value)
  return kind ? MILESTONE_KIND_LABELS[kind] : "—"
}

/**
 * The lenders and title companies that post milestone updates, each with its
 * own signing secret, and every signed delivery they sent with what Arc did
 * with it.
 */
export function MilestoneFeedsClient({ feeds }: { feeds: Feeds }) {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [secret, setSecret] = useState<{ name: string; publicId: string; value: string } | null>(null)
  const run = (work: () => Promise<void>) => startTransition(async () => {
    try {
      await work()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed")
    }
  })

  return (
    <div className={CONTAINER}>
      <SettingsGroup title="Feeds" description={`Each feed posts to ${ENDPOINT} with x-arc-source, x-arc-delivery, x-arc-timestamp and x-arc-signature (HMAC-SHA256 of "timestamp.body" with the feed's secret). Updates reconcile to the agreement number, the buyer's email and the lot; anything that does not match is refused and listed below.`}>
        <div className="flex gap-2">
          <Label htmlFor="feed-name" className="sr-only">Feed name</Label>
          <Input id="feed-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="First Coast Title" />
          <Button disabled={pending || !name.trim()} onClick={() => run(async () => {
            const created = unwrapAction(await createMilestoneSourceAction({ name }))
            setSecret({ name: created.source.name, publicId: created.source.public_id, value: created.secret })
            setName("")
          })}>Add feed</Button>
        </div>
        {feeds.sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No feeds yet. Milestones are updated by hand on each home&apos;s closing workbench until a lender or title company is connected.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="py-2 text-left font-medium">Feed</th>
                <th className="py-2 text-left font-medium">Source id</th>
                <th className="py-2 text-left font-medium">Last received</th>
                <th className="py-2 text-left font-medium">Rejected</th>
                <th className="py-2 text-right font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {feeds.sources.map((source) => (
                <tr key={source.id} className="border-b">
                  <td className="py-2">
                    <span className="font-medium">{source.name}</span>
                    {source.status === "disabled" ? <span className="ml-2 text-xs text-muted-foreground">Disabled</span> : null}
                    <span className="block text-xs text-muted-foreground">Secret ends {source.secret_hint}</span>
                  </td>
                  <td className="py-2 font-mono text-xs">{source.public_id}</td>
                  <td className="py-2 tabular-nums text-muted-foreground">{source.last_received_at ? when.format(new Date(source.last_received_at)) : "Never"}</td>
                  <td className="py-2 tabular-nums">
                    {source.rejected_count > 0 ? (
                      <span className="text-destructive">{source.rejected_count}{source.last_rejection_reason ? ` · ${REJECTION_LABELS[source.last_rejection_reason] ?? source.last_rejection_reason}` : ""}</span>
                    ) : <span className="text-muted-foreground">0</span>}
                  </td>
                  <td className="py-2 text-right">
                    {source.status === "active" ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(async () => {
                          const rotated = unwrapAction(await rotateMilestoneSourceSecretAction(source.id))
                          setSecret({ name: rotated.source.name, publicId: rotated.source.public_id, value: rotated.secret })
                        })}>Rotate secret</Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(async () => {
                          unwrapAction(await disableMilestoneSourceAction(source.id))
                          toast.success("Feed disabled")
                        })}>Disable</Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {feeds.sourcesTruncated ? <p className="text-xs text-muted-foreground">Showing the first 50 feeds.</p> : null}
      </SettingsGroup>

      <SettingsGroup title="Deliveries" description="Every signed update, newest first. Refused updates changed nothing.">
        {feeds.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No updates received yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="py-2 text-left font-medium">Received</th>
                <th className="py-2 text-left font-medium">Agreement</th>
                <th className="py-2 text-left font-medium">Milestone</th>
                <th className="py-2 text-left font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {feeds.deliveries.map((delivery) => (
                <tr key={delivery.id} className="border-b">
                  <td className="py-2 tabular-nums text-muted-foreground">{when.format(new Date(delivery.received_at))}</td>
                  <td className="py-2">
                    {typeof delivery.payload.agreement_number === "string" ? delivery.payload.agreement_number : "—"}
                    {delivery.project_id ? <a className="ml-2 text-xs underline" href={`/projects/${delivery.project_id}/closing#milestones`}>Open home</a> : null}
                  </td>
                  <td className="py-2">{kindLabel(delivery.payload.milestone)}</td>
                  <td className={`py-2 ${delivery.outcome === "refused" ? "text-destructive" : delivery.outcome === "applied" ? "text-success" : ""}`}>
                    {delivery.outcome === "refused" ? `Refused: ${DELIVERY_REASON_LABELS[delivery.reason_code ?? ""] ?? delivery.reason_code}` : delivery.outcome === "applied" ? "Applied" : "Reported, awaiting evidence or prerequisites"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {feeds.deliveriesTruncated ? <p className="text-xs text-muted-foreground">Showing the latest 100 deliveries.</p> : null}
      </SettingsGroup>

      <Dialog open={secret !== null} onOpenChange={(open) => { if (!open) setSecret(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Signing secret for {secret?.name}</DialogTitle>
            <DialogDescription>Copy it now; it is stored encrypted and never shown again. A rotated secret replaces the old one, which keeps working for 24 hours.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>Source id: <span className="font-mono">{secret?.publicId}</span></p>
            <Input readOnly value={secret?.value ?? ""} className="font-mono" onFocus={(event) => event.target.select()} aria-label="Signing secret" />
          </div>
          <DialogFooter>
            <Button onClick={() => {
              if (secret) void navigator.clipboard.writeText(secret.value).then(() => toast.success("Secret copied"))
            }}>Copy secret</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
