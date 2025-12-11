"use client"

import { Badge } from "@/components/ui/badge"
import type { OrgRole } from "@/lib/types"

const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
  readonly: "Read-only",
}

export function MemberRoleBadge({ role }: { role: OrgRole }) {
  return <Badge variant="secondary">{ROLE_LABELS[role] ?? role}</Badge>
}



