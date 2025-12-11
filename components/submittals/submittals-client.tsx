"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Project, Submittal } from "@/lib/types"
import type { SubmittalInput } from "@/lib/validation/submittals"
import { createSubmittalAction } from "@/app/submittals/actions"
import { SubmittalForm } from "@/components/submittals/submittal-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Calendar, FileText, Building2 } from "@/components/icons"

const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  submitted: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  in_review: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/20 text-destructive border-destructive/30",
}

function formatDate(date?: string | null) {
  if (!date) return ""
  return format(new Date(date), "MMM d, yyyy")
}

interface SubmittalsClientProps {
  submittals: Submittal[]
  projects: Project[]
}

export function SubmittalsClient({ submittals, projects }: SubmittalsClientProps) {
  const [items, setItems] = useState<Submittal[]>(submittals)
  const [filterProjectId, setFilterProjectId] = useState<string>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    if (filterProjectId === "all") return items
    return items.filter((item) => item.project_id === filterProjectId)
  }, [filterProjectId, items])

  const stats = useMemo(() => {
    return {
      total: items.length,
      open: items.filter((s) => s.status !== "approved" && s.status !== "rejected").length,
      approved: items.filter((s) => s.status === "approved").length,
    }
  }, [items])

  async function handleCreate(values: SubmittalInput) {
    startTransition(async () => {
      try {
        const created = await createSubmittalAction(values)
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success("Submittal created", { description: created.title })
      } catch (error: any) {
        console.error(error)
        toast.error("Could not create submittal", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Submittals</h1>
          <p className="text-muted-foreground text-sm">Track product data, shop drawings, and approvals.</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge variant="secondary" className="text-xs">
              Total {stats.total}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Open {stats.open}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Approved {stats.approved}
            </Badge>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={filterProjectId} onValueChange={setFilterProjectId}>
            <SelectTrigger className="w-full sm:w-[220px]">
              <SelectValue placeholder="Filter by project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setSheetOpen(true)} className="w-full sm:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            New submittal
          </Button>
        </div>
      </div>

      <SubmittalForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((submittal) => (
          <Card key={submittal.id} className="h-full flex flex-col">
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base font-semibold">
                  {submittal.submittal_number} — {submittal.title}
                </CardTitle>
                <Badge variant="secondary" className={`capitalize border ${statusStyles[submittal.status] ?? ""}`}>
                  {statusLabels[submittal.status] ?? submittal.status}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Building2 className="h-4 w-4" />
                  {projects.find((p) => p.id === submittal.project_id)?.name ?? "Unknown project"}
                </span>
                {submittal.due_date && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-4 w-4" />
                    Due {formatDate(submittal.due_date)}
                  </span>
                )}
              </div>
            </CardHeader>

            <CardContent className="flex-1 space-y-3">
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Description</span>
                  <Badge variant="outline" className="text-[11px]">
                    {submittal.spec_section || "No spec"}
                  </Badge>
                </div>
                <p className="text-sm text-foreground">
                  {submittal.description || "No description provided for this submittal."}
                </p>
              </div>
              {submittal.submittal_type && (
                <div className="text-xs text-muted-foreground">
                  Type: {submittal.submittal_type}
                </div>
              )}
              {submittal.reviewed_at && (
                <div className="text-xs text-muted-foreground">
                  Reviewed {formatDate(submittal.reviewed_at)}
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {filtered.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">No submittals yet.</p>
            <Button className="mt-3" onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first submittal
            </Button>
          </div>
        )}

        {isPending && filtered.length === 0 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...Array(3)].map((_, idx) => (
              <Skeleton key={idx} className="h-44 w-full rounded-lg" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}



