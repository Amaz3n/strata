"use client"

import { useRef, useState, useTransition } from "react"
import { CheckSquare } from "lucide-react"
import type { PunchItem } from "@/lib/types"
import { completeSubPortalPunchItemAction } from "@/app/s/[token]/punch/actions"
import { formatLocalDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"

interface SubPunchTabProps {
  punchItems: PunchItem[]
  token: string
}

const statusColors: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/30",
  in_progress: "bg-blue-500/20 text-blue-500 border-blue-500/30",
  ready_for_review: "bg-success/20 text-success border-success/30",
}

const statusLabels: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  ready_for_review: "Awaiting review",
}

export function SubPunchTab({ punchItems, token }: SubPunchTabProps) {
  const [items, setItems] = useState<PunchItem[]>(punchItems)
  const [selected, setSelected] = useState<PunchItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const photoInputRef = useRef<HTMLInputElement>(null)

  const handleComplete = () => {
    if (!selected) return
    setError(null)
    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append("punch_item_id", selected.id)
        const photo = photoInputRef.current?.files?.[0]
        if (photo) formData.append("photo", photo)
        const updated = await completeSubPortalPunchItemAction(token, formData)
        setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
        setSelected(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not mark work complete")
      }
    })
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <CheckSquare className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">No punch items assigned to you</p>
        <p className="text-sm text-muted-foreground">
          Punch work will appear here when the builder assigns it to your company
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {items.map((item) => {
          const awaitingReview = item.status === "ready_for_review"
          return (
            <Card key={item.id}>
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-base">{item.title}</CardTitle>
                <Badge
                  variant="outline"
                  className={`text-xs ${statusColors[item.status] ?? "bg-muted text-muted-foreground"}`}
                >
                  {statusLabels[item.status] ?? item.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                {item.description ? (
                  <p className="text-sm text-muted-foreground whitespace-pre-line">{item.description}</p>
                ) : null}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {item.location ? <span>Location: {item.location}</span> : null}
                  {item.severity ? <span className="capitalize">Priority: {item.severity}</span> : null}
                  {item.due_date ? <span>Due {formatLocalDate(item.due_date, "MMM d, yyyy")}</span> : null}
                </div>
                <div className="flex items-center justify-between">
                  {awaitingReview ? (
                    <p className="text-xs text-muted-foreground">
                      Marked complete — waiting on builder verification
                    </p>
                  ) : (
                    <span />
                  )}
                  {!awaitingReview ? (
                    <Button variant="outline" size="sm" onClick={() => setSelected(item)}>
                      Mark work complete
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark work complete</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {selected?.title} — the builder will verify before closing this item.
            </p>
            <div className="space-y-2">
              <Label htmlFor="punch-completion-photo">Completion photo (optional)</Label>
              <Input id="punch-completion-photo" ref={photoInputRef} type="file" accept="image/*" />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSelected(null)} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={handleComplete} disabled={isPending}>
                {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
                Mark complete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
