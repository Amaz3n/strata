"use client"

import { useState } from "react"
import { format } from "date-fns"
import { formatLocalDate } from "@/lib/utils"
import { Package } from "lucide-react"
import type { Submittal } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface SubSubmittalsTabProps {
  submittals: Submittal[]
  token: string
}

const statusColors: Record<string, string> = {
  pending: "bg-warning/20 text-warning border-warning/30",
  in_review: "bg-blue-500/20 text-blue-500 border-blue-500/30",
  approved: "bg-success/20 text-success border-success/30",
  approved_as_noted: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/20 text-destructive border-destructive/30",
  resubmit: "bg-orange-500/20 text-orange-500 border-orange-500/30",
}

export function SubSubmittalsTab({ submittals, token }: SubSubmittalsTabProps) {
  const [selected, setSelected] = useState<Submittal | null>(null)
  void token

  if (submittals.length === 0) {
    return (
      <div className="text-center py-12">
        <Package className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">No submittals assigned to you</p>
        <p className="text-sm text-muted-foreground">
          Material and product submittals will appear here when assigned
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {submittals.map((sub) => (
          <Card key={sub.id}>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-base">
                Submittal #{sub.submittal_number}
              </CardTitle>
              <Badge
                variant="outline"
                className={`capitalize text-xs ${statusColors[sub.status] ?? ""}`}
              >
                {sub.status.replaceAll("_", " ")}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{sub.title}</p>
                {sub.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {sub.description}
                  </p>
                )}
                {sub.spec_section && (
                  <p className="text-xs text-muted-foreground">
                    Spec: {sub.spec_section}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between">
                {sub.due_date && (
                  <p className="text-xs text-muted-foreground">
                    Due {formatLocalDate(sub.due_date, "MMM d, yyyy")}
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(sub)}
                >
                  View Details
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => (open ? null : setSelected(null))}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {selected
                ? `Submittal #${selected.submittal_number}: ${selected.title}`
                : "Submittal Details"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 flex-1 overflow-hidden flex flex-col">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <div>
                <p className="text-sm font-medium mb-1">Description</p>
                <p className="text-sm text-muted-foreground">
                  {selected?.description ?? "No description provided."}
                </p>
              </div>
              {selected?.spec_section && (
                <div>
                  <p className="text-xs text-muted-foreground">
                    Spec Section: {selected.spec_section}
                  </p>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
