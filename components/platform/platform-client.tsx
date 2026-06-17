"use client"

import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import {
  Users,
  Building2,
  Shield,
  Settings,
  BarChart3,
  Eye,
  DollarSign,
  ArrowUpRight,
} from "@/components/icons"
import { ProvisionOrgSheet } from "@/components/platform/provision-org-sheet"
import { PlatformAiSheet, type AiFeatureConfig, type OrgAiSearchAccess } from "@/components/platform/platform-ai-sheet"
import { DemoUsageSheet } from "@/components/platform/demo-usage-sheet"
import { ImpersonationSheet } from "@/components/platform/impersonation-sheet"
import type { DemoUsageSummary } from "@/lib/services/platform-demo-usage"

interface PlatformStats {
  totalOrgs: number
  newOrgsThisMonth: number
  activeSubscriptions: number
  trialingSubscriptions: number
}

interface PlatformClientProps {
  roles: string[]
  stats: PlatformStats
  plans: React.ComponentProps<typeof ProvisionOrgSheet>["plans"]
  orgs: { id: string; name: string }[]
  aiConfigs: AiFeatureConfig[]
  aiSearchAccess: OrgAiSearchAccess[]
  canManagePlatformAi: boolean
  demoUsage: DemoUsageSummary
  impersonation: { active: boolean; target?: string | null; expiresAt?: string | null }
}

const OPERATIONS = [
  { title: "Customers", description: "Orgs, subscriptions, status", href: "/admin/customers", icon: Users },
  { title: "Plans", description: "Subscription plans & pricing", href: "/admin/plans", icon: DollarSign },
  { title: "Support contracts", description: "Support agreements", href: "/admin/support", icon: Shield },
  { title: "Feature flags", description: "Toggle system features", href: "/admin/features", icon: Settings },
  { title: "Analytics", description: "Usage and metrics", href: "/admin/analytics", icon: BarChart3 },
  { title: "Audit logs", description: "System activity trail", href: "/admin/audit", icon: Eye },
]

export function PlatformClient({
  roles,
  stats,
  plans,
  orgs,
  aiConfigs,
  aiSearchAccess,
  canManagePlatformAi,
  demoUsage,
  impersonation,
}: PlatformClientProps) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="relative z-20 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Platform</span>
            {roles.map((role) => (
              <Badge key={role} variant="secondary" className="rounded-none text-[11px]">
                {role}
              </Badge>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ImpersonationSheet orgs={orgs} session={impersonation} />
            <DemoUsageSheet summary={demoUsage} />
            <PlatformAiSheet
              initialConfigs={aiConfigs}
              aiSearchAccess={aiSearchAccess}
              canManage={canManagePlatformAi}
            />
            <ProvisionOrgSheet plans={plans} />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        {/* Stats — edge-to-edge strip with hairline dividers */}
        <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
          <Stat label="Organizations" value={stats.totalOrgs} hint="all customer orgs" />
          <Stat label="New this month" value={stats.newOrgsThisMonth} hint="orgs provisioned" />
          <Stat label="Active subs" value={stats.activeSubscriptions} hint="paid subscriptions" />
          <Stat label="Trialing" value={stats.trialingSubscriptions} hint="in trial" />
        </div>

        {/* Operations — full-bleed grid */}
        <div className="px-4 pb-2 pt-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Operations</h2>
        </div>
        <div className="grid gap-px border-y bg-border sm:grid-cols-2 lg:grid-cols-3">
          {OPERATIONS.map((op) => (
            <Link
              key={op.href}
              href={op.href}
              className="group flex items-start gap-3 bg-card px-4 py-4 transition-colors hover:bg-accent"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center border bg-muted text-muted-foreground group-hover:text-foreground">
                <op.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 font-medium">
                  {op.title}
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="text-sm text-muted-foreground">{op.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-card px-4 py-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
