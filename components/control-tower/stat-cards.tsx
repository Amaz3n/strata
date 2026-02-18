import { Card, CardContent } from "@/components/ui/card"
import { FolderOpen, CheckSquare, DollarSign, AlertCircle } from "@/components/icons"
import type { ControlTowerData } from "@/lib/services/dashboard"

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function StatCards({ data }: { data: ControlTowerData }) {
  const cards = [
    {
      label: "Active Projects",
      value: data.projects.active.length,
      sub: `${data.projects.total} total`,
      icon: FolderOpen,
      accent: "border-l-chart-1",
    },
    {
      label: "Tasks Due This Week",
      value: data.tasks.dueThisWeek,
      sub: `${data.tasks.overdue} overdue`,
      icon: CheckSquare,
      accent: "border-l-chart-2",
    },
    {
      label: "Outstanding AR",
      value: formatCurrency(data.financials.outstandingAR),
      sub: `${formatCurrency(data.financials.totalOverdue)} overdue`,
      icon: DollarSign,
      accent: "border-l-chart-3",
    },
    {
      label: "Open Items",
      value:
        data.openItems.rfis +
        data.openItems.submittals +
        data.openItems.changeOrders +
        data.openItems.punchItems,
      sub: `${data.openItems.rfis} RFIs · ${data.openItems.submittals} submittals`,
      icon: AlertCircle,
      accent: "border-l-chart-4",
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label} className={`border-l-4 ${card.accent}`}>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
              <card.icon className="text-muted-foreground h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs font-medium">{card.label}</p>
              <p className="text-2xl font-bold tracking-tight">{card.value}</p>
              <p className="text-muted-foreground truncate text-xs">{card.sub}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
