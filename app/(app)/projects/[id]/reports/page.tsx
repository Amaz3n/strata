import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowRight, BarChart3, Receipt, TrendingUp, Wallet } from "lucide-react"

import { PageLayout } from "@/components/layout/page-layout"
import { Card } from "@/components/ui/card"
import { getProjectAction } from "@/app/(app)/projects/[id]/actions"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

type ReportCard = {
  key: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  href?: string
  comingSoon?: boolean
}

export default async function ProjectReportsPage({ params }: PageProps) {
  const { id } = await params
  const project = await getProjectAction(id)
  if (!project) notFound()

  const base = `/projects/${project.id}/reports`
  const reports: ReportCard[] = [
    {
      key: "profitability",
      title: "Project Profitability",
      description: "Income, cost of work, and net profit with budget variance and margin. Export to PDF or CSV.",
      icon: TrendingUp,
      href: `${base}/profitability`,
    },
    {
      key: "ctc",
      title: "Cost-to-Complete Forecast",
      description: "Committed and actual costs projected to final, with variance at completion by cost code.",
      icon: BarChart3,
      comingSoon: true,
    },
    {
      key: "ar-aging",
      title: "Receivables Aging",
      description: "Outstanding owner invoices bucketed by age, with overdue balances at a glance.",
      icon: Receipt,
      comingSoon: true,
    },
    {
      key: "ap-aging",
      title: "Payables Aging",
      description: "Open vendor bills by age and due date to plan cash outflow.",
      icon: Wallet,
      comingSoon: true,
    },
  ]

  return (
    <PageLayout
      title="Reports"
      breadcrumbs={[{ label: project.name, href: `/projects/${project.id}` }, { label: "Reports" }]}
      fullBleed
    >
      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">
          Quick financial reports for <span className="font-medium text-foreground">{project.name}</span>. Pick a report to
          view, filter, and export.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {reports.map((report) => {
            const Icon = report.icon
            const inner = (
              <Card
                className={
                  "group h-full gap-2 p-5 transition-colors " +
                  (report.comingSoon ? "opacity-60" : "hover:border-foreground/30 hover:bg-muted/30")
                }
              >
                <div className="flex items-center justify-between">
                  <div className="flex size-9 items-center justify-center rounded-md bg-muted text-foreground">
                    <Icon className="size-4.5" />
                  </div>
                  {report.comingSoon ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      Coming soon
                    </span>
                  ) : (
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  )}
                </div>
                <h3 className="mt-1 text-sm font-semibold">{report.title}</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{report.description}</p>
              </Card>
            )
            return report.href && !report.comingSoon ? (
              <Link key={report.key} href={report.href} className="block">
                {inner}
              </Link>
            ) : (
              <div key={report.key}>{inner}</div>
            )
          })}
        </div>
      </div>
    </PageLayout>
  )
}
