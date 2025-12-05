"use client"

import { useState, useEffect, useCallback } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { format } from "date-fns"
import { cn } from "@/lib/utils"
import type { ScheduleItem, Project } from "@/lib/types"
import { 
  scheduleItemInputSchema, 
  type ScheduleItemInput,
  scheduleItemTypes,
  scheduleStatuses,
  constructionPhases,
  constructionTrades,
  scheduleColors,
  constraintTypes,
} from "@/lib/validation/schedule"
import { useSchedule } from "./schedule-context"
import { PHASE_COLORS, parseDate, toDateString } from "./types"
import { getProjectAssignableResourcesAction, type AssignableResource } from "@/app/projects/[id]/actions"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from "@/components/ui/select"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  CalendarDays,
  Clock,
  Flag,
  CheckSquare,
  ClipboardCheck,
  ArrowRightLeft,
  Layers,
  Truck,
  Link2,
  Palette,
  AlertTriangle,
  Trash2,
  User,
  Users,
  Building2,
} from "lucide-react"
import { DateRange } from "react-day-picker"

interface ScheduleItemSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item?: ScheduleItem | null
  projectId: string
  onSave?: (item: ScheduleItem) => void
  onDelete?: (id: string) => void
  initialDates?: { start: Date; end: Date } | null
  /** Optional projects list for master schedule view - enables project selection */
  projects?: Project[]
}

// Icons for item types
const itemTypeIcons: Record<string, typeof CheckSquare> = {
  task: CheckSquare,
  milestone: Flag,
  inspection: ClipboardCheck,
  handoff: ArrowRightLeft,
  phase: Layers,
  delivery: Truck,
}

export function ScheduleItemSheet({
  open,
  onOpenChange,
  item,
  projectId,
  onSave,
  onDelete,
  initialDates,
  projects,
}: ScheduleItemSheetProps) {
  const { items, onItemCreate, onItemUpdate, onItemDelete, isLoading } = useSchedule()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dateRange, setDateRange] = useState<DateRange | undefined>()
  const [assignableResources, setAssignableResources] = useState<AssignableResource[]>([])
  const [loadingResources, setLoadingResources] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projectId)

  const isEditing = !!item
  const isMasterScheduleMode = !!projects && projects.length > 0
  const activeProjectId = isEditing ? item.project_id : selectedProjectId

  // Update selected project when projectId prop changes
  useEffect(() => {
    if (!isEditing) {
      setSelectedProjectId(projectId)
    }
  }, [projectId, isEditing])

  // Load assignable resources when sheet opens
  useEffect(() => {
    if (open && activeProjectId) {
      setLoadingResources(true)
      getProjectAssignableResourcesAction(activeProjectId)
        .then(setAssignableResources)
        .catch(console.error)
        .finally(() => setLoadingResources(false))
    }
  }, [open, activeProjectId])

  // Group resources by type for display
  const groupedResources = {
    users: assignableResources.filter(r => r.type === "user"),
    contacts: assignableResources.filter(r => r.type === "contact"),
    companies: assignableResources.filter(r => r.type === "company"),
  }

  // Get selected resource info for display
  const getSelectedResource = (id: string | undefined) => {
    if (!id) return null
    return assignableResources.find(r => r.id === id)
  }

  // Get initials for avatar
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2)
  }

  const form = useForm<ScheduleItemInput>({
    resolver: zodResolver(scheduleItemInputSchema),
    defaultValues: {
      project_id: activeProjectId,
      name: "",
      item_type: "task",
      status: "planned",
      progress: 0,
      phase: undefined,
      trade: undefined,
      constraint_type: "asap",
      is_critical_path: false,
    },
  })

  // Reset form when item or initialDates changes
  useEffect(() => {
    if (item) {
      form.reset({
        project_id: item.project_id,
        name: item.name,
        item_type: item.item_type,
        status: item.status,
        start_date: item.start_date || "",
        end_date: item.end_date || "",
        progress: item.progress || 0,
        assigned_to: item.assigned_to,
        phase: item.phase || undefined,
        trade: item.trade || undefined,
        location: item.location || undefined,
        planned_hours: item.planned_hours || undefined,
        constraint_type: item.constraint_type || "asap",
        is_critical_path: item.is_critical_path || false,
        color: item.color || undefined,
        notes: item.metadata?.notes || "",
        dependencies: item.dependencies || [],
      })

      const startDate = parseDate(item.start_date)
      const endDate = parseDate(item.end_date)
      if (startDate) {
        setDateRange({ from: startDate, to: endDate || startDate })
      }
    } else {
      form.reset({
        project_id: activeProjectId,
        name: "",
        item_type: "task",
        status: "planned",
        progress: 0,
        phase: undefined,
        trade: undefined,
        constraint_type: "asap",
        is_critical_path: false,
      })
      // If initialDates provided (from quick add), use those
      if (initialDates) {
        setDateRange({ from: initialDates.start, to: initialDates.end })
      } else {
        setDateRange(undefined)
      }
    }
  }, [item, activeProjectId, form, initialDates])

  // Update form project_id when selected project changes
  useEffect(() => {
    if (!isEditing && selectedProjectId) {
      form.setValue("project_id", selectedProjectId)
    }
  }, [selectedProjectId, isEditing, form])

  // Handle form submission
  async function handleSubmit(values: ScheduleItemInput) {
    setIsSubmitting(true)
    try {
      const formattedValues = {
        ...values,
        start_date: dateRange?.from ? toDateString(dateRange.from) : "",
        end_date: dateRange?.to ? toDateString(dateRange.to) : "",
      }

      if (isEditing && item) {
        await onItemUpdate(item.id, formattedValues)
      } else {
        await onItemCreate(formattedValues)
      }
      
      onOpenChange(false)
    } catch (error) {
      console.error("Failed to save schedule item:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Handle delete
  async function handleDelete() {
    if (!item) return
    
    setIsSubmitting(true)
    try {
      await onItemDelete(item.id)
      onOpenChange(false)
    } catch (error) {
      console.error("Failed to delete schedule item:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Get other items for dependencies (excluding current item)
  const availableDependencies = items.filter((i) => i.id !== item?.id)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            {isEditing ? (
              <>
                <CheckSquare className="h-5 w-5" />
                Edit Schedule Item
              </>
            ) : (
              <>
                <CalendarDays className="h-5 w-5" />
                New Schedule Item
              </>
            )}
          </SheetTitle>
          <SheetDescription>
            {isEditing 
              ? "Update the details of this schedule item."
              : "Add a new task, milestone, or inspection to the schedule."
            }
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="flex-1 flex flex-col overflow-hidden">
            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-6">
                {/* Project Selector - Only show in master schedule mode for new items */}
                {isMasterScheduleMode && !isEditing && (
                  <FormItem>
                    <FormLabel>Project</FormLabel>
                    <Select
                      value={selectedProjectId}
                      onValueChange={(value) => setSelectedProjectId(value)}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a project" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {projects?.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-muted-foreground" />
                              <span>{project.name}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}

                {/* Show project name when editing */}
                {isMasterScheduleMode && isEditing && item && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {projects?.find(p => p.id === item.project_id)?.name || "Unknown Project"}
                    </span>
                  </div>
                )}

                {/* Name */}
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Rough-in inspection" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Type, Status, and Phase */}
                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="item_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {scheduleItemTypes.map((type) => {
                              const Icon = itemTypeIcons[type] || CheckSquare
                              return (
                                <SelectItem key={type} value={type}>
                                  <div className="flex items-center gap-2">
                                    <Icon className="h-4 w-4" />
                                    <span className="capitalize">{type}</span>
                                  </div>
                                </SelectItem>
                              )
                            })}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
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
                            {scheduleStatuses.map((status) => (
                              <SelectItem key={status} value={status}>
                                <span className="capitalize">{status.replace(/_/g, " ")}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="phase"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phase</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === "__none__" ? undefined : value)}
                          value={field.value || "__none__"}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select phase" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {constructionPhases.map((phase) => (
                              <SelectItem key={phase} value={phase}>
                                <div className="flex items-center gap-2">
                                  <div
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{ backgroundColor: PHASE_COLORS[phase] }}
                                  />
                                  <span className="capitalize">{phase.replace(/_/g, " ")}</span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Date Range */}
                <FormItem>
                  <FormLabel>Date Range</FormLabel>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !dateRange?.from && "text-muted-foreground"
                        )}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {dateRange?.from ? (
                          dateRange.to ? (
                            <>
                              {format(dateRange.from, "LLL dd, y")} – {format(dateRange.to, "LLL dd, y")}
                            </>
                          ) : (
                            format(dateRange.from, "LLL dd, y")
                          )
                        ) : (
                          <span>Pick date range</span>
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        initialFocus
                        mode="range"
                        defaultMonth={dateRange?.from}
                        selected={dateRange}
                        onSelect={setDateRange}
                        numberOfMonths={2}
                      />
                    </PopoverContent>
                  </Popover>
                </FormItem>

                {/* Assign To and Trade */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="assigned_to"
                    render={({ field }) => {
                      const selected = getSelectedResource(field.value)
                      return (
                        <FormItem>
                          <FormLabel>Assign To</FormLabel>
                          <Select
                            onValueChange={(value) => field.onChange(value === "__none__" ? undefined : value)}
                            value={field.value || "__none__"}
                          >
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Select assignee">
                                  {selected ? (
                                    <div className="flex items-center gap-2">
                                      <Avatar className="h-5 w-5">
                                        <AvatarImage src={selected.avatar_url} />
                                        <AvatarFallback className="text-[10px]">
                                          {selected.type === "company" ? <Building2 className="h-3 w-3" /> : getInitials(selected.name)}
                                        </AvatarFallback>
                                      </Avatar>
                                      <span className="truncate">{selected.name}</span>
                                    </div>
                                  ) : (
                                    "Select assignee"
                                  )}
                                </SelectValue>
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="__none__">
                                <span className="text-muted-foreground">Unassigned</span>
                              </SelectItem>

                              {groupedResources.users.length > 0 && (
                                <SelectGroup>
                                  <SelectLabel className="flex items-center gap-2">
                                    <User className="h-3 w-3" />
                                    Team Members
                                  </SelectLabel>
                                  {groupedResources.users.map((resource) => (
                                    <SelectItem key={resource.id} value={resource.id}>
                                      <div className="flex items-center gap-2">
                                        <Avatar className="h-5 w-5">
                                          <AvatarImage src={resource.avatar_url} />
                                          <AvatarFallback className="text-[10px]">
                                            {getInitials(resource.name)}
                                          </AvatarFallback>
                                        </Avatar>
                                        <div className="flex flex-col">
                                          <span>{resource.name}</span>
                                          {resource.role && (
                                            <span className="text-[10px] text-muted-foreground">{resource.role}</span>
                                          )}
                                        </div>
                                      </div>
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              )}

                              {groupedResources.contacts.length > 0 && (
                                <SelectGroup>
                                  <SelectLabel className="flex items-center gap-2">
                                    <Users className="h-3 w-3" />
                                    Contacts / Subcontractors
                                  </SelectLabel>
                                  {groupedResources.contacts.map((resource) => (
                                    <SelectItem key={resource.id} value={resource.id}>
                                      <div className="flex items-center gap-2">
                                        <Avatar className="h-5 w-5">
                                          <AvatarFallback className="text-[10px]">
                                            {getInitials(resource.name)}
                                          </AvatarFallback>
                                        </Avatar>
                                        <div className="flex flex-col">
                                          <span>{resource.name}</span>
                                          {resource.company_name && (
                                            <span className="text-[10px] text-muted-foreground">{resource.company_name}</span>
                                          )}
                                        </div>
                                      </div>
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              )}

                              {groupedResources.companies.length > 0 && (
                                <SelectGroup>
                                  <SelectLabel className="flex items-center gap-2">
                                    <Building2 className="h-3 w-3" />
                                    Companies / Crews
                                  </SelectLabel>
                                  {groupedResources.companies.map((resource) => (
                                    <SelectItem key={resource.id} value={resource.id}>
                                      <div className="flex items-center gap-2">
                                        <Avatar className="h-5 w-5">
                                          <AvatarFallback className="text-[10px] bg-primary/10">
                                            <Building2 className="h-3 w-3" />
                                          </AvatarFallback>
                                        </Avatar>
                                        <div className="flex flex-col">
                                          <span>{resource.name}</span>
                                          {resource.role && (
                                            <span className="text-[10px] text-muted-foreground">{resource.role}</span>
                                          )}
                                        </div>
                                      </div>
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              )}

                              {loadingResources && (
                                <div className="p-2 text-center text-sm text-muted-foreground">
                                  Loading...
                                </div>
                              )}

                              {!loadingResources && assignableResources.length === 0 && (
                                <div className="p-2 text-center text-sm text-muted-foreground">
                                  No team members or contacts found. Add them in the Team tab.
                                </div>
                              )}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )
                    }}
                  />

                  <FormField
                    control={form.control}
                    name="trade"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Trade</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === "__none__" ? undefined : value)}
                          value={field.value || "__none__"}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select trade" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {constructionTrades.map((trade) => (
                              <SelectItem key={trade} value={trade}>
                                <span className="capitalize">{trade.replace(/_/g, " ")}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Progress - Only show when editing */}
                {isEditing && (
                  <FormField
                    control={form.control}
                    name="progress"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Progress</FormLabel>
                          <span className="text-sm font-medium">{field.value}%</span>
                        </div>
                        <FormControl>
                          <Slider
                            value={[field.value || 0]}
                            onValueChange={([value]) => field.onChange(value)}
                            max={100}
                            step={5}
                            className="py-2"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}


                {/* Advanced Options */}
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="advanced">
                    <AccordionTrigger className="text-sm">
                      Advanced Options
                    </AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      {/* Location */}
                      <FormField
                        control={form.control}
                        name="location"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Location</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g., Building A, Floor 2" {...field} value={field.value || ""} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Planned Hours */}
                      <FormField
                        control={form.control}
                        name="planned_hours"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Planned Hours</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="e.g., 8" 
                                {...field}
                                value={field.value || ""}
                                onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Color */}
                      <FormField
                        control={form.control}
                        name="color"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-2">
                              <Palette className="h-4 w-4" />
                              Color
                            </FormLabel>
                            <div className="flex gap-2 flex-wrap">
                              {scheduleColors.map((color) => (
                                <button
                                  key={color}
                                  type="button"
                                  className={cn(
                                    "w-7 h-7 rounded-full border-2 transition-transform hover:scale-110",
                                    field.value === color ? "border-foreground scale-110" : "border-transparent"
                                  )}
                                  style={{ backgroundColor: color }}
                                  onClick={() => field.onChange(color)}
                                />
                              ))}
                              <button
                                type="button"
                                className={cn(
                                  "w-7 h-7 rounded-full border-2 border-dashed transition-transform hover:scale-110",
                                  !field.value ? "border-foreground" : "border-muted-foreground"
                                )}
                                onClick={() => field.onChange(undefined)}
                              >
                                <span className="sr-only">Auto</span>
                              </button>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Critical Path */}
                      <FormField
                        control={form.control}
                        name="is_critical_path"
                        render={({ field }) => (
                          <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
                            <FormControl>
                              <Checkbox
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                            <div className="space-y-1 leading-none">
                              <FormLabel className="flex items-center gap-2">
                                <AlertTriangle className="h-4 w-4 text-orange-500" />
                                Critical Path Item
                              </FormLabel>
                              <FormDescription>
                                Mark if this item affects the project end date
                              </FormDescription>
                            </div>
                          </FormItem>
                        )}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="dependencies">
                    <AccordionTrigger className="text-sm">
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4" />
                        Dependencies
                        {form.watch("dependencies")?.length ? (
                          <Badge variant="secondary" className="ml-2">
                            {form.watch("dependencies")?.length}
                          </Badge>
                        ) : null}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <FormField
                        control={form.control}
                        name="dependencies"
                        render={({ field }) => (
                          <FormItem>
                            <FormDescription className="mb-3">
                              Select items that must be completed before this one can start.
                            </FormDescription>
                            <ScrollArea className="h-48 rounded-md border p-2">
                              <div className="space-y-2">
                                {availableDependencies.map((depItem) => (
                                  <Label
                                    key={depItem.id}
                                    className="flex items-center gap-2 text-sm font-normal cursor-pointer p-2 rounded hover:bg-muted"
                                  >
                                    <Checkbox
                                      checked={field.value?.includes(depItem.id)}
                                      onCheckedChange={(checked) => {
                                        const current = field.value ?? []
                                        const next = checked
                                          ? [...current, depItem.id]
                                          : current.filter((id) => id !== depItem.id)
                                        field.onChange(next)
                                      }}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <span className="truncate block">{depItem.name}</span>
                                      <span className="text-xs text-muted-foreground capitalize">
                                        {depItem.item_type} • {depItem.status.replace(/_/g, " ")}
                                      </span>
                                    </div>
                                  </Label>
                                ))}
                                {availableDependencies.length === 0 && (
                                  <p className="text-sm text-muted-foreground text-center py-4">
                                    No other items available
                                  </p>
                                )}
                              </div>
                            </ScrollArea>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="notes">
                    <AccordionTrigger className="text-sm">Notes</AccordionTrigger>
                    <AccordionContent>
                      <FormField
                        control={form.control}
                        name="notes"
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Textarea
                                placeholder="Add any notes or details..."
                                className="min-h-[100px] resize-none"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </ScrollArea>

            {/* Footer */}
            <div className="flex-shrink-0 border-t bg-muted/30 p-4">
              <div className="flex gap-2">
                {isEditing && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={handleDelete}
                    disabled={isSubmitting}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  className="flex-1"
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1"
                >
                  {isSubmitting ? "Saving..." : isEditing ? "Save Changes" : "Create Item"}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}

