"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"
import { HelpCircle } from "lucide-react"
import { cn, formatLocalDate } from "@/lib/utils"

import type { Rfi, RfiResponse } from "@/lib/types"
import {
  addSubPortalRfiResponseAction,
  createSubPortalRfiAction,
  listSubPortalRfiResponsesAction,
} from "@/app/s/[token]/rfis/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface RfisPortalClientProps {
  rfis: Rfi[]
  token: string
}

const STATUS_CLASS: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/30",
  pending: "bg-primary/20 text-primary border-primary/30",
  answered: "bg-success/20 text-success border-success/30",
  closed: "bg-muted text-muted-foreground",
}

export function RfisPortalClient({ rfis, token }: RfisPortalClientProps) {
  const [items, setItems] = useState<Rfi[]>(rfis)
  const [selected, setSelected] = useState<Rfi | null>(null)
  const [responses, setResponses] = useState<RfiResponse[]>([])
  const [body, setBody] = useState("")
  const [subject, setSubject] = useState("")
  const [question, setQuestion] = useState("")
  const [isPending, startTransition] = useTransition()
  const [loadingThread, setLoadingThread] = useState(false)

  useEffect(() => {
    if (!selected) return
    setLoadingThread(true)
    listSubPortalRfiResponsesAction(token, selected.id)
      .then((rows) => setResponses(rows))
      .catch((err) => console.error("Failed to load RFI responses", err))
      .finally(() => setLoadingThread(false))
  }, [selected, token])

  const handleSend = () => {
    if (!selected || !body.trim()) return
    startTransition(async () => {
      try {
        await addSubPortalRfiResponseAction(token, {
          rfi_id: selected.id,
          response_type: "comment",
          body,
        })
        const rows = await listSubPortalRfiResponsesAction(token, selected.id)
        setResponses(rows)
        setBody("")
      } catch (error) {
        console.error("Failed to send message", error)
      }
    })
  }

  const handleCreateRfi = () => {
    if (!subject.trim() || !question.trim()) return
    startTransition(async () => {
      try {
        const created = await createSubPortalRfiAction(token, {
          subject: subject.trim(),
          question: question.trim(),
          priority: "normal",
        })
        setItems((prev) => [created, ...prev])
        setSubject("")
        setQuestion("")
      } catch (error) {
        console.error("Failed to create RFI", error)
      }
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ask a new question</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea placeholder="Subject" rows={1} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea placeholder="Question" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <div className="flex justify-end">
            <Button onClick={handleCreateRfi} disabled={isPending || !subject.trim() || !question.trim()}>
              Submit RFI
            </Button>
          </div>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <HelpCircle className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No RFIs assigned to you</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Requests for information appear here when the builder assigns them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((rfi) => (
            <Card key={rfi.id}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">RFI #{rfi.display_number ?? rfi.rfi_number}</CardTitle>
                <Badge variant="outline" className={cn("text-xs capitalize", STATUS_CLASS[rfi.status])}>
                  {rfi.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{rfi.subject}</p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{rfi.question}</p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  {rfi.due_date ? (
                    <p className="text-xs text-muted-foreground">
                      Due {formatLocalDate(rfi.due_date, "MMM d, yyyy")}
                    </p>
                  ) : (
                    <span />
                  )}
                  <Button variant="outline" size="sm" onClick={() => setSelected(rfi)}>
                    View &amp; respond
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selected ? `RFI #${selected.rfi_number}: ${selected.subject}` : "Messages"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">Question</p>
              <p className="text-sm text-muted-foreground">{selected?.question}</p>
            </div>
            <Separator />
            <div className="h-64 rounded-lg border">
              <ScrollArea className="h-full p-3">
                {loadingThread ? (
                  <div className="flex h-full items-center justify-center">
                    <Spinner className="h-4 w-4 text-muted-foreground" />
                  </div>
                ) : responses.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No responses yet.</p>
                ) : (
                  <div className="space-y-3">
                    {responses.map((response) => (
                      <div key={response.id} className="rounded-md border bg-card/50 p-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span className="capitalize">{response.response_type}</span>
                          <span>{format(new Date(response.created_at), "MMM d, h:mm a")}</span>
                        </div>
                        <p className="text-sm whitespace-pre-line">{response.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
            <div className="space-y-2">
              <Textarea
                placeholder="Type a message"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={isPending || loadingThread}
              />
              <div className="flex justify-end">
                <Button onClick={handleSend} disabled={isPending || loadingThread || !body.trim()}>
                  {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  Send response
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
