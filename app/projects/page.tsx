import Link from "next/link"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Plus, Search, MoreHorizontal, FolderOpen } from "@/components/icons"
import type { ProjectStatus, Project } from "@/lib/types"
import { listProjectsAction } from "./actions"
import { getCurrentUserAction } from "../actions/user"
import { ProjectsClient } from "./projects-client"

const statusColors: Record<ProjectStatus, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<ProjectStatus, string> = {
  planning: "Planning",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
}

export default async function ProjectsPage() {
  const [projects, currentUser] = await Promise.all([listProjectsAction(), getCurrentUserAction()])
  const projectBadge = projects.filter((p) => p.status !== "completed" && p.status !== "cancelled").length

  return (
    <AppShell title="Projects" user={currentUser} badges={{ projects: projectBadge }}>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="hidden lg:block">
            <h1 className="text-2xl font-bold">Projects</h1>
            <p className="text-muted-foreground mt-1">Manage and track all your construction projects</p>
          </div>
          <Button className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search projects..." className="pl-9" />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              All
            </Button>
            <Button variant="ghost" size="sm">
              Active
            </Button>
            <Button variant="ghost" size="sm">
              Planning
            </Button>
            <Button variant="ghost" size="sm">
              Completed
            </Button>
          </div>
        </div>

        {/* Project grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className="group relative overflow-hidden">
              <CardContent className="p-0">
                {/* Project image placeholder */}
                <div className="aspect-video bg-muted flex items-center justify-center">
                  <FolderOpen className="h-12 w-12 text-muted-foreground/30" />
                </div>

                {/* Project info */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/projects/${project.id}`}
                        className="font-semibold hover:text-primary transition-colors line-clamp-1"
                      >
                        {project.name}
                      </Link>
                      {project.address && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-1">{project.address}</p>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem>Edit</DropdownMenuItem>
                        <DropdownMenuItem>Archive</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="flex items-center justify-between mt-4">
                    <Badge variant="outline" className={statusColors[project.status]}>
                      {statusLabels[project.status]}
                    </Badge>
                    {project.budget && <span className="text-sm font-medium">${project.budget.toLocaleString()}</span>}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Add project card */}
          <Card className="flex items-center justify-center border-dashed cursor-pointer hover:border-primary hover:bg-muted/50 transition-colors">
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                <Plus className="h-6 w-6" />
              </div>
              <p className="font-medium">Create New Project</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}
