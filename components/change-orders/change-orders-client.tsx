"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder, Project } from "@/lib/types"
import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import { createChangeOrderAction, publishChangeOrderAction } from "@/app/change-orders/actions"
import { ChangeOrderForm } from "@/components/change-orders/change-order-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Share2, BadgeCheck, Clock, Building2 } from "@/components/icons"

type StatusKey = "draft" | "pending" | "sent" | "approved" | "requested_changes" | "cancelled"

const statusLabels: Record<StatusKey, string> = {
  draft: "Draft",
  pending: "Pending client",
  sent: "Sent",
  approved: "Approved",
  requested_changes: "Needs changes",
  cancelled: "Cancelled",
}

const statusStyles: Record<StatusKey, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  pending: "bg-warning/20 text-warning border-warning/40",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  approved: "bg-success/20 text-success border-success/30",
  requested_changes: "bg-amber-100 text-amber-800 border-amber-200",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

function formatMoneyFromCents(cents?: number | null) {
  const value = cents ?? 0
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function resolveStatusKey(status?: string | null): StatusKey {
  if (!status) return "draft"
  const allowed: StatusKey[] = ["draft", "pending", "sent", "approved", "requested_changes", "cancelled"]
  return allowed.includes(status as StatusKey) ? (status as StatusKey) : "draft"
}

interface ChangeOrdersClientProps {
  changeOrders: ChangeOrder[]
  projects: Project[]
}

export function ChangeOrdersClient({ changeOrders, projects }: ChangeOrdersClientProps) {
  const [items, setItems] = useState<ChangeOrder[]>(changeOrders)
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
      clientVisible: items.filter((co) => co.client_visible).length,
      pending: items.filter((co) => co.status === "pending").length,
    }
  }, [items])

  async function handleCreate(values: ChangeOrderInput, published: boolean) {
    startTransition(async () => {
      try {
        const created = await createChangeOrderAction(values)
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success(published ? "Sent to client" : "Draft saved", {
          description: published ? "Client can now view and approve." : "You can publish when ready.",
        })
      } catch (error: any) {
        console.error(error)
        toast.error("Could not save change order", { description: error?.message ?? "Please try again." })
      }
    })
  }

  async function handlePublish(changeOrderId: string) {
    startTransition(async () => {
      try {
        const updated = await publishChangeOrderAction(changeOrderId)
        setItems((prev) => prev.map((co) => (co.id === updated.id ? updated : co)))
        toast.success("Published to client")
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to publish", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Change Orders</h1>
          <p className="text-muted-foreground text-sm">
            Create, price, and publish change orders with taxes, markup, and allowances.
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge variant="secondary" className="text-xs">
              Total {stats.total}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Client visible {stats.clientVisible}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Pending {stats.pending}
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
            New change order
          </Button>
        </div>
      </div>

      <ChangeOrderForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((changeOrder) => (
          <Card key={changeOrder.id} className="h-full flex flex-col">
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base font-semibold">{changeOrder.title}</CardTitle>
                <Badge variant="secondary" className={`capitalize border ${statusStyles[resolveStatusKey(changeOrder.status)]}`}>
                  {statusLabels[resolveStatusKey(changeOrder.status)] ?? changeOrder.status}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Building2 className="h-4 w-4" />
                  {projects.find((p) => p.id === changeOrder.project_id)?.name ?? "Unknown project"}
                </span>
                {changeOrder.days_impact != null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    {changeOrder.days_impact} day impact
                  </span>
                )}
                {changeOrder.client_visible && (
                  <span className="flex items-center gap-1 text-primary">
                    <Share2 className="h-4 w-4" />
                    Client can view
                  </span>
                )}
              </div>
            </CardHeader>

            <CardContent className="flex-1 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">Total</div>
                <div className="text-xl font-bold">
                  {formatMoneyFromCents(changeOrder.total_cents ?? changeOrder.totals?.total_cents)}
                </div>
              </div>

              {changeOrder.summary && <p className="text-sm text-muted-foreground">{changeOrder.summary}</p>}

              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium">
                    {formatMoneyFromCents(changeOrder.totals?.subtotal_cents ?? changeOrder.total_cents)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Markup</span>
                  <span className="font-medium">{formatMoneyFromCents(changeOrder.totals?.markup_cents)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="font-medium">{formatMoneyFromCents(changeOrder.totals?.tax_cents)}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Allowances</span>
                  <span className="font-medium">{formatMoneyFromCents(changeOrder.totals?.allowance_cents)}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="text-xs">
                  {changeOrder.lines?.length ?? 0} line items
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Tax {changeOrder.totals?.tax_rate ?? changeOrder.metadata?.tax_rate ?? 0}%
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Markup {changeOrder.totals?.markup_percent ?? changeOrder.metadata?.markup_percent ?? 0}%
                </Badge>
                {changeOrder.created_at && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(new Date(changeOrder.created_at), "MMM d, yyyy")}
                  </span>
                )}
              </div>

              {!changeOrder.client_visible && (
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={isPending}
                    onClick={() => handlePublish(changeOrder.id)}
                  >
                    <Share2 className="h-4 w-4 mr-2" />
                    Publish
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    disabled
                    title="Role-based editing will be added later."
                  >
                    <BadgeCheck className="h-4 w-4 mr-2" />
                    Edit
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">No change orders yet.</p>
            <Button className="mt-3" onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first change order
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



