"use client"
import { InventoryAllocation } from "@/components/books/inventory-allocation"
import { WarrantyReserveEstimate } from "@/components/books/warranty-accounting"
import { LandAcquisition } from "@/components/books/land-acquisition"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { loadInventoryWorkspaceAction, enableProjectInventoryAction, completeProjectInventoryAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Project = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getInventoryWorkspace>>[number]
export function InventoryWorkspace({ canManage }: { canManage: boolean }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [selected, setSelected] = useState("")
  const [pending, startTransition] = useTransition()
  const project = projects?.find(row => row.id === selected)
  const load = async () => { const result = await loadInventoryWorkspaceAction(); if (!result.success) { toast.error(result.error); return } setProjects(result.data) }
  return <section className="space-y-4 border p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">Owned-home inventory</h3><p className="text-sm text-muted-foreground">Adopt an ownership policy, accumulate build costs, and transfer completed homes to inventory held for sale. Closing releases their recorded cost.</p></div><Button variant="outline" disabled={pending} onClick={() => startTransition(load)}>Review projects</Button></div>
    <LandAcquisition />
    {projects?.length === 0 && <p className="text-sm text-muted-foreground">No projects currently recognize revenue at closing.</p>}
    {projects && projects.length > 0 && <Select value={selected} onValueChange={setSelected}><SelectTrigger aria-label="Inventory project"><SelectValue placeholder="Choose a project" /></SelectTrigger><SelectContent>{projects.map(row => <SelectItem key={row.id} value={row.id}>{row.name}</SelectItem>)}</SelectContent></Select>}
    {project?.policy && !project.policy.completedOn && !project.policy.soldOn && <InventoryAllocation projectId={project.id} />}
    {project && <WarrantyReserveEstimate projectId={project.id} />}
    {project && <div className="space-y-3"><p className="text-sm">{project.policy?.soldOn ? `Sold ${project.policy.soldOn}` : project.policy?.completedOn ? `Completed inventory since ${project.policy.completedOn}` : project.policy ? `Build costs capitalized from ${project.policy.effectiveOn}` : "Inventory policy has not been adopted. Existing expenses remain in their recorded periods."}</p>
      {!project.policy?.soldOn && !project.policy?.completedOn && (project.policy || canManage) && <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget)
        startTransition(async () => {
          const date = String(data.get("date") ?? ""); const evidenceUrl = String(data.get("evidenceUrl") ?? "")
          const result = project.policy ? await completeProjectInventoryAction({ projectId: project.id, date, evidenceUrl }) : await enableProjectInventoryAction({ projectId: project.id, effectiveOn: date, evidenceUrl })
          if (!result.success) { toast.error(result.error); return }
          toast.success(project.policy ? "Completed inventory recorded" : "Inventory policy adopted"); await load()
        })
      }}><div className="space-y-1"><Label htmlFor="inventory-date">{project.policy ? "Completion date" : "Policy effective date"}</Label><Input id="inventory-date" name="date" type="date" required /></div><div className="space-y-1"><Label htmlFor="inventory-evidence">{project.policy ? "Completion evidence URL" : "Ownership and policy evidence URL"}</Label><Input id="inventory-evidence" name="evidenceUrl" type="url" required /></div><Button type="submit" disabled={pending}>{project.policy ? "Record completed home" : "Adopt owned inventory accounting"}</Button></form>}
    </div>}
  </section>
}
