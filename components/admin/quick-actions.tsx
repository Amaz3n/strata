import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Users,
  CreditCard,
  Settings,
  BarChart3,
  Shield,
  Eye,
  DollarSign
} from "@/components/icons"
import Link from "next/link"

export function QuickActions() {
  const actions = [
    {
      title: "Manage Plans",
      description: "Create and edit subscription plans",
      href: "/admin/plans",
      icon: DollarSign,
      variant: "default" as const,
    },
    {
      title: "Manage Customers",
      description: "View and edit customer details",
      href: "/admin/customers",
      icon: Users,
      variant: "outline" as const,
    },
    {
      title: "Support Contracts",
      description: "View support agreements",
      href: "/admin/support",
      icon: Shield,
      variant: "outline" as const,
    },
    {
      title: "Feature Flags",
      description: "Manage system features",
      href: "/admin/features",
      icon: Settings,
      variant: "outline" as const,
    },
    {
      title: "Analytics",
      description: "System usage and metrics",
      href: "/admin/analytics",
      icon: BarChart3,
      variant: "outline" as const,
    },
    {
      title: "Audit Logs",
      description: "View system activity",
      href: "/admin/audit",
      icon: Eye,
      variant: "outline" as const,
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Actions</CardTitle>
        <CardDescription>Common administrative tasks</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {actions.map((action) => (
            <Button
              key={action.href}
              variant={action.variant}
              className="justify-start h-auto p-3"
              asChild
            >
              <Link href={action.href} className="flex items-center gap-3 w-full">
                <action.icon className="h-4 w-4 flex-shrink-0" />
                <div className="text-left">
                  <div className="font-medium">{action.title}</div>
                  <div className="text-xs text-muted-foreground">{action.description}</div>
                </div>
              </Link>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}