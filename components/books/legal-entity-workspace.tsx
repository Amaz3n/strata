"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { createLegalEntityAction, renameLegalEntityAction, setLegalEntityOwnerAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/legal-entities").getLegalEntityWorkspace>>
type Entity = Workspace["entities"][number]

/**
 * The companies this organization keeps books for. Every posting belongs to
 * one: a job's postings to the job's company, cash to the company that owns the
 * account, anything unassigned to the primary company. When one company pays
 * for another's work, Arc records what they owe each other.
 */
export function LegalEntityWorkspace({ workspace }: { workspace: Workspace }) {
  const primary = workspace.entities.find(entity => entity.isPrimary)
  const active = workspace.entities.filter(entity => entity.status === "active")
  return <div className="space-y-6">
    <p className="max-w-3xl text-sm text-muted-foreground">Each company has its own trial balance and statements. A job or cash account belongs to one company; anything not assigned belongs to {primary?.name ?? "the primary company"}. Once something has posted, its company is fixed.</p>

    <section aria-label="Companies" className="space-y-2">
      <h2 className="text-sm font-medium">Companies</h2>
      <ul className="divide-y border">{workspace.entities.map(entity => <EntityRow key={entity.id} entity={entity} canManage={workspace.canManage} />)}</ul>
      {workspace.canManage && <AddEntity />}
    </section>

    {active.length > 1 && <>
      <OwnerTable label="Cash and card accounts" kind="account" rows={workspace.accounts.map(row => ({ id: row.id, name: row.label, entityId: row.entityId, locked: row.locked }))} entities={active} primaryName={primary?.name ?? "Primary"} canManage={workspace.canManage} />
      <OwnerTable label="Jobs" kind="project" rows={workspace.projects} entities={active} primaryName={primary?.name ?? "Primary"} canManage={workspace.canManage} />
      {workspace.projectsTruncated && <p className="text-xs text-muted-foreground">Showing the first {workspace.projects.length} jobs.</p>}
    </>}
  </div>
}

function EntityRow({ entity, canManage }: { entity: Entity; canManage: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(entity.name)
  const [legalName, setLegalName] = useState(entity.legalName ?? "")
  const [pending, startTransition] = useTransition()
  if (editing) return <li className="flex flex-wrap items-end gap-2 p-3">
    <div className="space-y-1"><Label htmlFor={`entity-name-${entity.id}`}>Name</Label><Input id={`entity-name-${entity.id}`} value={name} onChange={event => setName(event.target.value)} /></div>
    <div className="space-y-1"><Label htmlFor={`entity-legal-${entity.id}`}>Legal name</Label><Input id={`entity-legal-${entity.id}`} value={legalName} onChange={event => setLegalName(event.target.value)} /></div>
    <Button size="sm" disabled={pending || name.trim().length < 2} onClick={() => startTransition(async () => {
      const result = await renameLegalEntityAction({ entityId: entity.id, name, legalName: legalName.trim() || null })
      if (!result.success) { toast.error(result.error); return }
      setEditing(false); router.refresh()
    })}>Save</Button>
    <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
  </li>
  return <li className="flex items-center justify-between gap-3 p-3 text-sm">
    <div><span className="font-medium">{entity.name}</span>{entity.isPrimary && <span className="ml-2 text-xs text-muted-foreground">Primary</span>}
      {entity.legalName && <p className="text-xs text-muted-foreground">{entity.legalName}</p>}</div>
    {canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Rename</Button>}
  </li>
}

function AddEntity() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [legalName, setLegalName] = useState("")
  const [pending, startTransition] = useTransition()
  return <div className="flex flex-wrap items-end gap-2">
    <div className="space-y-1"><Label htmlFor="new-entity-name">Company name</Label><Input id="new-entity-name" value={name} onChange={event => setName(event.target.value)} placeholder="Cedar Ridge Land Co" /></div>
    <div className="space-y-1"><Label htmlFor="new-entity-legal">Legal name</Label><Input id="new-entity-legal" value={legalName} onChange={event => setLegalName(event.target.value)} placeholder="Optional" /></div>
    <Button variant="outline" disabled={pending || name.trim().length < 2} onClick={() => startTransition(async () => {
      const result = await createLegalEntityAction({ name, legalName: legalName.trim() || null })
      if (!result.success) { toast.error(result.error); return }
      toast.success("Company added"); setName(""); setLegalName(""); router.refresh()
    })}>{pending ? "Adding…" : "Add company"}</Button>
  </div>
}

function OwnerTable({ label, kind, rows, entities, primaryName, canManage }: {
  label: string; kind: "project" | "account"; rows: Array<{ id: string; name: string; entityId: string | null; locked: boolean }>
  entities: Entity[]; primaryName: string; canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const primary = entities.find(entity => entity.isPrimary)
  return <section aria-label={label} className="space-y-2">
    <h2 className="text-sm font-medium">{label}</h2>
    {!rows.length ? <p className="border px-3 py-8 text-center text-sm text-muted-foreground">None yet.</p> : <div className="overflow-x-auto border">
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">{kind === "project" ? "Job" : "Account"}</th><th className="px-3 py-2 font-medium">Company</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-b last:border-0">
          <td className="px-3 py-2">{row.name}</td>
          <td className="px-3 py-2">
            {canManage && !row.locked ? <select aria-label={`Company for ${row.name}`} className="w-full max-w-64 border bg-background p-1.5 text-sm" disabled={pending} value={row.entityId ?? primary?.id ?? ""}
              onChange={event => { const entityId = event.target.value === primary?.id ? null : event.target.value; startTransition(async () => {
                const result = await setLegalEntityOwnerAction({ kind, id: row.id, entityId })
                if (!result.success) { toast.error(result.error); return }
                router.refresh()
              }) }}>
              {entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
            </select> : <span>{entities.find(entity => entity.id === row.entityId)?.name ?? primaryName}{row.locked && <span className="ml-2 text-xs text-muted-foreground">Fixed by postings</span>}</span>}
          </td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>
}
