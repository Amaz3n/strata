"use client"

import { format, addDays, isWithinInterval, parseISO, differenceInDays, isAfter, isBefore } from "date-fns"
import { motion } from "framer-motion"
import { ArrowRight, Calendar, Clock, DollarSign, AlertCircle, Camera, HardHat, Milestone } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ClientPortalData } from "@/lib/types"

interface PortalHomeTabProps {
  data: ClientPortalData
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

function calculateProjectProgress(data: ClientPortalData): { percent: number; label: string } {
  const scheduleItems = data.schedule ?? []
  if (scheduleItems.length > 0) {
    const totalProgress = scheduleItems.reduce((sum, item) => sum + (item.progress ?? 0), 0)
    const avgProgress = Math.round(totalProgress / scheduleItems.length)
    return { percent: avgProgress, label: "based on schedule" }
  }

  if (data.project.start_date && data.project.end_date) {
    const start = parseISO(data.project.start_date)
    const end = parseISO(data.project.end_date)
    const today = new Date()
    const totalDays = differenceInDays(end, start)
    const elapsedDays = differenceInDays(today, start)

    if (totalDays > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)))
      return { percent, label: "based on timeline" }
    }
  }

  return { percent: 0, label: "" }
}

function getTwoWeekLookahead(data: ClientPortalData) {
  const today = new Date()
  const twoWeeksOut = addDays(today, 14)

  return (data.schedule ?? []).filter((item) => {
    if (!item.start_date) return false
    const startDate = parseISO(item.start_date)
    return isWithinInterval(startDate, { start: today, end: twoWeeksOut }) ||
      (item.status === "in_progress")
  }).slice(0, 5)
}

function getNextMilestoneOrInspection(data: ClientPortalData) {
  const today = new Date()
  const candidates = (data.schedule ?? [])
    .filter((item) => (item.item_type === "inspection" || item.item_type === "milestone") && item.status !== "completed" && item.status !== "cancelled")
    .map((item) => ({
      item,
      date: item.start_date ? parseISO(item.start_date) : undefined,
    }))

  const future = candidates
    .filter((c) => c.date && isAfter(c.date, today))
    .sort((a, b) => (a.date!.getTime() - b.date!.getTime()))

  if (future.length > 0) return future[0]!.item

  const inProgress = candidates.find((c) => c.item.status === "in_progress")
  return inProgress?.item
}

function getNextInvoice(data: ClientPortalData) {
  const today = new Date()
  const openInvoices = (data.invoices ?? []).filter((inv) => {
    const due = inv.balance_due_cents ?? inv.total_cents ?? 0
    if (due <= 0) return false
    return inv.status !== "paid"
  })

  const withDueDates = openInvoices
    .map((inv) => ({ inv, due: inv.due_date ? new Date(inv.due_date) : undefined }))
    .filter((row) => row.due && !Number.isNaN(row.due.getTime()))

  const upcoming = withDueDates
    .filter((row) => isAfter(row.due!, today) || row.due!.toDateString() === today.toDateString())
    .sort((a, b) => a.due!.getTime() - b.due!.getTime())

  if (upcoming.length > 0) return upcoming[0]!.inv

  const pastDue = withDueDates
    .filter((row) => isBefore(row.due!, today))
    .sort((a, b) => a.due!.getTime() - b.due!.getTime())

  if (pastDue.length > 0) return pastDue[0]!.inv
  return openInvoices[0]
}

// --- SVG Progress Ring ---
function ProgressRing({ percent, size = 180, strokeWidth = 10 }: { percent: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (percent / 100) * circumference

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={strokeWidth}
          strokeLinecap="butt"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 1.2, ease: [0.34, 1.56, 0.64, 1] }}
        />
      </svg>
      {/* Center text */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.span
          className="text-4xl font-bold tracking-tight text-foreground"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          {percent}%
        </motion.span>
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground mt-0.5">complete</span>
      </div>
    </div>
  )
}

// --- Stagger animation container ---
const stagger = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.07,
    },
  },
}

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] } },
}

export function PortalHomeTab({ data }: PortalHomeTabProps) {
  const pendingCount = data.pendingChangeOrders.length + data.pendingSelections.length
  const progress = calculateProjectProgress(data)
  const lookahead = getTwoWeekLookahead(data)
  const nextMilestone = getNextMilestoneOrInspection(data)
  const nextInvoice = getNextInvoice(data)
  const latestPhotoWeek = data.photos?.[0]
  const latestPhotos = latestPhotoWeek?.photos?.slice(0, 4) ?? []

  const daysRemaining = data.project.end_date
    ? Math.max(0, differenceInDays(parseISO(data.project.end_date), new Date()))
    : null

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="show"
      className="space-y-5"
    >
      {/* ============ HERO: Progress + Key Stats ============ */}
      <motion.div variants={fadeUp} className="relative overflow-hidden border border-border bg-card">
        {/* Subtle blueprint-style grid background */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(var(--primary) 1px, transparent 1px),
              linear-gradient(90deg, var(--primary) 1px, transparent 1px)
            `,
            backgroundSize: "24px 24px",
          }}
        />
        <div className="relative flex flex-col sm:flex-row items-center gap-6 p-6">
          <ProgressRing percent={progress.percent} />
          <div className="flex-1 min-w-0 text-center sm:text-left space-y-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">Project Progress</p>
              {progress.label && (
                <p className="text-sm text-muted-foreground">{progress.label}</p>
              )}
            </div>
            {/* Timeline bar */}
            {data.project.start_date && data.project.end_date && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{format(parseISO(data.project.start_date), "MMM d, yyyy")}</span>
                  <span>{format(parseISO(data.project.end_date), "MMM d, yyyy")}</span>
                </div>
                <div className="h-1.5 w-full bg-border overflow-hidden">
                  <motion.div
                    className="h-full bg-primary"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress.percent}%` }}
                    transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
                  />
                </div>
              </div>
            )}
            {/* Quick stat pills */}
            <div className="flex flex-wrap justify-center sm:justify-start gap-2">
              {daysRemaining !== null && (
                <div className="flex items-center gap-1.5 bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {daysRemaining} days remaining
                </div>
              )}
              {(data.schedule ?? []).filter(s => s.status === "in_progress").length > 0 && (
                <div className="flex items-center gap-1.5 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
                  <HardHat className="h-3.5 w-3.5" />
                  {(data.schedule ?? []).filter(s => s.status === "in_progress").length} active tasks
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* ============ PENDING ACTIONS BANNER ============ */}
      {pendingCount > 0 && (
        <motion.div
          variants={fadeUp}
          className="flex items-center gap-3 border border-destructive/30 bg-destructive/5 p-4"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-destructive text-destructive-foreground">
            <AlertCircle className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{pendingCount} item{pendingCount > 1 ? "s" : ""} need your attention</p>
            <p className="text-xs text-muted-foreground">
              {data.pendingChangeOrders.length > 0 && `${data.pendingChangeOrders.length} change order${data.pendingChangeOrders.length > 1 ? "s" : ""}`}
              {data.pendingChangeOrders.length > 0 && data.pendingSelections.length > 0 && " · "}
              {data.pendingSelections.length > 0 && `${data.pendingSelections.length} selection${data.pendingSelections.length > 1 ? "s" : ""}`}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </motion.div>
      )}

      {/* ============ BENTO GRID: Financial + Next Up ============ */}
      <div className={`grid gap-4 ${data.financialSummary && (nextMilestone || nextInvoice) ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
        {/* Financial Summary */}
        {data.financialSummary && (
          <motion.div variants={fadeUp} className="border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Financials</span>
            </div>
            <div>
              <p className="text-3xl font-bold tracking-tight text-foreground">
                {formatCurrency(data.financialSummary.contractTotal)}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">contract total</p>
            </div>
            {/* Paid progress */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Paid</span>
                <span className="font-medium text-foreground">
                  {formatCurrency(data.financialSummary.totalPaid)}
                </span>
              </div>
              <div className="h-2 w-full bg-border overflow-hidden">
                <motion.div
                  className="h-full bg-success"
                  initial={{ width: 0 }}
                  animate={{ width: `${data.financialSummary.contractTotal > 0 ? Math.round((data.financialSummary.totalPaid / data.financialSummary.contractTotal) * 100) : 0}%` }}
                  transition={{ duration: 0.8, ease: "easeOut", delay: 0.5 }}
                />
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Remaining</span>
                <span className="font-medium text-foreground">
                  {formatCurrency(data.financialSummary.balanceRemaining)}
                </span>
              </div>
            </div>
            {data.financialSummary.nextDraw && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">Next Draw</p>
                <p className="text-sm font-semibold mt-0.5">{formatCurrency(data.financialSummary.nextDraw.amount_cents)}</p>
                {data.financialSummary.nextDraw.due_date && (
                  <p className="text-xs text-muted-foreground">
                    Due {format(new Date(data.financialSummary.nextDraw.due_date), "MMM d, yyyy")}
                  </p>
                )}
              </div>
            )}
          </motion.div>
        )}

        {/* Next Up */}
        {(nextMilestone || nextInvoice) && (
          <motion.div variants={fadeUp} className="border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Coming Up</span>
            </div>
            <div className="space-y-4">
              {nextMilestone && (
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-primary/10">
                    <Milestone className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{nextMilestone.name}</p>
                    {nextMilestone.start_date && (
                      <p className="text-xs text-muted-foreground">
                        {nextMilestone.item_type === "inspection" ? "Inspection" : "Milestone"} · {format(parseISO(nextMilestone.start_date), "EEE, MMM d")}
                      </p>
                    )}
                    <Badge variant="outline" className="capitalize text-[10px] mt-1.5 px-2 py-0">
                      {nextMilestone.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </div>
              )}
              {nextInvoice && (
                <div className={nextMilestone ? "border-t border-border pt-4" : ""}>
                  <div className="flex gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-chart-3/10">
                      <DollarSign className="h-4.5 w-4.5 text-chart-3" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{nextInvoice.title || nextInvoice.invoice_number}</p>
                      {nextInvoice.due_date && (
                        <p className="text-xs text-muted-foreground">
                          Due {format(new Date(nextInvoice.due_date), "MMM d, yyyy")}
                        </p>
                      )}
                      {(nextInvoice.balance_due_cents ?? nextInvoice.total_cents) != null && (
                        <p className="text-lg font-bold mt-1">
                          {formatCurrency((nextInvoice.balance_due_cents ?? nextInvoice.total_cents) ?? 0)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </div>

      {/* ============ PHOTOS ============ */}
      {latestPhotos.length > 0 && (
        <motion.div variants={fadeUp} className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Latest Photos</span>
            </div>
            {latestPhotoWeek?.week_start && latestPhotoWeek?.week_end && (
              <span className="text-xs text-muted-foreground">
                Week of {format(new Date(latestPhotoWeek.week_start), "MMM d")} – {format(new Date(latestPhotoWeek.week_end), "MMM d")}
              </span>
            )}
          </div>
          <div className={`grid gap-1 ${latestPhotos.length >= 3 ? "grid-cols-2 sm:grid-cols-4" : latestPhotos.length === 2 ? "grid-cols-2" : "grid-cols-1 max-w-sm"}`}>
            {latestPhotos.map((photo, i) => (
              <motion.div
                key={photo.id}
                className={`relative overflow-hidden bg-muted ${i === 0 && latestPhotos.length >= 3 ? "col-span-2 row-span-2 aspect-[4/3]" : "aspect-square"}`}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: 0.2 + i * 0.08 }}
              >
                <img src={photo.url} alt="" className="h-full w-full object-cover transition-transform duration-500 hover:scale-105" />
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}

      {/* ============ RECENT LOGS ============ */}
      {data.recentLogs.length > 0 && (
        <motion.div variants={fadeUp} className="border border-border bg-card p-5">
          <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium mb-4">Recent Updates</p>
          <div className="space-y-0">
            {data.recentLogs.slice(0, 3).map((log, i) => (
              <div key={log.id} className={`flex gap-4 py-3 ${i > 0 ? "border-t border-border" : ""}`}>
                <div className="shrink-0 text-right" style={{ minWidth: 56 }}>
                  <p className="text-lg font-bold leading-none text-foreground">
                    {format(parseISO(log.date), "d")}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                    {format(parseISO(log.date), "MMM")}
                  </p>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {format(parseISO(log.date), "EEEE")}
                  </p>
                  {log.notes && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{log.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* ============ 2-WEEK LOOKAHEAD ============ */}
      <motion.div variants={fadeUp} className="border border-border bg-card p-5">
        <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium mb-4">2-Week Look-ahead</p>
        {lookahead.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No scheduled work in the next 2 weeks</p>
        ) : (
          <div className="space-y-0">
            {lookahead.map((item, i) => (
              <div
                key={item.id}
                className={`flex items-center gap-4 py-3 ${i > 0 ? "border-t border-border" : ""}`}
              >
                {/* Status indicator */}
                <div
                  className="h-8 w-1 shrink-0"
                  style={{
                    backgroundColor: item.status === "completed"
                      ? "var(--success)"
                      : item.status === "in_progress"
                        ? "var(--primary)"
                        : "var(--border)",
                  }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  {item.start_date && (
                    <p className="text-xs text-muted-foreground">
                      {format(parseISO(item.start_date), "EEE, MMM d")}
                      {item.end_date && item.end_date !== item.start_date && (
                        <> – {format(parseISO(item.end_date), "MMM d")}</>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {typeof item.progress === "number" && item.progress > 0 && (
                    <div className="flex items-center gap-1.5">
                      <div className="h-1 w-12 bg-border overflow-hidden">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground w-7 text-right">{item.progress}%</span>
                    </div>
                  )}
                  <Badge
                    variant={item.status === "in_progress" ? "default" : "secondary"}
                    className="capitalize text-[10px] px-2 py-0"
                  >
                    {item.status.replaceAll("_", " ")}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
