"use client"

import { useEffect, useState, useTransition } from "react"
import { format } from "date-fns"

import type { Rfi, RfiResponse } from "@/lib/types"
import {
  addBidPortalRfiResponseAction,
  createBidPortalRfiAction,
  listBidPortalRfiResponsesAction,
} from "@/app/b/[token]/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

interface BidRfisTabProps {
  token: string
  initialRfis: Rfi[]
}

export function BidRfisTab({ token, initialRfis }: BidRfisTabProps) {
  const [rfis, setRfis] = useState<Rfi[]>(initialRfis)
  const [selected, setSelected] = useState<Rfi | null>(null)
  const [responses, setResponses] = useState<RfiResponse[]>([])
  const [subject, setSubject] = useState("")
  const [question, setQuestion] = useState("")
  const [body, setBody] = useState("")
  const [loadingThread, setLoadingThread] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!selected) return
    setLoadingThread(true)
    listBidPortalRfiResponsesAction({ token, rfiId: selected.id })
      .then((rows) => setResponses(rows))
      .catch((err) => console.error("Failed to load RFI responses", err))
      .finally(() => setLoadingThread(false))
  }, [selected, token])

  const handleCreate = () => {
    if (!subject.trim() || !question.trim()) return
    startTransition(async () => {
      const result = await createBidPortalRfiAction({
        token,
        input: { subject: subject.trim(), question: question.trim(), priority: "normal" },
      })
      if (!result.success || !result.rfi) return
      setRfis((prev) => [result.rfi, ...prev])
      setSubject("")
      setQuestion("")
    })
  }

  const handleSend = () => {
    if (!selected || !body.trim()) return
    startTransition(async () => {
      const result = await addBidPortalRfiResponseAction({
        token,
        input: { rfi_id: selected.id, response_type: "comment", body },
      })
      if (!result.success) return
      const rows = await listBidPortalRfiResponsesAction({ token, rfiId: selected.id })
      setResponses(rows)
      setBody("")
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Submit Clarification (RFI)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} rows={1} />
          <Textarea placeholder="Question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} />
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={isPending || !subject.trim() || !question.trim()}>
              Submit RFI
            </Button>
          </div>
        </CardContent>
      </Card>

      {rfis.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">No RFIs yet.</CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rfis.map((rfi) => (
            <Card key={rfi.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">RFI #{rfi.rfi_number}</CardTitle>
                <Badge variant="secondary" className="capitalize text-[11px]">
                  {rfi.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-semibold">{rfi.subject}</p>
                <p className="text-sm text-muted-foreground">{rfi.question}</p>
                {rfi.due_date && (
                  <p className="text-xs text-muted-foreground">Due {format(new Date(rfi.due_date), "MMM d, yyyy")}</p>
                )}
                <Button variant="outline" size="sm" onClick={() => setSelected(rfi)}>
                  View responses
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected ? `RFI #${selected.rfi_number}: ${selected.subject}` : "Responses"}</DialogTitle>
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
              <Textarea placeholder="Type a response" value={body} onChange={(e) => setBody(e.target.value)} />
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
