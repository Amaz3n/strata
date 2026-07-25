"use client"

import { type CSSProperties, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ArrowDown, ArrowUp, ArrowUpDown, Layers, MoreHorizontal, Plus, Search, XCircle } from "@/components/icons"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import {
  archiveDivisionAction,
  createDivisionAction,
  restoreDivisionAction,
  updateDivisionAction,
} from "@/app/(app)/settings/divisions/actions"
import type { DivisionDTO } from "@/lib/services/divisions"

const TH = "microlabel sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left whitespace-nowrap"
const TD = "px-3 py-2 align-middle"

type Facet = "active" | "archived" | "all"
type SortKey = "name" | "code" | "communities" | "projects"
type SortDir = "asc" | "desc"
type Sort = { key: SortKey; dir: SortDir }

const FACET_LABEL: Record<Facet, string> = { active: "Active", archived: "Archived", all: "All" }

function filterDivisions(divisions: DivisionDTO[], facet: Facet, query: string): DivisionDTO[] {
  const q = query.trim().toLowerCase()
  return divisions.filter((division) => {
    if (facet === "active" && division.archived) return false
    if (facet === "archived" && !division.archived) return false
    if (!q) return true
    return (
      division.name.toLowerCase().includes(q) ||
      (division.code?.toLowerCase().includes(q) ?? false) ||
      (division.region?.toLowerCase().includes(q) ?? false)
    )
  })
}

function sortDivisions(divisions: DivisionDTO[], sort: Sort): DivisionDTO[] {
  const factor = sort.dir === "asc" ? 1 : -1
  return [...divisions].sort((a, b) => {
    switch (sort.key) {
      case "name":
        return a.name.localeCompare(b.name) * factor
      case "code":
        return (a.code ?? "").localeCompare(b.code ?? "") * factor
      case "communities":
        return (a.communityCount - b.communityCount) * factor
      case "projects":
        return (a.activeProjectCount - b.activeProjectCount) * factor
      default:
        return 0
    }
  })
}

export function DivisionRoster({ divisions, canManage }: { divisions: DivisionDTO[]; canManage: boolean }) {
  const router = useRouter()
  const [items, setItems] = useState<DivisionDTO[]>(divisions)
  const [facet, setFacet] = useState<Facet>("active")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" })
  const [dialog, setDialog] = useState<{ open: boolean; editing: DivisionDTO | null }>({ open: false, editing: null })
  const [confirmArchive, setConfirmArchive] = useState<DivisionDTO | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, startSave] = useTransition()
  const [mutating, startMutate] = useTransition()

  const searchRef = useRef<HTMLInputElement>(null)
  const enteredRef = useRef(false)

  // Reconcile local state whenever the server re-renders with fresh data.
  useEffect(() => setItems(divisions), [divisions])

  useEffect(() => {
    if (!enteredRef.current) enteredRef.current = true
  }, [])

  const counts = useMemo(() => {
    let active = 0
    let archived = 0
    for (const division of items) {
      if (division.archived) archived += 1
      else active += 1
    }
    return { active, archived, all: items.length }
  }, [items])

  const visible = useMemo(() => sortDivisions(filterDivisions(items, facet, query), sort), [items, facet, query, sort])

  const totals = useMemo(() => {
    let communities = 0
    let projects = 0
    for (const division of visible) {
      communities += division.communityCount
      projects += division.activeProjectCount
    }
    return { communities, projects }
  }, [visible])

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }))

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.getAttribute("role") === "combobox")
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "/" && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === "Escape" && typing && query) {
        setQuery("")
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [query])

  // ---- mutations -----------------------------------------------------------
  const submitDialog = (values: { name: string; code: string; region: string }) => {
    startSave(async () => {
      const input = { name: values.name.trim(), code: values.code.trim() || null, region: values.region.trim() || null }
      try {
        if (dialog.editing) {
          const updated = unwrapAction(await updateDivisionAction(dialog.editing.id, input))
          setItems((prev) => prev.map((division) => (division.id === updated.id ? updated : division)))
          toast.success("Division updated")
        } else {
          const created = unwrapAction(await createDivisionAction(input))
          setItems((prev) => [created, ...prev])
          toast.success("Division created")
        }
        setDialog({ open: false, editing: null })
        router.refresh()
      } catch (error) {
        toast.error("Couldn't save division", { description: (error as Error).message })
      }
    })
  }

  const doArchive = (division: DivisionDTO) =>
    startMutate(async () => {
      setBusyId(division.id)
      try {
        unwrapAction(await archiveDivisionAction(division.id))
        setItems((prev) => prev.map((entry) => (entry.id === division.id ? { ...entry, archived: true } : entry)))
        toast.success(`${division.name} archived`, {
          action: { label: "Undo", onClick: () => doRestore(division) },
        })
      } catch (error) {
        toast.error("Couldn't archive division", { description: (error as Error).message })
      } finally {
        setBusyId(null)
        setConfirmArchive(null)
        router.refresh()
      }
    })

  const doRestore = (division: DivisionDTO) =>
    startMutate(async () => {
      setBusyId(division.id)
      try {
        unwrapAction(await restoreDivisionAction(division.id))
        setItems((prev) => prev.map((entry) => (entry.id === division.id ? { ...entry, archived: false } : entry)))
        toast.success(`${division.name} restored`, {
          action: { label: "Undo", onClick: () => doArchive(division) },
        })
      } catch (error) {
        toast.error("Couldn't restore division", { description: (error as Error).message })
      } finally {
        setBusyId(null)
        router.refresh()
      }
    })

  const openCreate = () => setDialog({ open: true, editing: null })
  const openEdit = (division: DivisionDTO) => setDialog({ open: true, editing: division })

  // ---- render --------------------------------------------------------------
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {/* Toolbar */}
        <div
          className={cn("flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2", !enteredRef.current && "desk-rise")}
          style={{ "--desk-stagger": 0 } as CSSProperties}
        >
          <InputGroup className="h-8 w-full sm:w-64">
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, code, region"
              aria-label="Search divisions"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => setQuery("")} aria-label="Clear search">
                  <XCircle className="size-3.5" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : (
              <InputGroupAddon align="inline-end">
                <Kbd>/</Kbd>
              </InputGroupAddon>
            )}
          </InputGroup>

          <ToggleGroup
            type="single"
            value={facet}
            onValueChange={(value) => value && setFacet(value as Facet)}
            variant="outline"
            size="sm"
            aria-label="Filter by status"
            className="h-8"
          >
            {(["active", "archived", "all"] as const).map((key) => (
              <ToggleGroupItem key={key} value={key} className="h-8 flex-none gap-1.5 px-3 text-xs">
                {FACET_LABEL[key]}
                <span className="tabular-nums text-muted-foreground">{counts[key]}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="flex-1" />

          {canManage ? (
            <Button size="sm" className="h-8 gap-1.5" onClick={openCreate}>
              <Plus className="size-3.5" />
              New division
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button size="sm" className="h-8 gap-1.5" disabled>
                    <Plus className="size-3.5" />
                    New division
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>You need division management access to add divisions.</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Table */}
        <div
          className={cn("relative flex min-h-0 flex-1 flex-col overflow-auto", !enteredRef.current && "desk-rise")}
          style={{ "--desk-stagger": 1 } as CSSProperties}
        >
          {visible.length === 0 ? (
            <DivisionsEmpty
              facet={facet}
              filtered={query.trim() !== ""}
              total={items.length}
              canManage={canManage}
              onCreate={openCreate}
              onClearFilters={() => {
                setQuery("")
                setFacet("active")
              }}
            />
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <SortHeader className="min-w-[220px] pl-4" label="Division" sortKey="name" sort={sort} onSort={toggleSort} />
                  <SortHeader className="hidden w-[140px] md:table-cell" label="Code" sortKey="code" sort={sort} onSort={toggleSort} />
                  <th className={cn(TH, "hidden md:table-cell")}>Region</th>
                  <SortHeader className="hidden w-[132px] md:table-cell" label="Communities" sortKey="communities" sort={sort} onSort={toggleSort} align="right" />
                  <SortHeader className="hidden w-[132px] md:table-cell" label="Active projects" sortKey="projects" sort={sort} onSort={toggleSort} align="right" />
                  <th className={cn(TH, "w-11 pr-4")}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((division) => (
                  <DivisionRow
                    key={division.id}
                    division={division}
                    canManage={canManage}
                    busy={busyId === division.id}
                    onEdit={openEdit}
                    onArchive={setConfirmArchive}
                    onRestore={doRestore}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {items.length > 0 ? (
          <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4">
            <span className="microlabel truncate">
              {visible.length} of {items.length} divisions · {totals.communities} communities · {totals.projects} active projects
            </span>
          </div>
        ) : null}
      </div>

      <DivisionDialog
        open={dialog.open}
        editing={dialog.editing}
        pending={saving}
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        onSubmit={submitDialog}
      />

      <ArchiveConfirm
        division={confirmArchive}
        pending={mutating}
        onCancel={() => setConfirmArchive(null)}
        onConfirm={() => confirmArchive && doArchive(confirmArchive)}
      />
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------

function SortHeader({
  className,
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  className?: string
  label: string
  sortKey: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
  align?: "right"
}) {
  const active = sort.key === sortKey
  return (
    <th
      className={cn(TH, align === "right" && "text-right", className)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1 text-inherit hover:text-foreground", align === "right" && "flex-row-reverse")}
      >
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  )
}

function DivisionRow({
  division,
  canManage,
  busy,
  onEdit,
  onArchive,
  onRestore,
}: {
  division: DivisionDTO
  canManage: boolean
  busy: boolean
  onEdit: (division: DivisionDTO) => void
  onArchive: (division: DivisionDTO) => void
  onRestore: (division: DivisionDTO) => void
}) {
  return (
    <tr
      onClick={() => canManage && onEdit(division)}
      className={cn(
        "group border-b border-border transition-colors duration-150",
        canManage && "cursor-pointer hover:bg-muted/40",
        division.archived && "text-muted-foreground",
        busy && "pointer-events-none opacity-60",
      )}
      aria-busy={busy || undefined}
    >
      <td className={cn(TD, "pl-4")}>
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-none bg-muted text-[10px] font-medium text-muted-foreground",
              division.archived && "opacity-70",
            )}
            aria-hidden
          >
            {division.code ? division.code.slice(0, 3) : <Layers className="size-3.5" />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-foreground">{division.name}</span>
              {division.archived ? <span className="microlabel shrink-0">Archived</span> : null}
            </div>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground md:hidden">
              {division.code ? <span className="font-mono">{division.code}</span> : null}
              {division.region ? (
                <>
                  {division.code ? <span aria-hidden>·</span> : null}
                  <span className="truncate">{division.region}</span>
                </>
              ) : null}
              {division.code || division.region ? <span aria-hidden>·</span> : null}
              <span className="whitespace-nowrap tabular-nums">
                {division.communityCount} comm · {division.activeProjectCount} active
              </span>
            </span>
          </div>
        </div>
      </td>

      <td className={cn(TD, "hidden md:table-cell")}>
        {division.code ? <span className="font-mono text-xs">{division.code}</span> : <span className="text-muted-foreground/70">—</span>}
      </td>

      <td className={cn(TD, "hidden text-sm md:table-cell")}>
        {division.region ? division.region : <span className="text-muted-foreground/70">—</span>}
      </td>

      <td className={cn(TD, "hidden text-right tabular-nums md:table-cell")}>
        {division.communityCount > 0 ? division.communityCount : <span className="text-muted-foreground/70">—</span>}
      </td>

      <td className={cn(TD, "hidden text-right tabular-nums md:table-cell")}>
        {division.activeProjectCount > 0 ? division.activeProjectCount : <span className="text-muted-foreground/70">—</span>}
      </td>

      <td className={cn(TD, "pr-4 text-right")} onClick={(event) => event.stopPropagation()}>
        {canManage ? <RowMenu division={division} onEdit={onEdit} onArchive={onArchive} onRestore={onRestore} /> : null}
      </td>
    </tr>
  )
}

function RowMenu({
  division,
  onEdit,
  onArchive,
  onRestore,
}: {
  division: DivisionDTO
  onEdit: (division: DivisionDTO) => void
  onArchive: (division: DivisionDTO) => void
  onRestore: (division: DivisionDTO) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Actions for {division.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(division)}>Edit division</DropdownMenuItem>
        {division.code ? (
          <DropdownMenuItem onSelect={() => navigator.clipboard?.writeText(division.code ?? "")}>Copy code</DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {division.archived ? (
          <DropdownMenuItem onSelect={() => onRestore(division)}>Restore division</DropdownMenuItem>
        ) : (
          <DropdownMenuItem className="text-destructive" onSelect={() => onArchive(division)}>
            Archive division
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DivisionDialog({
  open,
  editing,
  pending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  editing: DivisionDTO | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: { name: string; code: string; region: string }) => void
}) {
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [region, setRegion] = useState("")

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "")
      setCode(editing?.code ?? "")
      setRegion(editing?.region ?? "")
    }
  }, [open, editing])

  const canSave = name.trim().length > 0 && !pending
  const submit = () => {
    if (canSave) onSubmit({ name, code, region })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-sm font-medium">{editing ? "Edit division" : "New division"}</DialogTitle>
          <DialogDescription className="text-xs">
            A light operating scope for communities and projects. Divisions don&apos;t change tenant isolation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-5">
          <section className="space-y-2">
            <p className="microlabel">Name</p>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Southwest Florida"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </section>

          <div className="grid grid-cols-2 gap-4">
            <section className="space-y-2">
              <p className="microlabel">Code</p>
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                maxLength={8}
                placeholder="SWFL"
                className="font-mono"
              />
            </section>
            <section className="space-y-2">
              <p className="microlabel">Region</p>
              <Input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="Southwest Florida" />
            </section>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {pending ? "Saving…" : editing ? "Save changes" : "Create division"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ArchiveConfirm({
  division,
  pending,
  onCancel,
  onConfirm,
}: {
  division: DivisionDTO | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const blocked = division ? division.communityCount > 0 : false
  return (
    <AlertDialog open={division !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        {division ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive {division.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {blocked
                  ? `Move or archive this division's ${division.communityCount} ${division.communityCount === 1 ? "community" : "communities"} before archiving it.`
                  : "It stops appearing in pickers and rollups. Communities and projects keep their history, and you can restore it later."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault()
                  onConfirm()
                }}
                disabled={pending || blocked}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DivisionsEmpty({
  facet,
  filtered,
  total,
  canManage,
  onCreate,
  onClearFilters,
}: {
  facet: Facet
  filtered: boolean
  total: number
  canManage: boolean
  onCreate: () => void
  onClearFilters: () => void
}) {
  if (filtered) {
    return (
      <FullState
        icon={<Search />}
        title="No divisions match"
        description={`Try a different search, or clear filters to see all ${total}.`}
        action={
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    )
  }
  if (total === 0) {
    return (
      <FullState
        icon={<Layers />}
        title="No divisions yet"
        description="A single-market builder can leave this empty. Add a division when communities need regional, brand, or entity scope — it's an optional reporting layer and doesn't change tenant isolation."
        action={
          canManage ? (
            <Button size="sm" onClick={onCreate}>
              <Plus className="mr-1.5 size-3.5" />
              Add division
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">Ask an administrator to add divisions.</p>
          )
        }
      />
    )
  }
  const copy: Record<Facet, { title: string; description: string }> = {
    active: { title: "No active divisions", description: "Every division is archived. Switch to Archived or All to see them." },
    archived: { title: "No archived divisions", description: "Archived divisions keep their history but drop out of pickers and rollups." },
    all: { title: "No divisions", description: "Add your first division to get started." },
  }
  return <FullState icon={<Layers />} title={copy[facet].title} description={copy[facet].description} />
}

function FullState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <Empty className="min-h-0 flex-1 border-0 py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

export function DivisionRosterSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Skeleton className="h-8 w-full sm:w-64" />
        <Skeleton className="h-8 w-52" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex-1 overflow-hidden">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {Array.from({ length: 8 }).map((_, index) => (
              <tr key={index} className="border-b border-border">
                <td className={cn(TD, "pl-4")}>
                  <div className="flex items-center gap-2.5">
                    <Skeleton className="size-7" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                  </div>
                </td>
                <td className={cn(TD, "hidden md:table-cell")}>
                  <Skeleton className="h-3 w-16" />
                </td>
                <td className={cn(TD, "hidden md:table-cell")}>
                  <Skeleton className="h-3 w-28" />
                </td>
                <td className={cn(TD, "hidden md:table-cell")}>
                  <Skeleton className="ml-auto h-3 w-8" />
                </td>
                <td className={cn(TD, "hidden md:table-cell")}>
                  <Skeleton className="ml-auto h-3 w-8" />
                </td>
                <td className={cn(TD, "pr-4")} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
