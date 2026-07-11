"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"
import { HelpCircle } from "lucide-react"

import { formatLocalDate } from "@/lib/utils"
import type { Rfi, RfiResponse } from "@/lib/types"
import { addReviewerRfiResponseAction, listReviewerRfiResponsesAction } from "./actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface ReviewerRfisTabProps {
  rfis: Rfi[]
  token: string
  canRespond?: boolean
}

const statusColors: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/30",
  pending: "bg-blue-500/20 text-blue-500 border-blue-500/30",
  answered: "bg-success/20 text-success border-success/30",
  closed: "bg-muted text-muted-foreground",
}

export function ReviewerRfisTab({ rfis, token, canRespond = true }: ReviewerRfisTabProps) {
  const [items, setItems] = useState<Rfi[]>(rfis)
  const [selected, setSelected] = useState<Rfi | null>(null)
  const [responses, setResponses] = useState<RfiResponse[]>([])
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const [loadingThread, setLoadingThread] = useState(false)

  useEffect(() => {
    if (!selected) return
    setLoadingThread(true)
    listReviewerRfiResponsesAction(token, selected.id)
      .then((rows) => setResponses(rows))
      .catch((err) => console.error("Failed to load RFI responses", err))
      .finally(() => setLoadingThread(false))
  }, [selected, token])

  const handleSend = (responseType: "comment" | "answer") => {
    if (!selected || !body.trim()) return
    startTransition(async () => {
      try {
        await addReviewerRfiResponseAction(token, {
          rfi_id: selected.id,
          response_type: responseType,
          body,
        })
        const rows = await listReviewerRfiResponsesAction(token, selected.id)
        setResponses(rows)
        setBody("")
        if (responseType === "answer") {
          setItems((prev) =>
            prev.map((rfi) => (rfi.id === selected.id ? { ...rfi, status: "answered" } : rfi)),
          )
          setSelected((prev) => (prev ? { ...prev, status: "answered" } : prev))
        }
      } catch (error) {
        console.error("Failed to send response", error)
      }
    })
  }

  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <HelpCircle className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">No RFIs routed to you</p>
        <p className="text-sm text-muted-foreground">Requests for information will appear here when assigned</p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {items.map((rfi) => (
          <Card key={rfi.id}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">RFI #{rfi.rfi_number}</CardTitle>
              <Badge variant="outline" className={`capitalize text-xs ${statusColors[rfi.status] ?? ""}`}>
                {rfi.status}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{rfi.subject}</p>
                <p className="line-clamp-2 text-sm text-muted-foreground">{rfi.question}</p>
              </div>
              <div className="flex items-center justify-between">
                {rfi.due_date ? (
                  <p className="text-xs text-muted-foreground">Due {formatLocalDate(rfi.due_date, "MMM d, yyyy")}</p>
                ) : (
                  <span />
                )}
                <Button variant="outline" size="sm" onClick={() => setSelected(rfi)}>
                  {canRespond ? "View & Respond" : "View"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {selected ? `RFI #${selected.rfi_number}: ${selected.subject}` : "RFI Details"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-1 flex-col space-y-3 overflow-hidden">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-1 text-sm font-medium">Question</p>
              <p className="text-sm text-muted-foreground">{selected?.question}</p>
            </div>
            <Separator />
            <div className="min-h-0 flex-1 rounded-lg border">
              <ScrollArea className="h-full max-h-[200px] p-3">
                {loadingThread ? (
                  <div className="flex h-full items-center justify-center py-8">
                    <Spinner className="h-4 w-4 text-muted-foreground" />
                  </div>
                ) : responses.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No responses yet.</p>
                ) : (
                  <div className="space-y-3">
                    {responses.map((response) => (
                      <div key={response.id} className="rounded-md border bg-card/50 p-2">
                        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                          <span className="capitalize">
                            {response.responder_name ?? response.response_type}
                          </span>
                          <span>{format(new Date(response.created_at), "MMM d, h:mm a")}</span>
                        </div>
                        <p className="whitespace-pre-line text-sm">{response.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
            {canRespond ? (
              <div className="space-y-2">
                <Textarea
                  placeholder="Type your response..."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={isPending || loadingThread}
                  rows={3}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleSend("comment")}
                    disabled={isPending || loadingThread || !body.trim()}
                  >
                    Send comment
                  </Button>
                  <Button
                    onClick={() => handleSend("answer")}
                    disabled={isPending || loadingThread || !body.trim() || selected?.status === "closed"}
                  >
                    {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
                    Send as official answer
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
