"use client"

import { Badge } from "@/components/ui/badge"
import type { LeadStatus, LeadPriority } from "@/lib/validation/crm"
import { cn } from "@/lib/utils"

const statusConfig: Record<LeadStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive"; className?: string }> = {
  new: { label: "New", variant: "default", className: "bg-blue-500 hover:bg-blue-600" },
  contacted: { label: "Contacted", variant: "secondary" },
  qualified: { label: "Qualified", variant: "default", className: "bg-purple-500 hover:bg-purple-600" },
  estimating: { label: "Estimating", variant: "default", className: "bg-amber-500 hover:bg-amber-600" },
  won: { label: "Won", variant: "default", className: "bg-green-500 hover:bg-green-600" },
  lost: { label: "Lost", variant: "destructive" },
}

const priorityConfig: Record<LeadPriority, { label: string; variant: "default" | "secondary" | "outline" | "destructive"; className?: string }> = {
  low: { label: "Low", variant: "outline" },
  normal: { label: "Normal", variant: "secondary" },
  high: { label: "High", variant: "default", className: "bg-amber-500 hover:bg-amber-600" },
  urgent: { label: "Urgent", variant: "destructive" },
}

interface LeadStatusBadgeProps {
  status: LeadStatus
  className?: string
}

export function LeadStatusBadge({ status, className }: LeadStatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.new
  return (
    <Badge variant={config.variant} className={cn(config.className, className)}>
      {config.label}
    </Badge>
  )
}

interface LeadPriorityBadgeProps {
  priority: LeadPriority
  className?: string
}

export function LeadPriorityBadge({ priority, className }: LeadPriorityBadgeProps) {
  const config = priorityConfig[priority] ?? priorityConfig.normal
  return (
    <Badge variant={config.variant} className={cn(config.className, className)}>
      {config.label}
    </Badge>
  )
}
