"use client"

import { useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { GateDefinitionDTO } from "@/lib/services/starts"
import { upsertGateDefinitionAction } from "@/app/(app)/starts/actions"

export function GateSettingsClient({ definitions }: { definitions: GateDefinitionDTO[] }) {
  const [pending, startTransition] = useTransition()
  return <div className="border"><Table><TableHeader><TableRow><TableHead>Gate</TableHead><TableHead>Kind</TableHead><TableHead>Source</TableHead><TableHead>Applies when</TableHead><TableHead>Permission</TableHead><TableHead className="text-right">Active</TableHead></TableRow></TableHeader>
    <TableBody>{definitions.map((definition) => <TableRow key={definition.id}><TableCell><p className="font-medium">{definition.label}</p><p className="text-xs text-muted-foreground">{definition.key}</p></TableCell><TableCell className="capitalize">{definition.checkKind}</TableCell><TableCell>{definition.autoSource ?? "—"}</TableCell><TableCell>{definition.appliesWhen.replace("_", " ")}</TableCell><TableCell>{definition.requiresAttestationPermission ?? "start.write"}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" disabled={pending} onClick={() => startTransition(async () => { unwrapAction(await upsertGateDefinitionAction({ ...definition, isActive: !definition.isActive })) })}>{definition.isActive ? "Enabled" : "Disabled"}</Button></TableCell></TableRow>)}</TableBody>
  </Table></div>
}
