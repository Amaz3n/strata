"use client"

import { useState } from "react"
import { format } from "date-fns"
import { formatLocalDate } from "@/lib/utils"

import type { Submittal } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"

interface SubmittalsPortalClientProps {
  submittals: Submittal[]
  token: string
}

export function SubmittalsPortalClient({ submittals, token }: SubmittalsPortalClientProps) {
  const [selected, setSelected] = useState<Submittal | null>(null)
  void token

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Submittals</p>
          <h1 className="text-2xl font-bold">Project submittals</h1>
          <p className="text-sm text-muted-foreground">Review materials and approvals.</p>
        </header>

        {submittals.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">No submittals yet.</CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {submittals.map((sub) => (
            <Card key={sub.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Submittal #{sub.submittal_number}</CardTitle>
                <Badge variant="secondary" className="capitalize text-[11px]">
                  {sub.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <p className="text-sm font-semibold">{sub.title}</p>
                  {sub.description && <p className="text-sm text-muted-foreground">{sub.description}</p>}
                  {sub.spec_section && (
                    <p className="text-xs text-muted-foreground">Spec: {sub.spec_section}</p>
                  )}
                  {sub.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Due {formatLocalDate(sub.due_date, "MMM d, yyyy")}
                    </p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelected(sub)}>
                  View details
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

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
