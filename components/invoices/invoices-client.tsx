"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Invoice, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import { createInvoiceAction } from "@/app/invoices/actions"
import { InvoiceForm } from "@/components/invoices/invoice-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Calendar, DollarSign, Building2 } from "@/components/icons"

type StatusKey = "draft" | "sent" | "paid" | "overdue" | "void"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  paid: "bg-success/20 text-success border-success/30",
  overdue: "bg-destructive/20 text-destructive border-destructive/30",
  void: "bg-muted text-muted-foreground border-muted",
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function resolveStatusKey(status?: string | null): StatusKey {
  if (!status) return "draft"
  const allowed: StatusKey[] = ["draft", "sent", "paid", "overdue", "void"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
}

interface InvoicesClientProps {
  invoices: Invoice[]
  projects: Project[]
}

export function InvoicesClient({ invoices, projects }: InvoicesClientProps) {
  const [items, setItems] = useState<Invoice[]>(invoices)
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    if (filterProjectId === "all") return items
    return items.filter((item) => item.project_id === filterProjectId)
  }, [filterProjectId, items])

  const stats = useMemo(() => {
    return {
      total: items.length,
      outstanding: items.filter((inv) => inv.status === "sent" || inv.status === "overdue").length,
      paid: items.filter((inv) => inv.status === "paid").length,
    }
  }, [items])

  async function handleCreate(values: InvoiceInput, sendToClient: boolean) {
    startTransition(async () => {
      try {
        const created = await createInvoiceAction(values)
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success(sendToClient ? "Invoice sent" : "Draft saved", {
          description: sendToClient ? "Client can now view this invoice." : "You can send when ready.",
        })
      } catch (error: any) {
        console.error(error)
        toast.error("Could not save invoice", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Invoices</h1>
          <p className="text-muted-foreground text-sm">Progress and final invoices with client visibility.</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge variant="secondary" className="text-xs">
              Total {stats.total}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Outstanding {stats.outstanding}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Paid {stats.paid}
            </Badge>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={filterProjectId} onValueChange={setFilterProjectId}>
            <SelectTrigger className="w-full sm:w-[220px]">
              <SelectValue placeholder="Filter by project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            New invoice
          </Button>
        </div>
      </div>

      <InvoiceForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((invoice) => (
          <Card key={invoice.id} className="h-full flex flex-col">
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base font-semibold">
                  {invoice.invoice_number} — {invoice.title}
                </CardTitle>
                <Badge
                  variant="secondary"
                  className={`capitalize border ${statusStyles[resolveStatusKey(invoice.status)]}`}
                >
                  {statusLabels[resolveStatusKey(invoice.status)]}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Building2 className="h-4 w-4" />
                  {projects.find((p) => p.id === invoice.project_id)?.name ?? "Unknown project"}
                </span>
                {invoice.due_date && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-4 w-4" />
                    Due {format(new Date(invoice.due_date), "MMM d, yyyy")}
                  </span>
                )}
                {invoice.client_visible && (
                  <Badge variant="outline" className="text-[11px]">
                    Client can view
                  </Badge>
                )}
              </div>
            </CardHeader>

            <CardContent className="flex-1 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">Total</div>
                <div className="text-xl font-bold">{formatMoneyFromCents(invoice.total_cents ?? invoice.totals?.total_cents)}</div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium">
                    {formatMoneyFromCents(invoice.totals?.subtotal_cents ?? invoice.subtotal_cents)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="font-medium">{formatMoneyFromCents(invoice.totals?.tax_cents ?? invoice.tax_cents)}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Balance due</span>
                  <span className="font-medium">
                    {formatMoneyFromCents(invoice.balance_due_cents ?? invoice.totals?.balance_due_cents)}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="text-xs">
                  {invoice.lines?.length ?? 0} line items
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Tax {invoice.totals?.tax_rate ?? invoice.metadata?.tax_rate ?? 0}%
                </Badge>
                {invoice.issue_date && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Issued {format(new Date(invoice.issue_date), "MMM d, yyyy")}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
            <Button className="mt-3" onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first invoice
            </Button>
          </div>
        )}

        {isPending && filtered.length === 0 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...Array(3)].map((_, idx) => (
              <Skeleton key={idx} className="h-44 w-full rounded-lg" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
