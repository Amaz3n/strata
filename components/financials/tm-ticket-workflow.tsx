"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Clipboard, FileSignature, FileText, ReceiptText, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  createTmTicketAction,
  createTmTicketSignatureLinkAction,
  generateInvoiceFromTmTicketAction,
  submitTmTicketAction,
  voidTmTicketAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { TmTicket } from "@/lib/services/tm-tickets"

import { unwrapAction } from "@/lib/action-result"

type OpenCost = {
  id: string
  source_type: string
  occurred_on: string
  description?: string | null
  cost_code_code?: string | null
  cost_code_name?: string | null
  cost_cents?: number | null
  billable_cents?: number | null
  status?: string | null
  is_billable?: boolean | null
  queue_state?: string | null
  metadata?: Record<string, any> | null
}

export function TmTicketWorkflow({
  projectId,
  tickets,
  openCosts,
}: {
  projectId: string
  tickets: TmTicket[]
  openCosts: OpenCost[]
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [workDate, setWorkDate] = useState(today)
  const [selectedCostIds, setSelectedCostIds] = useState<string[]>([])
  const [notes, setNotes] = useState("")
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const eligibleCosts = useMemo(
    () =>
      openCosts.filter(
        (cost) =>
          cost.occurred_on === workDate &&
          cost.status === "open" &&
          cost.is_billable !== false &&
          ["time_entry", "project_expense", "project_expense_line"].includes(cost.source_type),
      ),
    [openCosts, workDate],
  )
  const selectedTotal = eligibleCosts
    .filter((cost) => selectedCostIds.includes(cost.id))
    .reduce((sum, cost) => sum + Number(cost.billable_cents ?? 0), 0)

  function setAllForDate(checked: boolean) {
    setSelectedCostIds(checked ? eligibleCosts.map((cost) => cost.id) : [])
  }

  function toggleCost(id: string, checked: boolean) {
    setSelectedCostIds((current) => checked ? Array.from(new Set([...current, id])) : current.filter((costId) => costId !== id))
  }

  function createTicket() {
    const ids = selectedCostIds.filter((id) => eligibleCosts.some((cost) => cost.id === id))
    startTransition(async () => {
      try {
        unwrapAction(await createTmTicketAction({
          projectId,
          workDate,
          billableCostIds: ids.length > 0 ? ids : undefined,
          notes: notes.trim() || null,
        }))
        setSelectedCostIds([])
        setNotes("")
        router.refresh()
        toast.success("T&M ticket created")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not create T&M ticket")
      }
    })
  }

  function runTicketAction(label: string, action: () => Promise<any>) {
    startTransition(async () => {
      try {
        await action()
        router.refresh()
        toast.success(label)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Action failed")
      }
    })
  }

  function createSignatureLink(ticketId: string) {
    startTransition(async () => {
      try {
        const link = unwrapAction(await createTmTicketSignatureLinkAction(projectId, ticketId))
        await navigator.clipboard?.writeText(link.url)
        router.refresh()
        toast.success("Signature link copied")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not create signature link")
      }
    })
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 lg:px-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ReceiptText className="h-4 w-4" />
            New ticket
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[180px_1fr_auto] md:items-end">
            <div className="space-y-2">
              <Label htmlFor="tm-ticket-date">Work date</Label>
              <Input
                id="tm-ticket-date"
                type="date"
                value={workDate}
                onChange={(event) => {
                  setWorkDate(event.target.value)
                  setSelectedCostIds([])
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tm-ticket-notes">Notes</Label>
              <Input id="tm-ticket-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
            <Button type="button" onClick={createTicket} disabled={isPending || eligibleCosts.length === 0}>
              <FileText className="h-4 w-4" />
              Create
            </Button>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all available costs"
                      checked={eligibleCosts.length > 0 && selectedCostIds.length === eligibleCosts.length}
                      onCheckedChange={(checked) => setAllForDate(Boolean(checked))}
                    />
                  </TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Billable</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eligibleCosts.map((cost) => (
                  <TableRow key={cost.id}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${cost.description ?? "cost"}`}
                        checked={selectedCostIds.includes(cost.id)}
                        onCheckedChange={(checked) => toggleCost(cost.id, Boolean(checked))}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{cost.description ?? "T&M cost"}</div>
                      {cost.metadata?.tm_ticket_number ? (
                        <div className="text-xs text-muted-foreground">Ticket {cost.metadata.tm_ticket_number}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>{sourceLabel(cost.source_type)}</TableCell>
                    <TableCell>{[cost.cost_code_code, cost.cost_code_name].filter(Boolean).join(" ") || "Uncoded"}</TableCell>
                    <TableCell className="text-right">{formatCurrency(cost.billable_cents)}</TableCell>
                  </TableRow>
                ))}
                {eligibleCosts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                      No open T&M costs for this date.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{eligibleCosts.length} available rows · {selectedCostIds.length} selected</span>
            <span className="font-medium">Selected {formatCurrency(selectedTotal || eligibleCosts.reduce((sum, cost) => sum + Number(cost.billable_cents ?? 0), 0))}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSignature className="h-4 w-4" />
            Tickets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Billable</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell>
                    <div className="font-medium">{ticket.ticket_number}</div>
                    <div className="text-xs text-muted-foreground">{ticket.work_date}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={ticket.status === "client_signed" ? "default" : ticket.status === "billed" ? "secondary" : "outline"}>
                      {ticket.status.replaceAll("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>{ticket.totals.item_count}</TableCell>
                  <TableCell className="text-right">{formatCurrency(ticket.totals.billable_cents)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {ticket.status === "draft" ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Submit ticket"
                          disabled={isPending}
                          onClick={() => runTicketAction("Ticket submitted", () => submitTmTicketAction(projectId, ticket.id).then(unwrapAction))}
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {["draft", "submitted"].includes(ticket.status) ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Copy signature link"
                          disabled={isPending}
                          onClick={() => createSignatureLink(ticket.id)}
                        >
                          <Clipboard className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {ticket.status === "client_signed" ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={isPending}
                          onClick={() => runTicketAction("Invoice created", () => generateInvoiceFromTmTicketAction(projectId, ticket.id).then(unwrapAction))}
                        >
                          Invoice
                        </Button>
                      ) : null}
                      {ticket.invoice_id ? (
                        <Button asChild type="button" size="sm" variant="outline">
                          <Link href={`/projects/${projectId}/financials/receivables?invoice=${ticket.invoice_id}`}>Open</Link>
                        </Button>
                      ) : null}
                      {!["billed", "voided"].includes(ticket.status) ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Void ticket"
                          disabled={isPending}
                          onClick={() => runTicketAction("Ticket voided", () => voidTmTicketAction(projectId, ticket.id).then(unwrapAction))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {tickets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                    No T&M tickets yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function sourceLabel(sourceType: string) {
  return sourceType.replaceAll("_", " ")
}

function formatCurrency(value?: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0) / 100)
}
