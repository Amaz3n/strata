"use client"

import { useState, useEffect } from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Plus, Search, MoreHorizontal, FolderOpen } from "@/components/icons"
import { toast } from 'sonner'
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { Project, ProjectStatus } from "@/lib/types"
import { createProjectAction } from "./actions"
import { projectInputSchema } from "@/lib/validation/projects"
import type { ProjectInput } from "@/lib/validation/projects"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { GooglePlacesAutocomplete } from "@/components/ui/google-places-autocomplete"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import { DateRange } from "react-day-picker"

const statusColors: Record<ProjectStatus, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  bidding: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<ProjectStatus, string> = {
  planning: "Planning",
  bidding: "Bidding",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
}

const statusOptions = [
  { value: "planning", label: "Planning" },
  { value: "bidding", label: "Bidding" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On Hold" },
]

interface ProjectsClientProps {
  projects: Project[]
}

export function ProjectsClient({ projects }: ProjectsClientProps) {
  const [projectsState, setProjectsState] = useState<Project[]>(projects)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dateRange, setDateRange] = useState<DateRange | undefined>()

  const createForm = useForm<ProjectInput>({
    resolver: zodResolver(projectInputSchema),
    defaultValues: {
      name: "",
      status: "active",
      start_date: "",
      end_date: "",
      address: "",
      total_value: undefined,
      property_type: undefined,
      project_type: undefined,
      description: "",
    },
  })

  // Sync dateRange with form values
  useEffect(() => {
    if (dateRange?.from) {
      createForm.setValue("start_date", dateRange.from.toISOString().split('T')[0])
    } else {
      createForm.setValue("start_date", "")
    }

    if (dateRange?.to) {
      createForm.setValue("end_date", dateRange.to.toISOString().split('T')[0])
    } else {
      createForm.setValue("end_date", "")
    }
  }, [dateRange, createForm])

  async function handleCreate(values: ProjectInput) {
    setIsSubmitting(true)
    try {
      const created = await createProjectAction(values)
      setProjectsState((prev) => [created, ...prev])
      createForm.reset({
        name: "",
        status: "active",
        start_date: "",
        end_date: "",
        address: "",
        total_value: undefined,
        property_type: undefined,
        project_type: undefined,
        description: "",
      })
      setDateRange(undefined)
      toast.success("Project created", { description: created.name })
      setSheetOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Error creating project", { description: "Please try again." })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search projects..." className="pl-9" />
        </div>
        <div className="hidden sm:flex gap-2">
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
        <div className="flex items-center gap-2 sm:ml-auto">
          <Button
            onClick={() => setSheetOpen(true)}
            className="w-full sm:w-auto"
          >
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        </div>
      </div>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>

        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
          style={{
            animationDuration: '150ms',
            transitionDuration: '150ms'
          } as React.CSSProperties}
        >
          <div className="flex-1 overflow-y-auto px-4">
            <div className="pt-6 pb-4">
              <SheetTitle className="text-lg font-semibold leading-none tracking-tight">New project</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">Set up a new construction project to get started.</SheetDescription>
            </div>
            <Form {...createForm}>
              <form onSubmit={createForm.handleSubmit(handleCreate)} className="space-y-4">
                <FormField
                  control={createForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project name</FormLabel>
                      <FormControl>
                        <Input placeholder="Oakwood Residence" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {statusOptions.map((status) => (
                            <SelectItem key={status.value} value={status.value}>
                              {status.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="start_date"
                  render={() => (
                    <FormItem>
                      <FormLabel>Project dates</FormLabel>
                      <FormControl>
                        <DateRangePicker
                          dateRange={dateRange}
                          onDateRangeChange={setDateRange}
                          placeholder="Select start and end dates"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <GooglePlacesAutocomplete
                          value={field.value}
                          onChange={field.onChange}
                          placeholder="123 Main St, City, State"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="total_value"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Total Value</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder="$50,000"
                          className="font-mono"
                          {...field}
                          value={field.value ? `$${field.value.toLocaleString()}` : ""}
                          onChange={(e) => {
                            const value = e.target.value.replace(/[^\d.-]/g, '');
                            const numValue = value ? parseFloat(value) : undefined;
                            field.onChange(numValue && !isNaN(numValue) ? numValue : undefined);
                          }}
                          onFocus={(e) => {
                            // Remove formatting on focus for easier editing
                            const numericValue = field.value;
                            e.target.value = numericValue ? numericValue.toString() : '';
                          }}
                          onBlur={(e) => {
                            // Re-apply formatting on blur
                            const numericValue = field.value;
                            e.target.value = numericValue ? `$${numericValue.toLocaleString()}` : '';
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={createForm.control}
                    name="property_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Property Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select property type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="residential">Residential</SelectItem>
                            <SelectItem value="commercial">Commercial</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="project_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select project type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="new_construction">New Construction</SelectItem>
                            <SelectItem value="remodel">Remodel</SelectItem>
                            <SelectItem value="addition">Addition</SelectItem>
                            <SelectItem value="renovation">Renovation</SelectItem>
                            <SelectItem value="repair">Repair</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={createForm.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Project description..."
                          className="resize-none"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </form>
            </Form>
          </div>
          <div className="flex-shrink-0 border-t bg-background p-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  createForm.reset({
                    name: "",
                    status: "active",
                    start_date: "",
                    end_date: "",
                    address: "",
                    total_value: undefined,
                    property_type: undefined,
                    project_type: undefined,
                    description: "",
                  })
                  setDateRange(undefined)
                  setSheetOpen(false)
                }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                className="flex-1"
                onClick={createForm.handleSubmit(handleCreate)}
              >
                {isSubmitting ? "Creating..." : "Create project"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: Card layout */}
      <div className="md:hidden space-y-3">
        {projectsState.map((project) => (
          <Link
            key={project.id}
            href={`/projects/${project.id}`}
            className="block rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 active:bg-muted"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold truncate">{project.name}</span>
                  <Badge variant="outline" className={statusColors[project.status]}>
                    {statusLabels[project.status]}
                  </Badge>
                </div>
                {project.address && (
                  <p className="text-sm text-muted-foreground mt-1 truncate">
                    {project.address}
                  </p>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.preventDefault()}>
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
          </Link>
        ))}
        {projectsState.length === 0 && (
          <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <FolderOpen className="h-6 w-6" />
              </div>
              <div>
                <p className="font-medium">No projects yet</p>
                <p className="text-sm">Create your first project to get started.</p>
              </div>
              <Button onClick={() => setSheetOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create New Project
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Desktop: Table layout */}
      <div className="hidden md:block rounded-lg border px-6 py-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[300px]">Project</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projectsState.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link
                    href={`/projects/${project.id}`}
                    className="font-semibold hover:text-primary transition-colors"
                  >
                    {project.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {project.address || "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusColors[project.status]}>
                    {statusLabels[project.status]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {project.start_date && project.end_date
                    ? `${new Date(project.start_date).toLocaleDateString()} - ${new Date(project.end_date).toLocaleDateString()}`
                    : project.start_date
                    ? `Starts ${new Date(project.start_date).toLocaleDateString()}`
                    : project.end_date
                    ? `Ends ${new Date(project.end_date).toLocaleDateString()}`
                    : "—"
                  }
                </TableCell>
                <TableCell className="text-right font-medium">
                  {project.budget ? `$${project.budget.toLocaleString()}` : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
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
                </TableCell>
              </TableRow>
            ))}
            {projectsState.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <FolderOpen className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No projects yet</p>
                      <p className="text-sm">Create your first project to get started.</p>
                    </div>
                    <Button onClick={() => setSheetOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create New Project
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
