"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Plus } from "@/components/icons"
import { toast } from "sonner"

import { archiveDivisionAction, createDivisionAction, updateDivisionAction } from "@/app/(app)/settings/divisions/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { DivisionDTO } from "@/lib/services/divisions"

export function DivisionTable({ divisions, canManage }: { divisions: DivisionDTO[]; canManage: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [region, setRegion] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)

  function openCreate() {
    setEditingId(null)
    setName("")
    setCode("")
    setRegion("")
    setOpen(true)
  }

  function openEdit(division: DivisionDTO) {
    setEditingId(division.id)
    setName(division.name)
    setCode(division.code ?? "")
    setRegion(division.region ?? "")
    setOpen(true)
  }

  function save() {
    startTransition(async () => {
      try {
        const input = { name, code: code || null, region: region || null }
        if (editingId) unwrapAction(await updateDivisionAction(editingId, input))
        else unwrapAction(await createDivisionAction(input))
        toast.success(editingId ? "Division updated" : "Division created")
        setOpen(false)
        router.refresh()
      } catch (error) { toast.error("Unable to save division", { description: (error as Error).message }) }
    })
  }

  function archive(division: DivisionDTO) {
    if (!window.confirm(`Archive ${division.name}?`)) return
    startTransition(async () => {
      try { unwrapAction(await archiveDivisionAction(division.id)); toast.success("Division archived"); router.refresh() }
      catch (error) { toast.error("Unable to archive division", { description: (error as Error).message }) }
    })
  }

  return <div className="flex min-h-full flex-col"><div className="flex items-center justify-between border-b px-4 py-3"><div><h1 className="text-sm font-semibold">Divisions</h1><p className="text-xs text-muted-foreground">Optional reporting and operating scope. Divisions do not change tenant isolation.</p></div>{canManage ? <Button size="sm" className="rounded-none" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" />New division</Button> : null}</div>{divisions.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-20 text-center"><p className="text-sm font-medium">No divisions configured</p><p className="max-w-md text-xs text-muted-foreground">A single-market builder can leave divisions empty. Create one when communities need regional, brand, or entity scope.</p>{canManage ? <Button variant="outline" size="sm" className="mt-2 rounded-none" onClick={openCreate}>Add division</Button> : null}</div> : <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead>Region</TableHead><TableHead className="text-right">Communities</TableHead><TableHead className="text-right">Active projects</TableHead>{canManage ? <TableHead /> : null}</TableRow></TableHeader><TableBody>{divisions.map((division) => <TableRow key={division.id} className={division.archived ? "text-xs opacity-60" : "text-xs"}><TableCell className="font-medium">{division.name}{division.archived ? <span className="ml-2 text-muted-foreground">Archived</span> : null}</TableCell><TableCell className="text-muted-foreground">{division.code ?? "—"}</TableCell><TableCell className="text-muted-foreground">{division.region ?? "—"}</TableCell><TableCell className="text-right tabular-nums">{division.communityCount}</TableCell><TableCell className="text-right tabular-nums">{division.activeProjectCount}</TableCell>{canManage ? <TableCell className="text-right">{!division.archived ? <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" disabled={isPending} onClick={() => openEdit(division)}>Edit</Button><Button variant="ghost" size="sm" disabled={isPending} onClick={() => archive(division)}>Archive</Button></div> : null}</TableCell> : null}</TableRow>)}</TableBody></Table>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="rounded-none sm:max-w-md"><DialogHeader><DialogTitle>{editingId ? "Edit division" : "New division"}</DialogTitle><DialogDescription>Create a light operating scope for communities and projects.</DialogDescription></DialogHeader><div className="grid gap-3"><div className="grid gap-1.5"><Label>Name</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div><div className="grid grid-cols-2 gap-3"><div className="grid gap-1.5"><Label>Code</Label><Input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={8} placeholder="SWFL" /></div><div className="grid gap-1.5"><Label>Region</Label><Input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="Southwest Florida" /></div></div></div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim() || isPending} onClick={save}>{editingId ? "Save" : "Create"}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
