"use client"

import { useState, useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { format } from "date-fns"
import { cn } from "@/lib/utils"
import type { ScheduleItem, Project, ScheduleItemChangeOrder, DrawSchedule, CostCode } from "@/lib/types"
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
import { getProjectAssignableResourcesAction, type AssignableResource } from "@/app/(app)/projects/[id]/actions"
import { setScheduleAssigneeAction } from "@/app/(app)/schedule/assignment-actions"
import { inspectionMetadataSchema, type InspectionChecklistItem, type InspectionResult } from "@/lib/validation/inspections"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { listAttachmentsAction, detachFileLinkAction, uploadFileAction, attachFileAction } from "@/app/(app)/files/actions"
import { listCostCodesAction } from "@/app/(app)/settings/cost-codes/actions"
import { ChangeOrderImpactBadge } from "./change-order-impact-badge"
import { DrawMilestoneOverlay } from "./draw-milestone-overlay"
import { CostCodeSelector } from "./cost-code-selector"
import { formatAmount } from "@/components/midday/format-amount"
import { useIsMobile } from "@/hooks/use-mobile"

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
  FileText,
  DollarSign,
  ChevronRight,
  ExternalLink,
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
  const isMobile = useIsMobile()
  const { items, onItemCreate, onItemUpdate, onItemDelete, isLoading } = useSchedule()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dateRange, setDateRange] = useState<DateRange | undefined>()
  const [assignableResources, setAssignableResources] = useState<AssignableResource[]>([])
  const [loadingResources, setLoadingResources] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projectId)
  const [inspectionResult, setInspectionResult] = useState<InspectionResult>("pending")
  const [inspectionNotes, setInspectionNotes] = useState("")
  const [inspectionChecklist, setInspectionChecklist] = useState<InspectionChecklistItem[]>([])
  const [inspectionSignedBy, setInspectionSignedBy] = useState("")
  const [inspectionSignedAt, setInspectionSignedAt] = useState<string | undefined>(undefined)
  const [inspectionAttachments, setInspectionAttachments] = useState<AttachedFile[]>([])
  const [inspectionAttachmentsLoading, setInspectionAttachmentsLoading] = useState(false)
  const [shareInspectionAttachmentsWithClients, setShareInspectionAttachmentsWithClients] = useState(false)
  const [newChecklistItem, setNewChecklistItem] = useState("")

  // CO/Draw integration state
  const [changeOrderImpacts, setChangeOrderImpacts] = useState<ScheduleItemChangeOrder[]>([])
  const [linkedDraws, setLinkedDraws] = useState<DrawSchedule[]>([])
  const [loadingCOData, setLoadingCOData] = useState(false)

  // Cost code state
  const [costCodes, setCostCodes] = useState<CostCode[]>([])
  const [loadingCostCodes, setLoadingCostCodes] = useState(false)

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

  // Load cost codes when sheet opens
  useEffect(() => {
    if (open) {
      setLoadingCostCodes(true)
      listCostCodesAction()
        .then(setCostCodes)
        .catch(console.error)
        .finally(() => setLoadingCostCodes(false))
    }
  }, [open])

  // Group resources by type for display
  const groupedResources = {
    users: assignableResources.filter(r => r.type === "user"),
    contacts: assignableResources.filter(r => r.type === "contact"),
    companies: assignableResources.filter(r => r.type === "company"),
  }

  // Get selected resource info for display
  const getSelectedResource = (value: string | undefined) => {
    if (!value) return null
    const [type, id] = value.split(":")
    return assignableResources.find((r) => r.id === id && r.type === type)
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
        assigned_to: item.assigned_to ? `user:${item.assigned_to}` : undefined,
        phase: item.phase || undefined,
        trade: item.trade || undefined,
        location: item.location || undefined,
        planned_hours: item.planned_hours || undefined,
        constraint_type: item.constraint_type || "asap",
        is_critical_path: item.is_critical_path || false,
        color: item.color || undefined,
        notes: item.metadata?.notes || "",
        dependencies: item.dependencies || [],
        // Cost tracking fields
        cost_code_id: item.cost_code_id || undefined,
        budget_cents: item.budget_cents || undefined,
        actual_cost_cents: item.actual_cost_cents || undefined,
      })

      const startDate = parseDate(item.start_date)
      const endDate = parseDate(item.end_date)
      if (startDate) {
        setDateRange({ from: startDate, to: endDate || startDate })
      }

      const inspectionMeta = inspectionMetadataSchema.safeParse((item.metadata as any)?.inspection ?? {})
      if (item.item_type === "inspection" && inspectionMeta.success) {
        setInspectionResult(inspectionMeta.data.result)
        setInspectionNotes(inspectionMeta.data.notes ?? "")
        setInspectionChecklist(inspectionMeta.data.checklist ?? [])
        setInspectionSignedBy(inspectionMeta.data.signed_by ?? "")
        setInspectionSignedAt(inspectionMeta.data.signed_at ?? undefined)
      } else {
        setInspectionResult("pending")
        setInspectionNotes("")
        setInspectionChecklist([])
        setInspectionSignedBy("")
        setInspectionSignedAt(undefined)
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

      setInspectionResult("pending")
      setInspectionNotes("")
      setInspectionChecklist([])
      setInspectionSignedBy("")
      setInspectionSignedAt(undefined)
    }
  }, [item, activeProjectId, form, initialDates])

  const isInspection = form.watch("item_type") === "inspection"

  useEffect(() => {
    if (!open || !isEditing || !item || !isInspection) return
    setInspectionAttachmentsLoading(true)
    listAttachmentsAction("schedule_item", item.id)
      .then((links) =>
        setInspectionAttachments(
          links.map((link) => ({
            id: link.file.id,
            linkId: link.id,
            file_name: link.file.file_name,
            mime_type: link.file.mime_type,
            size_bytes: link.file.size_bytes,
            download_url: link.file.download_url,
            thumbnail_url: link.file.thumbnail_url,
            created_at: link.created_at,
            link_role: link.link_role,
          })),
        ),
      )
      .catch((error) => console.error("Failed to load inspection attachments", error))
      .finally(() => setInspectionAttachmentsLoading(false))
  }, [open, isEditing, item, isInspection])

  // Load CO impacts and linked draws when editing
  useEffect(() => {
    if (!open || !isEditing || !item) {
      setChangeOrderImpacts([])
      setLinkedDraws([])
      return
    }

    setLoadingCOData(true)

    // Fetch CO impacts for this schedule item
    const fetchCOData = async () => {
      try {
        const response = await fetch(`/api/schedule/${item.id}/impacts`)
        if (response.ok) {
          const data = await response.json()
          setChangeOrderImpacts(data.impacts ?? [])
          setLinkedDraws(data.draws ?? [])
        }
      } catch (error) {
        console.error("Failed to load CO/Draw data:", error)
      } finally {
        setLoadingCOData(false)
      }
    }

    fetchCOData()
  }, [open, isEditing, item])

  // Helper for CO impact totals
  const coImpactTotals = {
    total: changeOrderImpacts.reduce((sum, co) => sum + (co.days_adjusted ?? 0), 0),
    pending: changeOrderImpacts
      .filter((co) => !co.applied_at)
      .reduce((sum, co) => sum + (co.days_adjusted ?? 0), 0),
    applied: changeOrderImpacts
      .filter((co) => co.applied_at)
      .reduce((sum, co) => sum + (co.days_adjusted ?? 0), 0),
  }

  const isMilestone = form.watch("item_type") === "milestone"

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

      const assigneeValue = formattedValues.assigned_to as string | undefined
      let assignee: { type: "user" | "contact" | "company"; id: string } | null = null
      if (assigneeValue && assigneeValue !== "__none__") {
        const [type, id] = assigneeValue.split(":")
        if (type === "user" || type === "contact" || type === "company") {
          assignee = { type, id }
        }
      }

      const existingMetadata = isEditing && item ? (item.metadata ?? {}) : {}
      const selectedAssignee = assigneeValue ? getSelectedResource(assigneeValue) : null

      const nextMetadata: Record<string, any> = {
        ...existingMetadata,
        ...(formattedValues.metadata ?? {}),
        notes: formattedValues.notes || "",
      }

      if (formattedValues.item_type === "inspection") {
        const parsedInspection = inspectionMetadataSchema.parse({
          result: inspectionResult,
          inspector: selectedAssignee
            ? { type: selectedAssignee.type, id: selectedAssignee.id, label: selectedAssignee.name }
            : undefined,
          notes: inspectionNotes || undefined,
          checklist: inspectionChecklist,
          signed_by: inspectionSignedBy || undefined,
          signed_at: inspectionSignedAt,
        })
        nextMetadata.inspection = parsedInspection
      } else if (nextMetadata.inspection) {
        delete nextMetadata.inspection
      }

      // For contact/company, we can't set assigned_to FK. Strip it before sending to server.
      const payload =
        assignee?.type === "user"
          ? { ...formattedValues, assigned_to: assignee.id, metadata: nextMetadata }
          : { ...formattedValues, assigned_to: undefined, metadata: nextMetadata }

      if (isEditing && item) {
        const { notes: _ignoredNotes, ...payloadWithoutNotes } = payload as any
        await onItemUpdate(item.id, payloadWithoutNotes)
        if (assignee) {
          await setScheduleAssigneeAction({
            scheduleItemId: item.id,
            projectId: item.project_id,
            assignee,
          })
        } else {
          await setScheduleAssigneeAction({ scheduleItemId: item.id, projectId: item.project_id, assignee: null })
        }
      } else {
        const { notes: _ignoredNotes, ...payloadWithoutNotes } = payload as any
        const created = await onItemCreate(payloadWithoutNotes)
        if (assignee) {
          await setScheduleAssigneeAction({
            scheduleItemId: created.id,
            projectId: created.project_id,
            assignee,
          })
        }
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
  const availableDependencies = items?.filter((i) => i.id !== item?.id) ?? []

  const handleAttachInspection = async (files: File[], linkRole?: string) => {
    if (!item) return

    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", item.project_id)
      formData.append("category", file.type.startsWith("image/") ? "photos" : "other")
      formData.append("shareWithClients", shareInspectionAttachmentsWithClients ? "true" : "false")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "schedule_item", item.id, item.project_id, linkRole)
    }

    const links = await listAttachmentsAction("schedule_item", item.id)
    setInspectionAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      })),
    )
  }

  const handleDetachInspection = async (linkId: string) => {
    await detachFileLinkAction(linkId)
    if (!item) return
    const links = await listAttachmentsAction("schedule_item", item.id)
    setInspectionAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      })),
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex flex-col p-0 fast-sheet-animation",
          isMobile 
            ? "w-full h-screen max-w-full m-0 rounded-none border-0 shadow-2xl" 
            : "sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl"
        )}
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
                      const selected = getSelectedResource(field.value ?? undefined)
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
                                    <SelectItem key={resource.id} value={`user:${resource.id}`}>
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
                                    <SelectItem key={resource.id} value={`contact:${resource.id}`}>
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
                                    <SelectItem key={resource.id} value={`company:${resource.id}`}>
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
                                  No team members or contacts found. Add them from Manage Team in the project overview.
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

                  {/* Budget & Costs Section */}
                  <AccordionItem value="budget-costs">
                    <AccordionTrigger className="text-sm">
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4" />
                        Budget & Costs
                        {form.watch("budget_cents") && (
                          <Badge variant="secondary" className="ml-1 font-mono text-[10px]">
                            {formatAmount({
                              amount: (form.watch("budget_cents") ?? 0) / 100,
                              currency: "USD",
                              minimumFractionDigits: 0,
                            })}
                          </Badge>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      {/* Cost Code Selector */}
                      <FormField
                        control={form.control}
                        name="cost_code_id"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Cost Code</FormLabel>
                            <FormControl>
                              <CostCodeSelector
                                costCodes={costCodes}
                                value={field.value ?? null}
                                onValueChange={field.onChange}
                                placeholder="Select cost code"
                              />
                            </FormControl>
                            <FormDescription>
                              {loadingCostCodes ? "Loading cost codes..." : "Assign a cost code for budget tracking"}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Budget Amount */}
                      <FormField
                        control={form.control}
                        name="budget_cents"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Budget Amount</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                  $
                                </span>
                                <Input
                                  type="number"
                                  placeholder="0.00"
                                  className="pl-7"
                                  value={field.value ? (field.value / 100).toFixed(2) : ""}
                                  onChange={(e) => {
                                    const value = e.target.value
                                    if (value === "") {
                                      field.onChange(undefined)
                                    } else {
                                      const dollars = parseFloat(value)
                                      if (!isNaN(dollars)) {
                                        field.onChange(Math.round(dollars * 100))
                                      }
                                    }
                                  }}
                                  step="0.01"
                                  min="0"
                                />
                              </div>
                            </FormControl>
                            <FormDescription>Planned budget for this item</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Actual Cost - Only show when editing */}
                      {isEditing && (
                        <FormField
                          control={form.control}
                          name="actual_cost_cents"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Actual Cost</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                    $
                                  </span>
                                  <Input
                                    type="number"
                                    placeholder="0.00"
                                    className="pl-7"
                                    value={field.value ? (field.value / 100).toFixed(2) : ""}
                                    onChange={(e) => {
                                      const value = e.target.value
                                      if (value === "") {
                                        field.onChange(undefined)
                                      } else {
                                        const dollars = parseFloat(value)
                                        if (!isNaN(dollars)) {
                                          field.onChange(Math.round(dollars * 100))
                                        }
                                      }
                                    }}
                                    step="0.01"
                                    min="0"
                                  />
                                </div>
                              </FormControl>
                              <FormDescription>Actual cost incurred for this item</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      {/* Variance Display - Only show when both budget and actual are set */}
                      {isEditing &&
                        form.watch("budget_cents") &&
                        form.watch("actual_cost_cents") && (
                          <div className="rounded-lg border p-3 bg-muted/30">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">Variance</span>
                              <span
                                className={cn(
                                  "font-semibold",
                                  (form.watch("budget_cents") ?? 0) -
                                    (form.watch("actual_cost_cents") ?? 0) <
                                    0
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-emerald-600 dark:text-emerald-400"
                                )}
                              >
                                {formatAmount({
                                  amount:
                                    ((form.watch("budget_cents") ?? 0) -
                                      (form.watch("actual_cost_cents") ?? 0)) /
                                    100,
                                  currency: "USD",
                                  minimumFractionDigits: 0,
                                  signDisplay: "always",
                                })}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {(form.watch("budget_cents") ?? 0) -
                                (form.watch("actual_cost_cents") ?? 0) <
                              0
                                ? "Over budget"
                                : "Under budget"}
                            </div>
                          </div>
                        )}
                    </AccordionContent>
                  </AccordionItem>

                  {/* Change Orders Section - Only show when editing */}
                  {isEditing && (
                    <AccordionItem value="change-orders">
                      <AccordionTrigger className="text-sm">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          Change Orders
                          {changeOrderImpacts.length > 0 && (
                            <ChangeOrderImpactBadge
                              totalDays={coImpactTotals.total}
                              appliedDays={coImpactTotals.applied}
                              pendingDays={coImpactTotals.pending}
                              size="sm"
                            />
                          )}
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-3">
                          {loadingCOData ? (
                            <div className="text-sm text-muted-foreground text-center py-4">
                              Loading change orders...
                            </div>
                          ) : changeOrderImpacts.length > 0 ? (
                            <>
                              <div className="space-y-2">
                                {changeOrderImpacts.map((impact) => (
                                  <div
                                    key={impact.id}
                                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                                  >
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <Badge variant="outline" className="shrink-0">
                                          CO-{impact.change_order?.co_number ?? "?"}
                                        </Badge>
                                        <span className="font-medium truncate">
                                          {impact.change_order?.title ?? "Change Order"}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                        {impact.change_order?.amount_cents && (
                                          <span>
                                            {formatAmount({
                                              amount: impact.change_order.amount_cents / 100,
                                              currency: "USD",
                                              minimumFractionDigits: 0,
                                            })}
                                          </span>
                                        )}
                                        <span
                                          className={cn(
                                            "font-medium",
                                            impact.days_adjusted > 0
                                              ? "text-red-600 dark:text-red-400"
                                              : impact.days_adjusted < 0
                                                ? "text-emerald-600 dark:text-emerald-400"
                                                : ""
                                          )}
                                        >
                                          {impact.days_adjusted > 0 ? "+" : ""}
                                          {impact.days_adjusted}d impact
                                        </span>
                                        {impact.applied_at ? (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                          >
                                            Applied
                                          </Badge>
                                        ) : (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                                          >
                                            Pending
                                          </Badge>
                                        )}
                                      </div>
                                      {impact.notes && (
                                        <p className="text-xs text-muted-foreground mt-1 truncate">
                                          {impact.notes}
                                        </p>
                                      )}
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="shrink-0"
                                      asChild
                                    >
                                      <a
                                        href={`/change-orders?id=${impact.change_order_id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        <ExternalLink className="h-4 w-4" />
                                      </a>
                                    </Button>
                                  </div>
                                ))}
                              </div>
                              {coImpactTotals.pending !== 0 && (
                                <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                                  <span className="text-xs text-amber-800 dark:text-amber-300">
                                    {Math.abs(coImpactTotals.pending)} day
                                    {Math.abs(coImpactTotals.pending) !== 1 ? "s" : ""}{" "}
                                    {coImpactTotals.pending > 0 ? "delay" : "acceleration"} pending
                                    application
                                  </span>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-sm text-muted-foreground text-center py-4">
                              No change orders linked to this item.
                              <br />
                              <span className="text-xs">
                                Link change orders from the Change Orders page.
                              </span>
                            </div>
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )}

                  {/* Draw Schedule Section - Only show for milestones when editing */}
                  {isEditing && isMilestone && (
                    <AccordionItem value="draw-schedule">
                      <AccordionTrigger className="text-sm">
                        <div className="flex items-center gap-2">
                          <DollarSign className="h-4 w-4" />
                          Draw Schedule
                          {linkedDraws.length > 0 && (
                            <Badge variant="secondary" className="ml-1">
                              {linkedDraws.length}
                            </Badge>
                          )}
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-3">
                          {loadingCOData ? (
                            <div className="text-sm text-muted-foreground text-center py-4">
                              Loading draw schedule...
                            </div>
                          ) : linkedDraws.length > 0 ? (
                            <div className="space-y-2">
                              {linkedDraws.map((draw) => (
                                <div
                                  key={draw.id}
                                  className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <Badge variant="outline" className="shrink-0">
                                        Draw #{draw.draw_number}
                                      </Badge>
                                      <span
                                        className={cn(
                                          "font-medium",
                                          draw.status === "paid"
                                            ? "text-emerald-600 dark:text-emerald-400"
                                            : draw.status === "approved"
                                              ? "text-blue-600 dark:text-blue-400"
                                              : ""
                                        )}
                                      >
                                        {formatAmount({
                                          amount: (draw.amount_cents ?? 0) / 100,
                                          currency: "USD",
                                          minimumFractionDigits: 0,
                                        })}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                      {draw.scheduled_date && (
                                        <span>
                                          Scheduled: {format(new Date(draw.scheduled_date), "MMM d, yyyy")}
                                        </span>
                                      )}
                                      <Badge
                                        variant="outline"
                                        className={cn(
                                          "text-[10px]",
                                          draw.status === "paid"
                                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                            : draw.status === "approved"
                                              ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                                              : "bg-slate-50 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300"
                                        )}
                                      >
                                        {draw.status ?? "scheduled"}
                                      </Badge>
                                    </div>
                                    {draw.description && (
                                      <p className="text-xs text-muted-foreground mt-1 truncate">
                                        {draw.description}
                                      </p>
                                    )}
                                  </div>
                                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                </div>
                              ))}
                              <div className="flex justify-between items-center pt-2 border-t">
                                <span className="text-xs text-muted-foreground">Total</span>
                                <span className="font-semibold">
                                  {formatAmount({
                                    amount:
                                      linkedDraws.reduce((sum, d) => sum + (d.amount_cents ?? 0), 0) /
                                      100,
                                    currency: "USD",
                                    minimumFractionDigits: 0,
                                  })}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground text-center py-4">
                              No draws linked to this milestone.
                              <br />
                              <span className="text-xs">
                                Link milestones to draws from the Draw Schedule page.
                              </span>
                            </div>
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )}

                  {isInspection && (
                    <AccordionItem value="inspection">
                      <AccordionTrigger className="text-sm">Inspection</AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-4">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Result</Label>
                              <Select value={inspectionResult} onValueChange={(v) => setInspectionResult(v as InspectionResult)}>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select result" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="pending">Pending</SelectItem>
                                  <SelectItem value="pass">Pass</SelectItem>
                                  <SelectItem value="fail">Fail</SelectItem>
                                  <SelectItem value="partial">Partial</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Signoff</Label>
                              <div className="flex gap-2">
                                <Input
                                  value={inspectionSignedBy}
                                  onChange={(e) => setInspectionSignedBy(e.target.value)}
                                  placeholder="Signer name"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => {
                                    if (!inspectionSignedBy.trim()) return
                                    setInspectionSignedAt(new Date().toISOString())
                                  }}
                                >
                                  Sign
                                </Button>
                              </div>
                              {inspectionSignedAt ? (
                                <p className="text-xs text-muted-foreground">
                                  Signed {new Date(inspectionSignedAt).toLocaleString()}
                                </p>
                              ) : null}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label>Inspection notes</Label>
                            <Textarea
                              value={inspectionNotes}
                              onChange={(e) => setInspectionNotes(e.target.value)}
                              placeholder="Notes, corrections, reinspection details..."
                              className="min-h-[90px] resize-none"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label>Checklist</Label>
                            <div className="flex gap-2">
                              <Input
                                value={newChecklistItem}
                                onChange={(e) => setNewChecklistItem(e.target.value)}
                                placeholder="Add checklist item"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  const label = newChecklistItem.trim()
                                  if (!label) return
                                  setInspectionChecklist((prev) => [
                                    ...prev,
                                    { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, label, checked: false },
                                  ])
                                  setNewChecklistItem("")
                                }}
                              >
                                Add
                              </Button>
                            </div>

                            <div className="space-y-2 pt-2">
                              {inspectionChecklist.map((entry) => (
                                <div key={entry.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                                  <Label className="flex items-center gap-2 text-sm font-normal">
                                    <Checkbox
                                      checked={entry.checked}
                                      onCheckedChange={(checked) =>
                                        setInspectionChecklist((prev) =>
                                          prev.map((i) => (i.id === entry.id ? { ...i, checked: Boolean(checked) } : i)),
                                        )
                                      }
                                    />
                                    {entry.label}
                                  </Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setInspectionChecklist((prev) => prev.filter((i) => i.id !== entry.id))
                                    }
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                              {inspectionChecklist.length === 0 ? (
                                <p className="text-xs text-muted-foreground">No checklist items yet.</p>
                              ) : null}
                            </div>
                          </div>

                          {isEditing && item ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  checked={shareInspectionAttachmentsWithClients}
                                  onCheckedChange={(value) => setShareInspectionAttachmentsWithClients(Boolean(value))}
                                  id="share-inspection-attachments"
                                />
                                <Label htmlFor="share-inspection-attachments" className="text-xs font-normal text-muted-foreground">
                                  Share new attachments with client portal
                                </Label>
                              </div>
                              <EntityAttachments
                                entityType="schedule_item"
                                entityId={item.id}
                                projectId={item.project_id}
                                attachments={inspectionAttachments}
                                onAttach={handleAttachInspection}
                                onDetach={handleDetachInspection}
                                readOnly={inspectionAttachmentsLoading}
                                compact
                                acceptedTypes=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                              />
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Create the inspection first to add attachments.
                            </p>
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )}
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
