import { Suspense } from "react"
import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getSystemMetrics, getUsageTrends } from "@/lib/services/admin"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

function formatMoney(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString()}`
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

async function AnalyticsData() {
  const [metrics, trends] = await Promise.all([getSystemMetrics(), getUsageTrends()])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="relative z-20 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur-sm">
        <span className="text-sm font-semibold">Analytics</span>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        {/* Revenue */}
        <SectionHeading>Revenue</SectionHeading>
        <div className="grid grid-cols-2 gap-px border-y bg-border sm:grid-cols-4">
          <Stat label="MRR" value={formatMoney(metrics.mrrCents)} hint="active subscriptions, monthly-normalized" />
          <Stat label="ARR" value={formatMoney(metrics.mrrCents * 12)} hint="MRR × 12" />
          <Stat
            label="Past due"
            value={formatMoney(metrics.pastDueMrrCents)}
            hint={`${metrics.pastDueSubscriptions} subscriptions`}
            alarm={metrics.pastDueSubscriptions > 0}
          />
          <Stat
            label="Subscriptions"
            value={String(metrics.activeSubscriptions)}
            hint={`${metrics.trialingSubscriptions} trialing`}
          />
        </div>

        {/* Usage */}
        <SectionHeading>Usage</SectionHeading>
        <div className="grid grid-cols-2 gap-px border-y bg-border sm:grid-cols-4">
          <Stat label="Active users (24h)" value={String(metrics.dailyActiveUsers)} hint="distinct members" />
          <Stat label="Active users (7d)" value={String(metrics.weeklyActiveUsers)} hint="distinct members" />
          <Stat label="Events (24h)" value={metrics.eventsLast24h.toLocaleString()} hint="recorded activity" />
          <Stat
            label="Organizations"
            value={String(metrics.totalOrganizations)}
            hint={`${metrics.newOrgsThisMonth} new this month`}
          />
        </div>

        {/* Operations & storage */}
        <SectionHeading>Operations &amp; storage</SectionHeading>
        <div className="grid grid-cols-2 gap-px border-y bg-border sm:grid-cols-4">
          <Link href="/admin/ops" className="block hover:bg-accent">
            <Stat
              label="Outbox failures (24h)"
              value={String(metrics.outboxFailuresLast24h)}
              hint="open Ops for details"
              alarm={metrics.outboxFailuresLast24h > 0}
            />
          </Link>
          <Stat
            label="Overdue invoices"
            value={String(metrics.overdueInvoices)}
            hint="across all orgs"
            alarm={metrics.overdueInvoices > 0}
          />
          <Stat label="Paid payments (30d)" value={String(metrics.paidPaymentsLast30d)} hint="recorded in Arc" />
          <Stat
            label="File storage"
            value={formatBytes(metrics.fileStorageBytes)}
            hint={`${formatBytes(metrics.uploadBytes30d)} uploaded in 30d`}
          />
        </div>

        {/* Trends */}
        <div className="grid gap-6 px-4 py-6 lg:grid-cols-2 mb-4">
          <div>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              User signups by month
            </h2>
            <div className="border">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead className="pl-3">Month</TableHead>
                    <TableHead className="text-right">Signups</TableHead>
                    <TableHead className="pr-3 text-right">Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trends.userGrowth.map((month) => (
                    <TableRow key={month.month}>
                      <TableCell className="pl-3 py-2 text-sm">{month.month}</TableCell>
                      <TableCell className="py-2 text-right text-sm tabular-nums">{month.count}</TableCell>
                      <TableCell
                        className={cn(
                          "pr-3 py-2 text-right text-xs tabular-nums",
                          month.change > 0 ? "text-success" : month.change < 0 ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {month.change > 0 ? "+" : ""}
                        {month.change}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Feature activity — events, last 30d vs prior 30d
            </h2>
            <div className="border">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead className="pl-3">Area</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead className="pr-3 text-right">Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trends.featureUsage.map((feature) => (
                    <TableRow key={feature.name}>
                      <TableCell className="pl-3 py-2 text-sm">{feature.name}</TableCell>
                      <TableCell className="py-2 text-right text-sm tabular-nums">
                        {feature.usage.toLocaleString()}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "pr-3 py-2 text-right text-xs tabular-nums",
                          feature.change > 0 ? "text-success" : feature.change < 0 ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {feature.change > 0 ? "+" : ""}
                        {feature.change}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default async function AnalyticsPage() {
  await requireAnyPermissionGuard(["billing.manage", "platform.billing.manage"])

  return (
    <PageLayout
      title="Analytics"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Analytics" },
      ]}
    >
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<AnalyticsSkeleton />}>
          <AnalyticsData />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-2 pt-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h2>
    </div>
  )
}

function Stat({ label, value, hint, alarm }: { label: string; value: string; hint: string; alarm?: boolean }) {
  return (
    <div className="h-full bg-card px-4 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", alarm && "text-destructive")}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function AnalyticsSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <Skeleton className="h-5 w-20" />
      </div>
      <div className="space-y-6 p-4">
        {Array.from({ length: 3 }).map((_, section) => (
          <div key={section} className="grid grid-cols-2 gap-px sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-4 py-4">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-2 h-7 w-16" />
              </div>
            ))}
          </div>
        ))}
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
