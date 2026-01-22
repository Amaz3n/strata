"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, Eye, Edit, Copy, DollarSign } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { PlanCreateSheet } from "@/components/admin/plan-create-sheet"
import { createPlanAction } from "@/app/(app)/admin/plans/actions"

type StatusKey = "active" | "inactive"

const statusLabels: Record<StatusKey, string> = {
  active: "Active",
  inactive: "Inactive",
}

const statusStyles: Record<StatusKey, string> = {
  active: "bg-success/15 text-success border-success/30",
  inactive: "bg-muted text-muted-foreground border-muted",
}

interface Plan {
  code: string
  name: string
  pricingModel: string
  interval: string | null
  amountCents: number | null
  currency: string | null
  isActive: boolean
  createdAt: string
}

interface PlansClientProps {
  plans: Plan[]
}

export function PlansClient({ plans }: PlansClientProps) {
  const [items, setItems] = useState(plans)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [pricingFilter, setPricingFilter] = useState("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, startCreating] = useTransition()

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return items.filter((plan) => {
      const status = plan.isActive ? "active" : "inactive"
      const matchesStatus = statusFilter === "all" || status === statusFilter
      const matchesPricing = pricingFilter === "all" || plan.pricingModel === pricingFilter
      const haystack = [plan.name, plan.code].join(" ").toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesStatus && matchesPricing && matchesSearch
    })
  }, [items, statusFilter, pricingFilter, search])

  async function handleCreate(formData: FormData) {
    startCreating(async () => {
      try {
        const result = await createPlanAction({}, formData)

        if (result.error) {
          toast.error("Failed to create plan", { description: result.error })
        } else {
          toast.success("Plan created", { description: result.message })
          setCreateOpen(false)
          // Refresh the page to show the new plan
          window.location.reload()
        }
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to create plan", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-4">
      <PlanCreateSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
        loading={creating}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder="Search plans..."
            className="w-full sm:w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select value={pricingFilter} onValueChange={setPricingFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Pricing Model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All models</SelectItem>
              <SelectItem value="subscription">Subscription</SelectItem>
              <SelectItem value="license">License</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(["active", "inactive"] as StatusKey[]).map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabels[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New plan
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Code</TableHead>
              <TableHead className="px-4 py-4">Plan Name</TableHead>
              <TableHead className="px-4 py-4 text-center">Pricing Model</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="text-right px-4 py-4">Price</TableHead>
              <TableHead className="px-4 py-4 text-center">Created</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((plan) => {
              const statusKey = plan.isActive ? "active" : "inactive"
              return (
                <TableRow key={plan.code} className="divide-x">
                  <TableCell className="px-4 py-4">
                    <div className="font-mono text-sm font-semibold">{plan.code}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4">
                    <div className="font-semibold">{plan.name}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="outline" className="capitalize">
                      {plan.pricingModel}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="secondary" className={`border ${statusStyles[statusKey]}`}>
                      {statusLabels[statusKey]}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-right">
                    <div className="font-semibold">
                      {plan.amountCents && plan.amountCents > 0
                        ? formatCurrency(plan.amountCents, plan.currency || 'usd')
                        : 'Free'
                      }
                      {plan.interval && (
                        <span className="text-sm text-muted-foreground ml-1">/{plan.interval}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {format(new Date(plan.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="text-center w-12 px-4 py-4">
                    <div className="flex justify-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Plan actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>
                            <Eye className="mr-2 h-4 w-4" />
                            View details
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Edit className="mr-2 h-4 w-4" />
                            Edit plan
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Copy className="mr-2 h-4 w-4" />
                            Duplicate
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <DollarSign className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No plans yet</p>
                      <p className="text-sm">Create your first subscription plan to get started.</p>
                    </div>
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create plan
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function formatCurrency(cents: number, currency: string = 'usd') {
  const dollars = cents / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() })
}