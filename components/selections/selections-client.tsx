"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Project, Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import type { SelectionInput } from "@/lib/validation/selections"
import { createSelectionAction } from "@/app/selections/actions"
import { SelectionForm } from "@/components/selections/selection-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Plus, Calendar, List } from "@/components/icons"

const statusLabels: Record<string, string> = {
  pending: "Pending",
  selected: "Selected",
  confirmed: "Confirmed",
  ordered: "Ordered",
  received: "Received",
}

const statusStyles: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border-muted",
  selected: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  confirmed: "bg-warning/20 text-warning border-warning/40",
  ordered: "bg-secondary/30 text-secondary-foreground border-secondary/50",
  received: "bg-success/20 text-success border-success/30",
}

function formatDate(date?: string | null) {
  if (!date) return ""
  return format(new Date(date), "MMM d, yyyy")
}

interface SelectionsBuilderData {
  selections: Selection[]
  categories: SelectionCategory[]
  optionsByCategory: Record<string, SelectionOption[]>
}

interface Props {
  data: SelectionsBuilderData
  projects: Project[]
}

export function SelectionsBuilderClient({ data, projects }: Props) {
  const [items, setItems] = useState<Selection[]>(data.selections)
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
      pending: items.filter((s) => s.status === "pending").length,
      received: items.filter((s) => s.status === "received").length,
    }
  }, [items])

  const categoriesById = useMemo(
    () => Object.fromEntries(data.categories.map((c) => [c.id, c] as const)),
    [data.categories],
  )
  const optionsById = useMemo(() => {
    const map: Record<string, SelectionOption> = {}
    Object.values(data.optionsByCategory).forEach((opts) => {
      opts.forEach((opt) => {
        map[opt.id] = opt
      })
    })
    return map
  }, [data.optionsByCategory])

  async function handleCreate(values: SelectionInput) {
    startTransition(async () => {
      try {
        const created = await createSelectionAction(values)
        setItems((prev) => [created, ...prev])
        setSheetOpen(false)
        toast.success("Selection created")
      } catch (error: any) {
        console.error(error)
        toast.error("Could not create selection", { description: error?.message ?? "Please try again." })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Selections</h1>
          <p className="text-muted-foreground text-sm">Assign categories, track choices, and status.</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <Badge variant="secondary" className="text-xs">
              Total {stats.total}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Pending {stats.pending}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Received {stats.received}
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
            New selection
          </Button>
        </div>
      </div>

      <SelectionForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projects={projects}
        categories={data.categories}
        defaultProjectId={filterProjectId !== "all" ? filterProjectId : projects[0]?.id}
        onSubmit={handleCreate}
        isSubmitting={isPending}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((sel) => {
          const category = categoriesById[sel.category_id]
          const selectedOption = sel.selected_option_id ? optionsById[sel.selected_option_id] : undefined
          return (
            <Card key={sel.id} className="h-full flex flex-col">
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base font-semibold">
                    {category?.name ?? "Selection"} {selectedOption ? `— ${selectedOption.name}` : ""}
                  </CardTitle>
                  <Badge variant="secondary" className={`capitalize border ${statusStyles[sel.status] ?? ""}`}>
                    {statusLabels[sel.status] ?? sel.status}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <List className="h-4 w-4" />
                    {category?.description ?? "No description"}
                  </span>
                  {sel.due_date && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      Due {formatDate(sel.due_date)}
                    </span>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex-1 space-y-3">
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Selected option</span>
                    <Badge variant="outline" className="text-[11px]">
                      {selectedOption ? "Chosen" : "Not chosen"}
                    </Badge>
                  </div>
                  <p className="text-sm text-foreground">
                    {selectedOption
                      ? selectedOption.name
                      : "No option selected yet. Clients choose in the portal."}
                  </p>
                </div>
                {sel.notes && <p className="text-xs text-muted-foreground">Notes: {sel.notes}</p>}
              </CardContent>
            </Card>
          )
        })}

        {filtered.length === 0 && (
          <div className="col-span-full rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">No selections yet.</p>
            <Button className="mt-3" onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first selection
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
