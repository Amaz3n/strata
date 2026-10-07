"use client"
import { InventoryAllocation } from "@/components/books/inventory-allocation"
import { WarrantyReserveEstimate } from "@/components/books/warranty-accounting"
import { InventoryImpairment } from "@/components/books/inventory-impairment"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { loadInventoryWorkspaceAction, enableProjectInventoryAction, completeProjectInventoryAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Project = Awaited<ReturnType<typeof import("@/lib/services/books/inventory").getInventoryWorkspace>>[number]
export function InventoryWorkspace({ canManage, initialProject }: { canManage: boolean; initialProject: Project }) {
  return <InventoryWorkspaceContent key={initialProject.id} canManage={canManage} initialProject={initialProject} />
}

function InventoryWorkspaceContent({ canManage, initialProject }: { canManage: boolean; initialProject: Project }) {
  const [snapshot, setSnapshot] = useState({ source: initialProject, project: initialProject, pending: false })
  // Adopt a refreshed policy without replacing the same project's form drafts.
  if (snapshot.source !== initialProject) {
    setSnapshot({ source: initialProject, project: initialProject, pending: false })
  }
  const { project, pending } = snapshot
  const requestScope = useMemo(() => ({ active: false, writing: false }), [initialProject])
  useEffect(() => {
    requestScope.active = true
    return () => { requestScope.active = false }
  }, [requestScope])

  const save = async (data: FormData) => {
    if (requestScope.writing || !requestScope.active) return
    requestScope.writing = true
    setSnapshot(current => current.source === initialProject ? { ...current, pending: true } : current)
    try {
      const date = String(data.get("date") ?? "")
      const evidenceUrl = String(data.get("evidenceUrl") ?? "")
      const result = project.policy
        ? await completeProjectInventoryAction({ projectId: project.id, date, evidenceUrl })
        : await enableProjectInventoryAction({ projectId: project.id, effectiveOn: date, evidenceUrl })
      if (!requestScope.active) return
      if (!result.success) { toast.error(result.error); return }
      toast.success(project.policy ? "Completed inventory recorded" : "Inventory policy adopted")
      const refreshed = await loadInventoryWorkspaceAction()
      if (!requestScope.active) return
      if (!refreshed.success) { toast.error(refreshed.error); return }
      const updated = refreshed.data.find(row => row.id === project.id)
      if (!updated) { toast.error("The project is no longer available in inventory accounting. Refresh this page."); return }
      setSnapshot(current => current.source === initialProject ? { ...current, project: updated } : current)
    } catch (error) {
      if (requestScope.active) toast.error(error instanceof Error ? error.message : "Could not update inventory accounting")
    } finally {
      requestScope.writing = false
      if (requestScope.active)
        setSnapshot(current => current.source === initialProject ? { ...current, pending: false } : current)
    }
  }
  return <section className="space-y-4 border p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="font-medium">Owned-home inventory</h3><p className="text-sm text-muted-foreground">Adopt an ownership policy, accumulate build costs, and transfer completed homes to inventory held for sale. Closing releases their recorded cost.</p></div></div>
    {project?.policy && !project.policy.completedOn && !project.policy.soldOn && <InventoryAllocation projectId={project.id} />}
    {project?.policy && !project.policy.soldOn && <InventoryImpairment projectId={project.id} />}
    {project && <WarrantyReserveEstimate projectId={project.id} />}
    {project && <div className="space-y-3"><p className="text-sm">{project.policy?.soldOn ? `Sold ${project.policy.soldOn}` : project.policy?.completedOn ? `Completed inventory since ${project.policy.completedOn}` : project.policy ? `Build costs capitalized from ${project.policy.effectiveOn}` : "Inventory policy has not been adopted. Existing expenses remain in their recorded periods."}</p>
      {!project.policy?.soldOn && !project.policy?.completedOn && (project.policy || canManage) && <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault(); void save(new FormData(event.currentTarget))
      }}><div className="space-y-1"><Label htmlFor="inventory-date">{project.policy ? "Completion date" : "Policy effective date"}</Label><Input id="inventory-date" name="date" type="date" required /></div><div className="space-y-1"><Label htmlFor="inventory-evidence">{project.policy ? "Completion evidence URL" : "Ownership and policy evidence URL"}</Label><Input id="inventory-evidence" name="evidenceUrl" type="url" required /></div><Button type="submit" disabled={pending}>{project.policy ? "Record completed home" : "Adopt owned inventory accounting"}</Button></form>}
    </div>}
  </section>
}
