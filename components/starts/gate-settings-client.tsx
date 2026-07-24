"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Plus, ShieldCheck } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { GateDefinitionDTO } from "@/lib/services/starts"
import { cn } from "@/lib/utils"
import { seedDefaultGatesAction, upsertGateDefinitionAction } from "@/app/(app)/starts/actions"

const APPLIES_LABELS: Record<string, string> = {
  always: "Always",
  financed_only: "Financed only",
  purchasing_enabled: "Purchasing enabled",
}

interface GateDraft {
  id?: string
  key: string
  label: string
  description: string
  appliesWhen: string
  requiresAttestationPermission: string
  sortOrder: string
}

const EMPTY_DRAFT: GateDraft = { key: "", label: "", description: "", appliesWhen: "always", requiresAttestationPermission: "none", sortOrder: "100" }

export function GateSettingsClient({ definitions, canManage }: { definitions: GateDefinitionDTO[]; canManage: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<GateDraft | null>(null)
  const [editing, setEditing] = useState<GateDefinitionDTO | null>(null)

  const runAction = (operation: () => Promise<unknown>, success: string, failure: string, after?: () => void) => {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        after?.()
        router.refresh()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const toggleActive = (definition: GateDefinitionDTO) => {
    runAction(
      async () => { unwrapAction(await upsertGateDefinitionAction({ ...definition, isActive: !definition.isActive })) },
      definition.isActive ? `${definition.label} disabled` : `${definition.label} enabled`,
      "Unable to update gate",
    )
  }

  const saveDraft = () => {
    if (!draft) return
    const isEdit = Boolean(draft.id)
    const base = editing
    runAction(
      async () => {
        unwrapAction(await upsertGateDefinitionAction({
          id: draft.id,
          key: draft.key.trim(),
          label: draft.label.trim(),
          description: draft.description.trim() || null,
          checkKind: base?.checkKind ?? "manual",
          autoSource: base?.autoSource ?? null,
          requiresAttestationPermission: draft.requiresAttestationPermission === "none" ? null : draft.requiresAttestationPermission,
          appliesWhen: draft.appliesWhen,
          sortOrder: Number(draft.sortOrder) || 0,
          isActive: base?.isActive ?? true,
        }))
      },
      isEdit ? "Gate updated" : "Gate created",
      isEdit ? "Unable to update gate" : "Unable to create gate",
      () => { setDraft(null); setEditing(null) },
    )
  }

  const openEdit = (definition: GateDefinitionDTO) => {
    setEditing(definition)
    setDraft({
      id: definition.id,
      key: definition.key,
      label: definition.label,
      description: definition.description ?? "",
      appliesWhen: definition.appliesWhen,
      requiresAttestationPermission: definition.requiresAttestationPermission ?? "none",
      sortOrder: String(definition.sortOrder),
    })
  }

  const newGateButton = canManage ? (
    <Button size="sm" className="rounded-none" onClick={() => { setEditing(null); setDraft({ ...EMPTY_DRAFT }) }}>
      <Plus className="mr-1.5 h-4 w-4" />
      New gate
    </Button>
  ) : null

  if (!definitions.length) {
    return (
      <Empty className="min-h-64 rounded-none border">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="rounded-none"><ShieldCheck /></EmptyMedia>
          <EmptyTitle className="text-sm">No start gates defined</EmptyTitle>
          <EmptyDescription className="text-xs">
            Gates are the readiness checklist every start package must clear before release. Restore the standard set, then tailor it to your operation.
          </EmptyDescription>
        </EmptyHeader>
        {canManage ? (
          <EmptyContent>
            <Button
              size="sm"
              className="rounded-none"
              disabled={pending}
              onClick={() => runAction(async () => { unwrapAction(await seedDefaultGatesAction()) }, "Default gates restored", "Unable to restore default gates")}
            >
              {pending ? "Restoring…" : "Restore default gates"}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs tabular-nums text-muted-foreground">
          {definitions.filter((definition) => definition.isActive).length} active of {definitions.length} gates — new packages copy the active set.
        </span>
        {newGateButton}
      </div>
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="text-[11px] uppercase tracking-wide">
              <TableHead>Gate</TableHead>
              <TableHead>Check</TableHead>
              <TableHead>Applies when</TableHead>
              <TableHead>Attest permission</TableHead>
              <TableHead className="text-right">Order</TableHead>
              <TableHead className="text-right">Active</TableHead>
              {canManage ? <TableHead className="text-right">Edit</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {definitions.map((definition) => (
              <TableRow key={definition.id} className={cn("text-xs", !definition.isActive && "opacity-50")}>
                <TableCell>
                  <p className="font-medium">{definition.label}</p>
                  <p className="text-[11px] text-muted-foreground">
                    <span className="font-mono">{definition.key}</span>
                    {definition.description ? ` — ${definition.description}` : ""}
                  </p>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {definition.checkKind === "auto" ? `Auto · ${definition.autoSource?.replaceAll("_", " ")}` : "Manual"}
                </TableCell>
                <TableCell>{APPLIES_LABELS[definition.appliesWhen] ?? definition.appliesWhen}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{definition.requiresAttestationPermission ?? "start.write"}</TableCell>
                <TableCell className="text-right tabular-nums">{definition.sortOrder}</TableCell>
                <TableCell className="text-right">
                  <Switch checked={definition.isActive} disabled={!canManage || pending} onCheckedChange={() => toggleActive(definition)} />
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" className="rounded-none" disabled={pending} onClick={() => openEdit(definition)}>Edit</Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) { setDraft(null); setEditing(null) } }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit gate" : "New manual gate"}</DialogTitle>
            <DialogDescription>
              {draft?.id
                ? editing?.checkKind === "auto"
                  ? "This is a system-checked gate; its check source cannot change."
                  : "Manual gates are attested by a person on each package."
                : "Custom gates are manual: someone attests them on each start package before release."}
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <form
              id="gate-form"
              className="grid gap-4 py-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!pending && draft.label.trim() && draft.key.trim()) saveDraft()
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="gate-label">Label</Label>
                  <Input id="gate-label" autoFocus className="rounded-none" maxLength={160} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="gate-key">Key</Label>
                  <Input
                    id="gate-key"
                    className="rounded-none font-mono"
                    maxLength={40}
                    disabled={Boolean(draft.id)}
                    value={draft.key}
                    onChange={(event) => setDraft({ ...draft, key: event.target.value.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_") })}
                    placeholder="hoa_approval"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="gate-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Textarea id="gate-description" className="rounded-none" rows={2} maxLength={1000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label>Applies when</Label>
                  <Select value={draft.appliesWhen} onValueChange={(value) => setDraft({ ...draft, appliesWhen: value })}>
                    <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="always">Always</SelectItem>
                      <SelectItem value="financed_only">Financed only</SelectItem>
                      <SelectItem value="purchasing_enabled">Purchasing enabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Attest permission</Label>
                  <Select value={draft.requiresAttestationPermission} onValueChange={(value) => setDraft({ ...draft, requiresAttestationPermission: value })}>
                    <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Standard (start.write)</SelectItem>
                      <SelectItem value="start.release">Release approvers only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="gate-order">Order</Label>
                  <Input id="gate-order" type="number" min={0} max={1000} className="rounded-none" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} />
                </div>
              </div>
            </form>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDraft(null); setEditing(null) }}>Cancel</Button>
            <Button form="gate-form" type="submit" disabled={pending || !draft?.label.trim() || !draft?.key.trim()}>
              {pending ? "Saving…" : draft?.id ? "Save gate" : "Create gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
