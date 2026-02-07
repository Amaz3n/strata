"use client"

import { format } from "date-fns"

import type { ChangeOrder } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface Props {
  changeOrder: ChangeOrder & { requires_signature?: boolean | null }
  continueSigningUrl?: string | null
}

export function ChangeOrderApprovalClient({ changeOrder, continueSigningUrl }: Props) {
  const formatMoney = (cents?: number | null) => `$${((cents ?? 0) / 100).toLocaleString()}`

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="text-center space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Change Order</p>
          <h1 className="text-2xl font-bold">{changeOrder.title}</h1>
          <div className="flex justify-center gap-2">
            <Badge variant="secondary" className="capitalize">{changeOrder.status}</Badge>
            {changeOrder.days_impact != null && (
              <Badge variant="outline">Schedule impact: {changeOrder.days_impact} days</Badge>
            )}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {changeOrder.summary ? <p>{changeOrder.summary}</p> : <p>No summary provided.</p>}
            {changeOrder.description && <p className="whitespace-pre-line">{changeOrder.description}</p>}
            {changeOrder.total_cents != null && (
              <p className="text-lg font-semibold text-foreground">
                Total: {formatMoney(changeOrder.total_cents)}
              </p>
            )}
            {changeOrder.approved_at ? (
              <p className="text-xs text-muted-foreground">
                Approved on {format(new Date(changeOrder.approved_at), "MMM d, yyyy")}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approval & Signature</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Change order approvals now run through Arc's secure document-signing flow.
            </p>

            {changeOrder.status === "approved" ? (
              <div className="rounded-md border bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
                This change order is already approved.
              </div>
            ) : continueSigningUrl ? (
              <Button className="w-full" asChild>
                <a href={continueSigningUrl}>Continue to secure signing</a>
              </Button>
            ) : (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                The signing link is not active yet. Please use the latest email from your builder.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
