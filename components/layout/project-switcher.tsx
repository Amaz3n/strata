"use client"

import { useMemo, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { ChevronsUpDown, FolderOpen, Loader2, Search } from "@/components/icons"
import { useIsNavigationPending, useOptimisticNavigate } from "@/lib/navigation/optimistic-pathname"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { ProjectNavigationItem } from "@/lib/types"
import { useSidebarProjects } from "./use-sidebar-projects"

function isArchived(status?: ProjectNavigationItem["status"]) {
  return status === "completed" || status === "cancelled"
}

function getProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

interface ProjectSwitcherProps {
  currentProjectId?: string
  currentProjectLabel?: string
}

export function ProjectSwitcher({ currentProjectId, currentProjectLabel }: ProjectSwitcherProps) {
  const navigate = useOptimisticNavigate()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState("")
  const isPending = useIsNavigationPending()
  const { projects, isLoading, loadError } = useSidebarProjects()

  const resolvedProjectId = currentProjectId ?? getProjectIdFromPath(pathname) ?? undefined

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(term))
  }, [projects, query])

  const activeProjects = filtered.filter((project) => !isArchived(project.status))
  const archivedProjects = filtered.filter((project) => isArchived(project.status))

  const currentLabel =
    currentProjectLabel ??
    projects.find((project) => project.id === resolvedProjectId)?.name ??
    "Select project"

  const displayLabel = !isLoading && projects.length === 0 ? "No projects" : currentLabel

  const handleSelect = (projectId: string) => {
    const targetPath = (() => {
      const id = resolvedProjectId
      if (!id) return `/projects/${projectId}`

      const nextPath = pathname.replace(`/projects/${id}`, `/projects/${projectId}`)
      return nextPath
    })()

    const search = searchParams.toString()
    navigate(search ? `${targetPath}?${search}` : targetPath)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-foreground/80">
        <span className="truncate max-w-[160px]">{displayLabel}</span>
        {isPending || isLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-2">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Switch project
        </DropdownMenuLabel>
        <div className="relative px-2 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") return
                e.stopPropagation()
              }}
              placeholder="Find a project..."
              className="pl-8 h-8"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-auto px-2">
          {activeProjects.length > 0 && (
            <div className="space-y-1">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Active projects
              </p>
              {activeProjects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  className="flex items-center gap-2"
                  onSelect={() => handleSelect(project.id)}
                >
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{project.name}</span>
                  {project.id === resolvedProjectId && (
                    <span className="ml-auto text-[10px] text-muted-foreground">Current</span>
                  )}
                </DropdownMenuItem>
              ))}
            </div>
          )}
          {archivedProjects.length > 0 && (
            <div className="space-y-1 pt-3">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Archived projects
              </p>
              {archivedProjects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  className="flex items-center gap-2 text-muted-foreground"
                  onSelect={() => handleSelect(project.id)}
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="truncate">{project.name}</span>
                </DropdownMenuItem>
              ))}
            </div>
          )}
          {loadError && (
            <div className="px-2 py-3 text-xs text-destructive whitespace-pre-wrap">
              {loadError}
            </div>
          )}
          {!isLoading && !loadError && filtered.length === 0 && (
            <div className="px-2 py-3 text-sm text-muted-foreground">No projects found.</div>
          )}
        </div>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem onSelect={() => navigate("/projects")} className="text-sm">
          All Projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
