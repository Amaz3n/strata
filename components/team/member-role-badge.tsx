"use client"

import { Badge } from "@/components/ui/badge"
import type { OrgRole } from "@/lib/types"

function toRoleLabel(roleKey: string) {
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export function MemberRoleBadge({ role, label }: { role: OrgRole; label?: string }) {
  const normalizedLabel = (label ?? "").replace(/^org[\s_-]+/i, "").trim()
  return <Badge variant="secondary">{normalizedLabel || toRoleLabel(role)}</Badge>
}






