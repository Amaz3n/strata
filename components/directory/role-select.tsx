"use client"

import { useEffect, useState } from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listRelationshipTypesAction } from "@/app/(app)/directory/actions"
import type { PartyKind, RelationshipType } from "@/lib/directory/roles"

/**
 * What this party is to the org, picked once at creation.
 *
 * A party holds a SET of roles, and this only opens the set — the account's
 * role manager is where a second role is added, a status moves along its
 * lifecycle, and a role is ended. That split is deliberate: creating a record
 * is a single decision, whereas a party becoming a client as well as a
 * subcontractor is something that happens later, to a record that already
 * exists.
 *
 * The options are the org's own vocabulary rather than the legacy type enum, so
 * a role an org added itself is pickable here and `prospect` / `buyer` /
 * `homeowner` are reachable at all.
 */
export function RoleSelect({
  kind,
  value,
  onChange,
  disabled,
}: {
  kind: PartyKind
  value: string
  onChange: (roleKey: string) => void
  disabled?: boolean
}) {
  const [types, setTypes] = useState<RelationshipType[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await listRelationshipTypesAction()
      if (cancelled) return
      // A vocabulary that will not load leaves the default role in place rather
      // than blocking the create; the record is still given a role server-side.
      setTypes(result.success ? result.data : [])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const options = (types ?? []).filter(
    (type) => type.applies_to === "both" || type.applies_to === kind,
  )
  const loading = types === null

  return (
    // Blank rather than the pending value while the vocabulary is in flight: a
    // trigger whose value matches no option renders empty, which reads as a
    // field nobody filled in instead of one that is still loading.
    <Select value={loading ? "" : value} onValueChange={onChange} disabled={disabled || loading}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={loading ? "Loading roles…" : "Select role"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((type) => (
          <SelectItem key={type.key} value={type.key}>
            {type.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
