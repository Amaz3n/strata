"use client"

import { useState } from "react"
import { Package } from "lucide-react"
import { cn, formatLocalDate } from "@/lib/utils"

import type { Submittal } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { SubmitPackageDialog } from "./submit-package-dialog"

interface SubmittalsPortalClientProps {
  submittals: Submittal[]
  token: string
}

const OPEN_FOR_SUBMISSION = new Set(["draft", "pending", "submitted", "in_review", "revise_resubmit"])

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-warning/20 text-warning border-warning/30",
  in_review: "bg-primary/20 text-primary border-primary/30",
  approved: "bg-success/20 text-success border-success/30",
  approved_as_noted: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/20 text-destructive border-destructive/30",
  resubmit: "bg-warning/20 text-warning border-warning/30",
}

export function SubmittalsPortalClient({ submittals, token }: SubmittalsPortalClientProps) {
  const [selected, setSelected] = useState<Submittal | null>(null)
  const [submitFor, setSubmitFor] = useState<Submittal | null>(null)

  return (
    <div className="space-y-3">
      {submittals.length === 0 ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <Package className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No submittals assigned to you</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Material and product submittals appear here when the builder assigns them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {submittals.map((sub) => (
            <Card key={sub.id}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">Submittal #{sub.submittal_number}</CardTitle>
                <Badge variant="outline" className={cn("text-xs capitalize", STATUS_CLASS[sub.status])}>
                  {sub.status.replaceAll("_", " ")}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{sub.title}</p>
                  {sub.description && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{sub.description}</p>
                  )}
                  {sub.spec_section && (
                    <p className="text-xs text-muted-foreground">Spec: {sub.spec_section}</p>
                  )}
                </div>

                {sub.decision_status && (
                  <div className="space-y-1 border border-border bg-muted/30 p-2">
                    <p className="text-xs">
                      Returned:{" "}
                      <span className="font-medium capitalize">
                        {sub.decision_status.replaceAll("_", " ")}
                      </span>
                    </p>
                    {sub.decision_note && (
                      <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                        {sub.decision_note}
                      </p>
                    )}
                    {sub.stamped_file_id && (
                      <a
                        className="text-xs font-medium text-primary underline underline-offset-2"
                        href={`/api/portal/files/${token}/${sub.stamped_file_id}?download=1`}
                      >
                        Download stamped copy
                      </a>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  {sub.due_date ? (
                    <p className="text-xs text-muted-foreground">
                      Due {formatLocalDate(sub.due_date, "MMM d, yyyy")}
                    </p>
                  ) : (
                    <span />
                  )}
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setSelected(sub)}>
                      View details
                    </Button>
                    {OPEN_FOR_SUBMISSION.has(sub.status) && !sub.superseded_by_id && (
                      <Button size="sm" onClick={() => setSubmitFor(sub)}>
                        Submit documents
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SubmitPackageDialog
        token={token}
        submittal={submitFor}
        open={!!submitFor}
        onOpenChange={(open) => (open ? null : setSubmitFor(null))}
      />

      <Dialog open={!!selected} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selected ? `Submittal #${selected.submittal_number}: ${selected.title}` : "Submittal Details"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Description</p>
              <p className="text-sm text-muted-foreground">
                {selected?.description ?? "No description provided."}
              </p>
            </div>
            <Separator />
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-sm">
              {selected?.spec_section && (
                <p>
                  <span className="font-medium">Spec section:</span> {selected.spec_section}
                </p>
              )}
              {selected?.due_date && (
                <p>
                  <span className="font-medium">Due:</span> {formatLocalDate(selected.due_date, "MMM d, yyyy")}
                </p>
              )}
              <p>
                <span className="font-medium">Status:</span>{" "}
                <span className="capitalize">{selected?.status.replaceAll("_", " ")}</span>
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
