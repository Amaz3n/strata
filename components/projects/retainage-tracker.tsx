"use client"

import { useState } from "react"
import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ExternalLink, ReceiptText, Settings } from "lucide-react"
import type { Retainage } from "@/lib/types"
import { cn } from "@/lib/utils"
import { ReleaseRetainageSheet } from "./release-retainage-sheet"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateProjectSettingsAction } from "@/app/(app)/projects/[id]/actions"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

interface RetainageTrackerProps {
  projectId: string
  project?: any // Optional project for settings
  retainage: Retainage[]
  compact?: boolean
}

const statusMap: Record<string, { label: string; tone: string }> = {
  held: { label: "Held", tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  released: { label: "Released", tone: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  invoiced: { label: "Invoiced", tone: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  paid: { label: "Paid", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
}

export function RetainageTracker({ projectId, project, retainage, compact = false }: RetainageTrackerProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [releaseOpen, setReleaseOpen] = useState(false)
  
  // Local state for the settings popover
  const [retainageInput, setRetainageInput] = useState(String(project?.retainage_percent ?? "0"))
  const [valueInput, setValueInput] = useState(project?.total_contract_value_cents ? String(project.total_contract_value_cents / 100) : "")

  const handleUpdateSettings = () => {
    startTransition(async () => {
      try {
        await updateProjectSettingsAction(projectId, {
          retainage_percent: Number.parseFloat(retainageInput) || 0,
          total_contract_value_cents: valueInput ? Math.round(Number.parseFloat(valueInput) * 100) : null,
        })
        toast.success("Retainage settings updated")
        router.refresh()
      } catch (error) {
        toast.error("Failed to update settings")
      }
    })
  }
  
  const totalHeld = retainage.reduce((sum, r) => sum + (r.status === "held" ? r.amount_cents : 0), 0)
  const totalReleased = retainage.reduce((sum, r) => sum + (r.status === "released" || r.status === "paid" || r.status === "invoiced" ? r.amount_cents : 0), 0)
  const totalPool = totalHeld + totalReleased
  const percentReleased = totalPool > 0 ? Math.round((totalReleased / totalPool) * 100) : 0

  if (compact) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Retainage</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {!retainage.length ? (
            <p className="text-xs text-muted-foreground">No retainage held.</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs">
                <div className="text-muted-foreground">Released</div>
                <div className="font-semibold">{percentReleased}%</div>
              </div>
              <Progress value={percentReleased} className="h-1.5" />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Held</div>
                  <div className="font-medium">{formatCurrency(totalHeld)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Released</div>
                  <div className="font-medium">{formatCurrency(totalReleased)}</div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Hero Summary */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Project Retainage Pool</h3>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold tracking-tight">{formatCurrency(totalHeld)}</span>
              <span className="text-sm text-muted-foreground font-medium">Currently Held</span>
            </div>
          </div>
          
          <div className="flex-1 max-w-md space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-medium">Release Progress</span>
              <span className="font-bold">{percentReleased}%</span>
            </div>
            <Progress value={percentReleased} className="h-3 shadow-inner" />
            <div className="flex justify-between text-xs text-muted-foreground font-medium">
              <span>{formatCurrency(totalReleased)} Released</span>
              <span>Total Pool: {formatCurrency(totalPool)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {project && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon" className="shadow-sm">
                    <Settings className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-5 shadow-xl" align="end">
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <h4 className="font-semibold leading-none">Financial Terms</h4>
                      <p className="text-xs text-muted-foreground">Adjust withholding for all future invoices.</p>
                    </div>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Default Retainage %</Label>
                        <div className="relative">
                          <Input
                            className="pr-7 h-9 font-semibold"
                            value={retainageInput}
                            onChange={(e) => setRetainageInput(e.target.value.replace(/[^\d.]/g, ""))}
                            placeholder="0"
                          />
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                            <span className="text-muted-foreground text-xs">%</span>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Total Project Value</Label>
                        <div className="relative">
                          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                            <span className="text-muted-foreground text-xs">$</span>
                          </div>
                          <Input
                            className="pl-7 h-9 font-semibold"
                            value={valueInput}
                            onChange={(e) => setValueInput(e.target.value.replace(/[^\d.]/g, ""))}
                            placeholder="0.00"
                          />
                        </div>
                      </div>
                      <Button className="w-full h-9 shadow-md" size="sm" onClick={handleUpdateSettings} disabled={isPending}>
                        {isPending ? "Updating..." : "Update Settings"}
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}

            <Button 
              className="shadow-sm"
              disabled={totalHeld <= 0}
              onClick={() => setReleaseOpen(true)}
            >
              <ReceiptText className="mr-2 h-4 w-4" />
              Release Retainage
            </Button>
          </div>
        </div>
      </div>

      <ReleaseRetainageSheet
        projectId={projectId}
        totalHeldCents={totalHeld}
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
      />

      {/* Ledger Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold tracking-tight">Retainage Ledger</h3>
          <div className="text-xs text-muted-foreground font-medium bg-muted/50 px-2.5 py-1 rounded-full border">
            {retainage.length} itemized events
          </div>
        </div>

        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="w-[140px] px-6">Event Date</TableHead>
                <TableHead className="px-4">Source / Reference</TableHead>
                <TableHead className="px-4">Status</TableHead>
                <TableHead className="text-right px-4">Amount</TableHead>
                <TableHead className="w-[80px] px-6 text-center">View</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retainage.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    No retainage events recorded for this project.
                  </TableCell>
                </TableRow>
              ) : (
                retainage.map((item) => {
                  const status = statusMap[item.status] ?? statusMap.held
                  const isRelease = item.status === "released" || item.status === "paid" || item.status === "invoiced"
                  
                  return (
                    <TableRow key={item.id} className="group hover:bg-muted/10 transition-colors">
                      <TableCell className="px-6 font-medium">
                        {format(new Date(item.held_at), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="px-4">
                        <div className="flex flex-col">
                          <span className="font-semibold text-foreground">
                            {isRelease ? "Retainage Release" : `Withheld from Invoice #${item.invoice?.invoice_number ?? "—"}`}
                          </span>
                          <span className="text-xs text-muted-foreground line-clamp-1">
                            {item.invoice?.title || "Manual entry"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-4">
                        <Badge className={cn("text-[10px] font-bold uppercase tracking-wider px-2 py-0.5", status.tone)} variant="secondary">
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className={cn(
                        "text-right px-4 tabular-nums font-bold",
                        isRelease ? "text-emerald-600 dark:text-emerald-500" : "text-amber-600 dark:text-amber-500"
                      )}>
                        {isRelease ? "-" : ""}{formatCurrency(item.amount_cents)}
                      </TableCell>
                      <TableCell className="px-6 text-center">
                        {item.invoice_id ? (
                          <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity" asChild>
                            <a href={`/projects/${item.project_id}/invoices?open=${item.invoice_id}`}>
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { 
    style: "currency", 
    currency: "USD", 
    maximumFractionDigits: 0 
  })
}
