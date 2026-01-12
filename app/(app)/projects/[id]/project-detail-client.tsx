"use client"

import { useState, useMemo, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  format,
  formatDistanceToNow,
  differenceInCalendarDays,
  parseISO,
  isAfter,
  isBefore,
  addDays,
} from "date-fns"
import { toast } from "sonner"

import type { Company, Contact, Project, Task, ScheduleItem, PortalAccessToken, ProjectVendor, Contract, DrawSchedule, Retainage, Proposal } from "@/lib/types"
import type {
  ProjectStats,
  ProjectTeamMember,
  ProjectActivity,
  ProjectRoleOption,
  TeamDirectoryEntry,
} from "./actions"
import {
  addProjectMembersAction,
  removeProjectMemberAction,
  updateProjectMemberRoleAction,
  getProjectTeamDirectoryAction,
  updateProjectSettingsAction,
  addProjectVendorAction,
  removeProjectVendorAction,
  updateProjectVendorAction,
  getProjectVendorsAction,
  createAndAssignVendorAction,
} from "./actions"
import { loadSharingDataAction, revokePortalTokenAction, setPortalTokenPinAction, removePortalTokenPinAction } from "@/app/(app)/sharing/actions"
import type { ProjectInput } from "@/lib/validation/projects"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { cn } from "@/lib/utils"
import { AccessTokenGenerator } from "@/components/sharing/access-token-generator"
import { AccessTokenList } from "@/components/sharing/access-token-list"
import { ProjectSettingsSheet } from "@/components/projects/project-settings-sheet"
import { ProjectDirectory, DIRECTORY_ROLE_FILTERS } from "@/components/projects/project-directory"
import { ContractDetailSheet } from "@/components/contracts/contract-detail-sheet"
import { ProjectPipelineChecklist } from "./project-pipeline-checklist"
import { ProjectSetupWizardSheet } from "./project-setup-wizard-sheet"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  CalendarDays,
  CheckCircle,
  Clock,
  AlertCircle,
  Plus,
  MoreHorizontal,
  Camera,
  FileText,
  Users,
  DollarSign,
  TrendingUp,
  Upload,
  ClipboardList,
  Building2,
  Search,
  RotateCw,
  Mail,
  UserPlus,
  Settings,
  Share2,
  RefreshCcw,
  Filter,
} from "@/components/icons"

interface ProjectDetailClientProps {
  project: Project
  stats: ProjectStats
  tasks: Task[]
  scheduleItems: ScheduleItem[]
  team: ProjectTeamMember[]
  activity: ProjectActivity[]
  portalTokens: PortalAccessToken[]
  contacts: Contact[]
  projectVendors: ProjectVendor[]
  companies: Company[]
  contract: Contract | null
  draws: DrawSchedule[]
  retainage: Retainage[]
  proposals: Proposal[]
  approvedChangeOrdersTotalCents: number
}

const statusColors: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  bidding: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<string, string> = {
  planning: "Planning",
  bidding: "Bidding",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
}


const scheduleStatusColors: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  in_progress: "bg-primary/10 text-primary",
  at_risk: "bg-warning/20 text-warning",
  blocked: "bg-destructive/10 text-destructive",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

function formatActivityEvent(event: ProjectActivity): { icon: React.ReactNode; title: string; description: string } {
  const eventMap: Record<string, { icon: React.ReactNode; title: string }> = {
    task_created: { icon: <CheckCircle className="h-4 w-4 text-success" />, title: "Task created" },
    task_updated: { icon: <CheckCircle className="h-4 w-4 text-primary" />, title: "Task updated" },
    task_completed: { icon: <CheckCircle className="h-4 w-4 text-success" />, title: "Task completed" },
    daily_log_created: { icon: <ClipboardList className="h-4 w-4 text-chart-2" />, title: "Daily log added" },
    schedule_item_created: { icon: <CalendarDays className="h-4 w-4 text-chart-3" />, title: "Schedule item added" },
    schedule_item_updated: { icon: <CalendarDays className="h-4 w-4 text-primary" />, title: "Schedule updated" },
    file_uploaded: { icon: <FileText className="h-4 w-4 text-chart-4" />, title: "File uploaded" },
    project_updated: { icon: <Building2 className="h-4 w-4 text-primary" />, title: "Project updated" },
    project_created: { icon: <Building2 className="h-4 w-4 text-success" />, title: "Project created" },
  }

  const config = eventMap[event.event_type] ?? { icon: <AlertCircle className="h-4 w-4" />, title: event.event_type }
  const description = event.payload?.title ?? event.payload?.name ?? event.payload?.summary ?? ""

  return { ...config, description }
}


export function ProjectDetailClient({
  project,
  stats,
  tasks: initialTasks,
  scheduleItems: initialScheduleItems,
  team,
  activity,
  portalTokens,
  contacts,
  projectVendors,
  companies,
  contract,
  draws,
  retainage,
  proposals,
  approvedChangeOrdersTotalCents,
}: ProjectDetailClientProps) {
  const router = useRouter()
  const today = new Date()

  // State for data
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>(initialScheduleItems)
  const [teamMembers, setTeamMembers] = useState<ProjectTeamMember[]>(team)
  const [sharingSheetOpen, setSharingSheetOpen] = useState(false)
  const [setupWizardOpen, setSetupWizardOpen] = useState(false)
  const [portalTokensState, setPortalTokensState] = useState<PortalAccessToken[]>(portalTokens)
  const [sharingLoading, setSharingLoading] = useState(false)
  const [sharingLastLoadedAt, setSharingLastLoadedAt] = useState<Date | null>(portalTokens.length ? new Date() : null)
  const [sharingInitialized, setSharingInitialized] = useState(Boolean(portalTokens.length))

  useEffect(() => {
    setPortalTokensState(portalTokens)
    setSharingInitialized(Boolean(portalTokens.length))
    setSharingLastLoadedAt(portalTokens.length ? new Date() : null)
  }, [portalTokens])

  useEffect(() => {
    setTeamMembers(team)
  }, [team])

  useEffect(() => {
    setScheduleItems(initialScheduleItems)
  }, [initialScheduleItems])

  // Sheet states
  const [teamSheetOpen, setTeamSheetOpen] = useState(false)
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false)
  const [projectVendorsState, setProjectVendorsState] = useState<ProjectVendor[]>(projectVendors)
  const [contractSheetOpen, setContractSheetOpen] = useState(false)
  const handleSaveProject = async (input: Partial<ProjectInput>) => {
    await updateProjectSettingsAction(project.id, input)
    router.refresh()
  }

  // Team management state
  const [teamSearch, setTeamSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState("all")
  const [teamDirectoryLoading, setTeamDirectoryLoading] = useState(false)
  const [teamLoading, setTeamLoading] = useState(false)
  const [availablePeople, setAvailablePeople] = useState<TeamDirectoryEntry[]>([])
  const [projectRoles, setProjectRoles] = useState<ProjectRoleOption[]>([])
  const [selectedRoleId, setSelectedRoleId] = useState<string | undefined>()
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())
  const [directorySearch, setDirectorySearch] = useState("")
  const [vendorSearch, setVendorSearch] = useState("")
  const [vendorRoleFilter, setVendorRoleFilter] = useState<"all" | ProjectVendorInput["role"]>("all")
  const [directoryAssignOpen, setDirectoryAssignOpen] = useState(false)
  const [selectedVendorEntity, setSelectedVendorEntity] = useState<{ type: "company" | "contact"; id: string } | null>(null)
  const [vendorScope, setVendorScope] = useState("")
  const [vendorNotes, setVendorNotes] = useState("")
  const [vendorRole, setVendorRole] = useState<ProjectVendorInput["role"]>("subcontractor")
  const [createNewMode, setCreateNewMode] = useState(false)
  const [newVendorKind, setNewVendorKind] = useState<"company" | "contact" | "client_contact">("company")
  const [newVendorName, setNewVendorName] = useState("")
  const [newVendorEmail, setNewVendorEmail] = useState("")
  const [newVendorPhone, setNewVendorPhone] = useState("")
  const [newVendorTrade, setNewVendorTrade] = useState("")
  const [newVendorCompanyType, setNewVendorCompanyType] = useState("subcontractor")
  const [newVendorContactRole, setNewVendorContactRole] = useState("")
  const [manageTeamSheetOpen, setManageTeamSheetOpen] = useState(false)
  const [assigningVendor, setAssigningVendor] = useState(false)
  const { clientActiveLinks, subActiveLinks, activeTokens } = useMemo(() => {
    const activeClient = portalTokensState.filter((token) => token.portal_type === "client" && !token.revoked_at).length
    const activeSubs = portalTokensState.filter((token) => token.portal_type === "sub" && !token.revoked_at).length
    const actives = portalTokensState.filter((token) => !token.revoked_at)
    return { clientActiveLinks: activeClient, subActiveLinks: activeSubs, activeTokens: actives }
  }, [portalTokensState])
  const activePortalLinks = clientActiveLinks + subActiveLinks

  useEffect(() => {
    void loadTeamDirectory()
  }, [])

  async function refreshPortalTokens() {
    setSharingLoading(true)
    try {
      const tokens = await loadSharingDataAction(project.id)
      setPortalTokensState(tokens)
      setSharingInitialized(true)
      setSharingLastLoadedAt(new Date())
    } catch (error) {
      console.error(error)
      toast.error("Unable to load sharing links")
    } finally {
      setSharingLoading(false)
    }
  }

  function handleTokenCreated(token: PortalAccessToken) {
    setPortalTokensState((prev) => [token, ...prev])
    setSharingInitialized(true)
    setSharingLastLoadedAt(new Date())
    toast.success("Link created", { description: "Share it with your client or sub." })
  }

  async function handleTokenRevoke(tokenId: string) {
    setSharingLoading(true)
    try {
      await revokePortalTokenAction({ token_id: tokenId, project_id: project.id })
      setPortalTokensState((prev) =>
        prev.map((token) =>
          token.id === tokenId ? { ...token, revoked_at: new Date().toISOString() } : token
        )
      )
      toast.success("Access revoked")
    } catch (error) {
      console.error(error)
      toast.error("Failed to revoke link")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleSetPin(tokenId: string, pin: string) {
    setSharingLoading(true)
    try {
      await setPortalTokenPinAction({ token_id: tokenId, pin })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, pin_required: true } : token)),
      )
      toast.success("PIN updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to set PIN")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleClearPin(tokenId: string) {
    setSharingLoading(true)
    try {
      await removePortalTokenPinAction({ token_id: tokenId })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, pin_required: false } : token)),
      )
      toast.success("PIN removed")
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove PIN")
    } finally {
      setSharingLoading(false)
    }
  }

  useEffect(() => {
    if (sharingSheetOpen && !sharingInitialized) {
      void refreshPortalTokens()
    }
  }, [sharingInitialized, sharingSheetOpen])

  async function loadTeamDirectory() {
    setTeamDirectoryLoading(true)
    try {
      const { roles, people } = await getProjectTeamDirectoryAction(project.id)
      setProjectRoles(roles)
      setAvailablePeople(people)
      if (!selectedRoleId && roles.length > 0) {
        setSelectedRoleId(roles[0].id)
      }
    } catch (error) {
      console.error(error)
      toast.error("Unable to load team directory")
    } finally {
      setTeamDirectoryLoading(false)
    }
  }

  async function handleAddMembers() {
    const userIds = Array.from(selectedUserIds)
    const roleId = selectedRoleId ?? projectRoles[0]?.id

    if (!userIds.length) {
      toast.info("Select at least one person to add")
      return
    }

    if (!roleId) {
      toast.error("Choose a project role before adding people")
      return
    }

    setTeamLoading(true)
    try {
      const added = await addProjectMembersAction(project.id, { userIds, roleId })
      setTeamMembers((prev) => {
        const map = new Map(prev.map((member) => [member.user_id, member]))
        added.forEach((member) => map.set(member.user_id, member))
        return Array.from(map.values())
      })
      setSelectedUserIds(new Set())
      toast.success("Team updated", {
        description: `${added.length} member${added.length === 1 ? "" : "s"} assigned to this project`,
      })
      await loadTeamDirectory()
      setTeamSheetOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Failed to update team", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleRemoveMember(memberId: string) {
    setTeamLoading(true)
    try {
      await removeProjectMemberAction(project.id, memberId)
      setTeamMembers((prev) => prev.filter((member) => member.id !== memberId))
      await loadTeamDirectory()
      toast.success("Removed from project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove member", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleRoleChange(memberId: string, roleId: string) {
    setTeamLoading(true)
    try {
      const updated = await updateProjectMemberRoleAction(project.id, memberId, roleId)
      setTeamMembers((prev) => prev.map((member) => (member.id === memberId ? updated : member)))
      await loadTeamDirectory()
      toast.success("Role updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to update role", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleQuickAdd(userId: string) {
    const roleId = selectedRoleId ?? projectRoles[0]?.id
    if (!roleId) {
      toast.error("Select a project role before adding")
      return
    }
    setTeamLoading(true)
    try {
      const added = await addProjectMembersAction(project.id, { userIds: [userId], roleId })
      setTeamMembers((prev) => {
        const map = new Map(prev.map((member) => [member.user_id, member]))
        added.forEach((member) => map.set(member.user_id, member))
        return Array.from(map.values())
      })
      toast.success("Member added")
      await loadTeamDirectory()
    } catch (error) {
      console.error(error)
      toast.error("Failed to add member", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  function toggleUserSelection(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }

  async function handleAddVendor(input: ProjectVendorInput) {
    setTeamLoading(true)
    try {
      await addProjectVendorAction(project.id, input)
      const refreshed = await getProjectVendorsAction(project.id)
      setProjectVendorsState(refreshed)
      toast.success("Added to directory")
    } catch (error) {
      console.error(error)
      toast.error("Failed to add", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleAssignExistingVendor(entity: { type: "company" | "contact"; id: string }) {
    setAssigningVendor(true)
    try {
      await addProjectVendorAction(project.id, {
        project_id: project.id,
        company_id: entity.type === "company" ? entity.id : undefined,
        contact_id: entity.type === "contact" ? entity.id : undefined,
        role: vendorRole,
        scope: vendorScope || undefined,
        notes: vendorNotes || undefined,
      })
      const refreshed = await getProjectVendorsAction(project.id)
      setProjectVendorsState(refreshed)
      setSelectedVendorEntity(null)
      setVendorScope("")
      setVendorNotes("")
      toast.success("Assigned to project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to assign", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setAssigningVendor(false)
    }
  }

  async function handleCreateAndAssignVendor() {
    if (!newVendorName.trim()) {
      toast.error("Name is required")
      return
    }
    setAssigningVendor(true)
    try {
      await createAndAssignVendorAction(project.id, {
        kind: newVendorKind,
        name: newVendorName.trim(),
        email: newVendorEmail.trim() || undefined,
        phone: newVendorPhone.trim() || undefined,
        trade: newVendorTrade.trim() || undefined,
        company_type: newVendorCompanyType,
        contact_role: newVendorContactRole.trim() || undefined,
        role: vendorRole,
        scope: vendorScope || undefined,
        notes: vendorNotes || undefined,
      })
      const refreshed = await getProjectVendorsAction(project.id)
      setProjectVendorsState(refreshed)
      setCreateNewMode(false)
      setNewVendorName("")
      setNewVendorEmail("")
      setNewVendorPhone("")
      setNewVendorTrade("")
      setNewVendorContactRole("")
      toast.success("Added to project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to add", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setAssigningVendor(false)
    }
  }

  async function handleRemoveVendor(vendorId: string) {
    setTeamLoading(true)
    try {
      await removeProjectVendorAction(project.id, vendorId)
      setProjectVendorsState((prev) => prev.filter((v) => v.id !== vendorId))
      toast.success("Removed from project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleUpdateVendor(vendorId: string, updates: Partial<Pick<ProjectVendorInput, "role" | "scope" | "notes">>) {
    setTeamLoading(true)
    try {
      await updateProjectVendorAction(project.id, vendorId, updates)
      const refreshed = await getProjectVendorsAction(project.id)
      setProjectVendorsState(refreshed)
      toast.success("Updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to update", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  // Calculate progress percentage
  const progressPercentage = stats.totalDays > 0 
    ? Math.min(100, Math.round((stats.daysElapsed / stats.totalDays) * 100))
    : 0

  // Upcoming schedule items
  const upcomingItems = useMemo(() => {
    return scheduleItems
      .filter(item => {
        const endDate = item.end_date ? parseISO(item.end_date) : null
        const startDate = item.start_date ? parseISO(item.start_date) : null
        const targetDate = endDate ?? startDate
        return (
          targetDate &&
          isAfter(targetDate, today) &&
          item.status !== "completed" &&
          item.status !== "cancelled"
        )
      })
      .slice(0, 5)
  }, [scheduleItems, today])

  // At risk items
  const atRiskItems = useMemo(() => {
    return scheduleItems.filter(item => {
      const endDate = item.end_date ? parseISO(item.end_date) : null
      const isOverdue =
        endDate && isBefore(endDate, today) && item.status !== "completed" && item.status !== "cancelled"
      const isAtRisk = item.status === "at_risk" || item.status === "blocked"
      return isOverdue || isAtRisk
    })
  }, [scheduleItems, today])

  const teamWorkload = useMemo(() => {
    const map: Record<string, { tasks: number; schedule: number; nextDue?: string }> = {}
    tasks.forEach((task) => {
      if (!task.assignee_id) return
      if (!map[task.assignee_id]) map[task.assignee_id] = { tasks: 0, schedule: 0 }
      map[task.assignee_id].tasks += 1
      if (task.due_date) {
        const existing = map[task.assignee_id].nextDue
        if (!existing || isBefore(parseISO(task.due_date), parseISO(existing))) {
          map[task.assignee_id].nextDue = task.due_date
        }
      }
    })
    scheduleItems.forEach((item) => {
      if (!item.assigned_to) return
      if (!map[item.assigned_to]) map[item.assigned_to] = { tasks: 0, schedule: 0 }
      map[item.assigned_to].schedule += 1
    })
    return map
  }, [scheduleItems, tasks])

  const filteredTeam = useMemo(() => {
    const search = teamSearch.trim().toLowerCase()
    return teamMembers.filter((member) => {
      const matchesSearch = search
        ? member.full_name.toLowerCase().includes(search) || member.email.toLowerCase().includes(search)
        : true
      const matchesRole =
        roleFilter === "all"
          ? true
          : member.role_id === roleFilter || member.role === roleFilter || member.role_label === roleFilter
      return matchesSearch && matchesRole
    })
  }, [roleFilter, teamMembers, teamSearch])


  const filteredDirectory = useMemo(() => {
    const search = directorySearch.trim().toLowerCase()
    return availablePeople
      .filter((person) => {
        if (!search) return true
        return (
          person.full_name.toLowerCase().includes(search) ||
          person.email.toLowerCase().includes(search) ||
          (person.project_role_label ?? "").toLowerCase().includes(search)
        )
      })
      .sort((a, b) => Number(Boolean(a.project_member_id)) - Number(Boolean(b.project_member_id)))
  }, [availablePeople, directorySearch])

  const assignedCompanyIds = useMemo(
    () => new Set(projectVendorsState.map((v) => v.company_id).filter(Boolean) as string[]),
    [projectVendorsState],
  )
  const assignedContactIds = useMemo(
    () => new Set(projectVendorsState.map((v) => v.contact_id).filter(Boolean) as string[]),
    [projectVendorsState],
  )
  const directoryOptions = useMemo(() => {
    const lower = vendorSearch.trim().toLowerCase()
    const companyOptions =
      companies
        ?.filter((c) => !assignedCompanyIds.has(c.id))
        .map((c) => ({
          id: c.id,
          type: "company" as const,
          title: c.name,
          subtitle: c.trade || c.company_type,
          match: `${c.name} ${c.trade ?? ""} ${c.company_type ?? ""}`.toLowerCase(),
        })) ?? []
    const contactOptions =
      contacts
        ?.filter((c) => !assignedContactIds.has(c.id))
        .map((c) => ({
          id: c.id,
          type: "contact" as const,
          title: c.full_name,
          subtitle: c.email ?? c.role,
          match: `${c.full_name} ${c.email ?? ""} ${c.role ?? ""}`.toLowerCase(),
        })) ?? []
    const combined = [...companyOptions, ...contactOptions]
    if (!lower) return combined
    return combined.filter((item) => item.match.includes(lower))
  }, [companies, contacts, assignedCompanyIds, assignedContactIds, vendorSearch, projectVendorsState])

  useEffect(() => {
    if (vendorRoleFilter !== "all") {
      setVendorRole(vendorRoleFilter)
    }
  }, [vendorRoleFilter])

  // Mini gantt data
  const ganttEnd = project.end_date ? parseISO(project.end_date) : addDays(today, 90)
  const ganttStart = project.start_date ? parseISO(project.start_date) : today
  const ganttTotalDays = Math.max(1, differenceInCalendarDays(ganttEnd, ganttStart))

  function getBarPosition(startDate?: string, endDate?: string) {
    const start = startDate ? parseISO(startDate) : ganttStart
    const end = endDate ? parseISO(endDate) : start
    const startDelta = Math.max(0, differenceInCalendarDays(start, ganttStart))
    const endDelta = Math.max(startDelta + 1, differenceInCalendarDays(end, ganttStart) + 1)
    const left = Math.min(100, (startDelta / ganttTotalDays) * 100)
    const width = Math.min(100 - left, ((endDelta - startDelta) / ganttTotalDays) * 100)
    return { left, width: Math.max(width, 2) }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] space-y-4 p-4 lg:p-6 overflow-hidden">
      <ProjectSettingsSheet
        project={project}
        contacts={contacts}
        open={settingsSheetOpen}
        onOpenChange={setSettingsSheetOpen}
        onSave={handleSaveProject}
      />
      <ProjectSetupWizardSheet
        open={setupWizardOpen}
        onOpenChange={setSetupWizardOpen}
        project={project}
        contacts={contacts}
        team={teamMembers}
        proposals={proposals}
        contract={contract}
        scheduleItems={scheduleItems}
        drawsCount={draws.length}
        portalTokens={portalTokensState}
      />
      <ContractDetailSheet contract={contract} open={contractSheetOpen} onOpenChange={setContractSheetOpen} />
      {/* Header Section - Fixed */}
      <div className="flex-shrink-0 space-y-4">
        {/* Project Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
              <Badge variant="outline" className={statusColors[project.status]}>
                {statusLabels[project.status]}
              </Badge>
            </div>
            {project.address && (
              <p className="text-muted-foreground flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                {project.address}
              </p>
            )}
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              {project.start_date && project.end_date && (
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" />
                  {format(parseISO(project.start_date), "MMM d, yyyy")} – {format(parseISO(project.end_date), "MMM d, yyyy")}
                </span>
              )}
              {stats.daysRemaining > 0 && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  {stats.daysRemaining} days remaining
                </span>
              )}
              {project.total_value && (
                <span className="flex items-center gap-1.5">
                  <DollarSign className="h-4 w-4" />
                  ${project.total_value.toLocaleString()}
                </span>
              )}
              {project.property_type && (
                <span className="capitalize">
                  {project.property_type}
                </span>
              )}
              {project.project_type && (
                <span className="capitalize">
                  {project.project_type.replace("_", " ")}
                </span>
              )}
            </div>
            {project.description && (
              <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                {project.description}
              </p>
            )}
    </div>

      {/* Directory Assignment Sheet */}
      <Sheet open={directoryAssignOpen} onOpenChange={(open) => { setDirectoryAssignOpen(open); setSelectedVendorEntity(null); setCreateNewMode(false); }}>
        <SheetContent
          side="right"
          className="sm:max-w-xl w-full max-w-xl ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
        >
          <div className="flex h-full flex-col">
            <div className="border-b bg-muted/30 px-6 py-3">
              <SheetHeader className="text-left">
                <SheetTitle className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                  Assign to directory
                </SheetTitle>
                <SheetDescription className="text-xs text-muted-foreground">
                  Pick existing companies or contacts.
                </SheetDescription>
              </SheetHeader>
            </div>

            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-6">
                <div className="rounded-lg border bg-card/60 shadow-sm">
                  <div className="border-b px-4 py-3 flex items-center justify-between">
                    <p className="text-sm font-medium">Directory</p>
                    <Badge variant="secondary" className="text-[11px]">
                      {directoryOptions.length} found
                    </Badge>
                  </div>
                  <div className="p-4 pb-0">
                    <Input
                      value={vendorSearch}
                      onChange={(e) => {
                        setVendorSearch(e.target.value)
                        setCreateNewMode(false)
                      }}
                      placeholder="Search companies or contacts"
                    />
                  </div>
                  <div className="max-h-[320px] overflow-y-auto divide-y mt-3">
                    {directoryOptions.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">No matches found</div>
                    ) : (
                      directoryOptions.map((item) => {
                        const isSelected =
                          selectedVendorEntity?.id === item.id && selectedVendorEntity.type === item.type
                        return (
                          <button
                            key={`${item.type}-${item.id}`}
                            type="button"
                            className={cn(
                              "w-full px-4 py-3 text-left hover:bg-muted/70 transition flex items-center gap-3",
                              isSelected && "bg-primary/10 ring-1 ring-primary/30"
                            )}
                            onClick={() => {
                              setSelectedVendorEntity({ type: item.type, id: item.id })
                              setCreateNewMode(false)
                              setVendorScope("")
                              setVendorNotes("")
                            }}
                          >
                            <Avatar className="h-10 w-10">
                              <AvatarFallback className="text-xs">
                                {getInitials(item.title)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="font-medium truncate">{item.title}</p>
                                <Badge variant="outline" className="text-[10px] capitalize">
                                  {item.type}
                                </Badge>
                              </div>
                              {item.subtitle && (
                                <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
                              )}
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>

                {vendorSearch.trim().length > 0 && (
                  <Button
                    variant="outline"
                    className="justify-start h-auto py-3"
                    onClick={() => {
                      setCreateNewMode(true)
                      setNewVendorName(vendorSearch.trim())
                      setSelectedVendorEntity(null)
                    }}
                  >
                    Add “{vendorSearch.trim()}”
                  </Button>
                )}

                {createNewMode && (
                  <div className="rounded-lg border bg-card/60 shadow-sm p-4 space-y-4">
                    <div className="flex items-center gap-3">
                      <Select value={newVendorKind} onValueChange={(v) => setNewVendorKind(v as typeof newVendorKind)}>
                        <SelectTrigger className="w-[200px]">
                          <SelectValue placeholder="Type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="company">Company</SelectItem>
                          <SelectItem value="contact">Contact</SelectItem>
                          <SelectItem value="client_contact">Client</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={newVendorName}
                        onChange={(e) => setNewVendorName(e.target.value)}
                        placeholder="Name"
                      />
                    </div>
                    {(newVendorKind === "contact" || newVendorKind === "client_contact") && (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Input
                          value={newVendorEmail}
                          onChange={(e) => setNewVendorEmail(e.target.value)}
                          placeholder="Email"
                        />
                        <Input
                          value={newVendorPhone}
                          onChange={(e) => setNewVendorPhone(e.target.value)}
                          placeholder="Phone"
                        />
                        <Input
                          value={newVendorContactRole}
                          onChange={(e) => setNewVendorContactRole(e.target.value)}
                          placeholder="Role/title"
                        />
                      </div>
                    )}
                    {newVendorKind === "company" && (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Select value={newVendorCompanyType} onValueChange={setNewVendorCompanyType}>
                          <SelectTrigger>
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="subcontractor">Subcontractor</SelectItem>
                            <SelectItem value="supplier">Supplier</SelectItem>
                            <SelectItem value="client">Client</SelectItem>
                            <SelectItem value="architect">Architect</SelectItem>
                            <SelectItem value="engineer">Engineer</SelectItem>
                            <SelectItem value="other">Other</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          value={newVendorTrade}
                          onChange={(e) => setNewVendorTrade(e.target.value)}
                          placeholder="Trade"
                        />
                        <Input
                          value={newVendorEmail}
                          onChange={(e) => setNewVendorEmail(e.target.value)}
                          placeholder="Email"
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded-lg border bg-card/60 shadow-sm p-4 space-y-3">
                  <Textarea
                    value={vendorScope}
                    onChange={(e) => setVendorScope(e.target.value)}
                    placeholder="Scope on this project"
                    className="min-h-[96px]"
                  />
                  <Textarea
                    value={vendorNotes}
                    onChange={(e) => setVendorNotes(e.target.value)}
                    placeholder="Notes, access, crew names"
                    className="min-h-[96px]"
                  />
                </div>
              </div>
            </ScrollArea>

            <div className="flex-shrink-0 border-t bg-muted/30 p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setDirectoryAssignOpen(false)
                    setSelectedVendorEntity(null)
                    setCreateNewMode(false)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  className="w-full"
                  disabled={assigningVendor || (!selectedVendorEntity && !createNewMode)}
                  onClick={() => {
                    if (createNewMode || !selectedVendorEntity) {
                      void handleCreateAndAssignVendor()
                    } else if (selectedVendorEntity) {
                      void handleAssignExistingVendor(selectedVendorEntity)
                    }
                  }}
                >
                  {assigningVendor
                    ? "Saving..."
                    : createNewMode || !selectedVendorEntity
                      ? "Add and assign"
                      : "Assign to project"}
                </Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

          <div className="flex items-center gap-2">
            <Sheet open={sharingSheetOpen} onOpenChange={setSharingSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm">
                  <Share2 className="mr-2 h-4 w-4" />
                  Share
                </Button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="w-full max-w-5xl sm:max-w-5xl ml-auto mr-4 mt-4 mb-4 h-[calc(100vh-2rem)] overflow-hidden rounded-xl border bg-background p-0 shadow-2xl flex min-h-0 flex-col"
              >
                <div className="flex h-full min-h-0 flex-col">
                  <div className="border-b bg-muted/50 px-6 py-5">
                    <SheetHeader className="text-left">
                      <SheetTitle className="text-xl font-semibold leading-tight">Share this project</SheetTitle>
                      <SheetDescription className="text-sm text-muted-foreground">
                        Generate secure client or subcontractor links and manage existing access without leaving the
                        project.
                      </SheetDescription>
                    </SheetHeader>
                  </div>

                  <ScrollArea className="flex-1 min-h-0">
                    <div className="space-y-6 px-6 py-6">
                      <Accordion type="single" collapsible className="rounded-xl border bg-card/70 shadow-sm">
                        <AccordionItem value="active-access" className="border-none">
                          <AccordionTrigger className="px-4">
                            <div className="flex w-full items-center justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <Badge variant="secondary" className="px-3 py-1">
                                  {activePortalLinks} active
                                </Badge>
                                <div className="flex items-center gap-4 text-sm">
                                  <span className="text-muted-foreground">Clients {clientActiveLinks}</span>
                                  <span className="text-muted-foreground">Subs {subActiveLinks}</span>
                                </div>
                              </div>
                              <span className="text-xs text-muted-foreground">Expand to review active links</span>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4">
                            <div className="pt-2">
                              <AccessTokenList
                                projectId={project.id}
                                tokens={activeTokens}
                                onRevoke={handleTokenRevoke}
                                isLoading={sharingLoading}
                                onSetPin={handleSetPin}
                                onClearPin={handleClearPin}
                              />
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>

                      <Card className="shadow-sm">
                        <CardHeader className="pb-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <CardTitle className="text-lg">Create a new portal link</CardTitle>
                              <CardDescription>
                                Pick an audience, add an optional expiry, and lock down permissions.
                              </CardDescription>
                            </div>
                            <Badge variant="outline">Step 1</Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <AccessTokenGenerator projectId={project.id} onCreated={handleTokenCreated} />
                        </CardContent>
                      </Card>
                    </div>
                  </ScrollArea>
                </div>
              </SheetContent>
            </Sheet>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setSettingsSheetOpen(true) }}>
                  <Settings className="mr-2 h-4 w-4" />
                  Project Settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setManageTeamSheetOpen(true); void loadTeamDirectory() }}>
                  <Users className="mr-2 h-4 w-4" />
                  Manage Team
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">Archive Project</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Manage Team Sheet */}
      <Sheet open={manageTeamSheetOpen} onOpenChange={setManageTeamSheetOpen}>
        <SheetContent side="right" className="sm:max-w-3xl w-full max-w-3xl ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col">
          <div className="flex-1 overflow-y-auto px-4">
            <SheetHeader className="pt-6 pb-4">
              <SheetTitle className="text-lg font-semibold leading-none tracking-tight">Project team</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                View, add, and manage internal teammates on this project.
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 w-full sm:w-auto mb-4">
              <div className="relative flex-1 min-w-[260px]">
                <Input
                  value={teamSearch}
                  onChange={(e) => setTeamSearch(e.target.value)}
                  placeholder="Search team"
                  className="pr-12"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 border-0 shadow-none hover:bg-muted"
                    >
                      <Filter className="h-4 w-4" />
                      <span className="sr-only">Filters</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>Filter by role</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup value={roleFilter} onValueChange={setRoleFilter}>
                      <DropdownMenuRadioItem value="all">All roles</DropdownMenuRadioItem>
                      {projectRoles.map((role) => (
                        <DropdownMenuRadioItem key={role.id} value={role.id}>
                          {role.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Button size="icon" onClick={() => { setTeamSheetOpen(true); void loadTeamDirectory() }}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {filteredTeam.length > 0 ? (
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="divide-x">
                      <TableHead className="px-4 py-3">Name</TableHead>
                      <TableHead className="px-4 py-3">Project role</TableHead>
                      <TableHead className="px-4 py-3">Email</TableHead>
                      <TableHead className="px-4 py-3 text-center">Workload</TableHead>
                      <TableHead className="px-4 py-3 text-center">Status</TableHead>
                      <TableHead className="px-4 py-3 text-center w-12">‎</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTeam.map((member) => {
                      const workload = teamWorkload[member.user_id] ?? { tasks: 0, schedule: 0 }
                      const workloadText =
                        workload.tasks || workload.schedule
                          ? [
                              workload.tasks ? `${workload.tasks} task${workload.tasks !== 1 ? "s" : ""}` : null,
                              workload.schedule
                                ? `${workload.schedule} schedule item${workload.schedule !== 1 ? "s" : ""}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" • ")
                          : "—"

                      return (
                        <TableRow key={member.id} className="divide-x">
                          <TableCell className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <Avatar className="h-10 w-10">
                                <AvatarImage src={member.avatar_url} alt={member.full_name} />
                                <AvatarFallback>{getInitials(member.full_name)}</AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p className="font-medium truncate">{member.full_name}</p>
                                <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="px-4 py-3">
                            <Badge variant="secondary" className="text-[11px]">
                              {member.role_label}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-4 py-3">
                            <a
                              href={`mailto:${member.email}`}
                              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {member.email}
                            </a>
                          </TableCell>
                          <TableCell className="px-4 py-3 text-center text-sm text-muted-foreground">
                            {workloadText}
                          </TableCell>
                          <TableCell className="px-4 py-3 text-center">
                            <Badge variant="outline" className="capitalize">
                              {member.status ?? "active"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-4 py-3 text-center">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/people/${member.user_id}`}>View profile</Link>
                                </DropdownMenuItem>
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent>
                                    {projectRoles.map((role) => (
                                      <DropdownMenuItem
                                        key={role.id}
                                        disabled={role.id === member.role_id}
                                        onClick={() => handleRoleChange(member.id, role.id)}
                                      >
                                        {role.label}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleRemoveMember(member.id)}
                                >
                                  Remove from project
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : teamMembers.length > 0 ? (
              <Card>
                <CardContent className="py-12">
                  <div className="flex flex-col items-center justify-center text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                      <Search className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="font-medium">No matches found</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Try adjusting your search or filter.
                    </p>
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={() => {
                        setTeamSearch("")
                        setRoleFilter("all")
                      }}
                    >
                      Clear filters
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-16">
                  <div className="flex flex-col items-center justify-center text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                      <Users className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold">No team members yet</h3>
                    <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                      Add people from your organization to collaborate on this project.
                    </p>
                    <Button className="mt-6" onClick={() => { setTeamSheetOpen(true); void loadTeamDirectory() }}>
                      <UserPlus className="mr-2 h-4 w-4" />
                      Add first member
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            <Separator className="my-6" />

            <div className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">External directory</h3>
                  <p className="text-sm text-muted-foreground">
                    Manage subcontractors, vendors, and client contacts tied to this project.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative w-[220px]">
                    <Input
                      value={vendorSearch}
                      onChange={(e) => setVendorSearch(e.target.value)}
                      placeholder="Search directory"
                      className="pr-12"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 border-0 shadow-none hover:bg-muted"
                        >
                          <Filter className="h-4 w-4" />
                          <span className="sr-only">Filters</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>Filter by role</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioGroup
                          value={vendorRoleFilter}
                          onValueChange={(value) => setVendorRoleFilter(value as "all" | ProjectVendorInput["role"])}
                        >
                          {DIRECTORY_ROLE_FILTERS.map((option) => (
                            <DropdownMenuRadioItem key={option.value} value={option.value}>
                              {option.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <Button size="icon" onClick={() => setDirectoryAssignOpen(true)} disabled={teamLoading}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <ProjectDirectory
                projectId={project.id}
                vendors={projectVendorsState}
                contacts={contacts}
                companies={companies}
                onAdd={handleAddVendor}
                onRemove={handleRemoveVendor}
                onUpdate={handleUpdateVendor}
                loading={teamLoading}
                search={vendorSearch}
                onSearchChange={setVendorSearch}
                roleFilter={vendorRoleFilter}
                onRoleFilterChange={(value) => setVendorRoleFilter(value as "all" | ProjectVendorInput["role"])}
                hideHeader
              />
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Add Member Sheet */}
      <Sheet open={teamSheetOpen} onOpenChange={setTeamSheetOpen}>
        <SheetContent
          side="right"
          className="sm:max-w-md w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col"
        >
          <div className="flex-1 overflow-y-auto px-4">
            <SheetHeader className="pt-6 pb-4">
              <SheetTitle className="text-lg font-semibold leading-none tracking-tight">Add team member</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                Select people from your organization to add to this project.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4">
              <Select
                value={selectedRoleId ?? projectRoles[0]?.id ?? ""}
                onValueChange={setSelectedRoleId}
                disabled={!projectRoles.length}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {projectRoles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="rounded-lg border">
                <div className="flex items-center gap-2 border-b px-3 py-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <Input
                    value={directorySearch}
                    onChange={(e) => setDirectorySearch(e.target.value)}
                    placeholder="Search people..."
                    className="h-8 border-0 shadow-none focus-visible:ring-0"
                  />
                </div>
                <ScrollArea className="h-[400px]">
                  <div className="divide-y">
                    {filteredDirectory.length > 0 ? (
                      filteredDirectory.map((person) => {
                        const isSelected = selectedUserIds.has(person.user_id)
                        const alreadyOnProject = Boolean(person.project_member_id)
                        const isYou = person.is_current_user
                        return (
                          <button
                            key={person.user_id}
                            type="button"
                            onClick={() => {
                              if (alreadyOnProject) return
                              toggleUserSelection(person.user_id)
                            }}
                            className={cn(
                              "flex w-full items-center gap-3 px-3 py-3 text-left transition hover:bg-muted/60",
                              isSelected && "bg-primary/10",
                              alreadyOnProject && "cursor-not-allowed opacity-60"
                            )}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => {
                                if (alreadyOnProject) return
                                toggleUserSelection(person.user_id)
                              }}
                              disabled={alreadyOnProject}
                            />
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={person.avatar_url} alt={person.full_name} />
                              <AvatarFallback className="text-xs">{getInitials(person.full_name)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium truncate">{person.full_name}</p>
                                {isYou && (
                                  <Badge variant="outline" className="text-[10px]">
                                    You
                                  </Badge>
                                )}
                                {alreadyOnProject && (
                                  <Badge variant="secondary" className="text-[10px]">
                                    On project
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground truncate">{person.email}</p>
                            </div>
                          </button>
                        )
                      })
                    ) : (
                      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                        No people found
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </div>
          <div className="flex-shrink-0 border-t bg-background p-4">
            <Button
              className="w-full"
              disabled={selectedUserIds.size === 0 || teamLoading || teamDirectoryLoading}
              onClick={handleAddMembers}
            >
              {teamLoading ? "Adding..." : `Add ${selectedUserIds.size || ""} ${selectedUserIds.size === 1 ? "person" : "people"}`}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex-1 overflow-y-auto space-y-6 pr-2">
        {/* Timeline Progress Bar */}
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Project Timeline</span>
              <span className="text-sm text-muted-foreground">
                {progressPercentage}% elapsed • {stats.scheduleProgress}% complete
              </span>
            </div>
            <div className="relative h-3 bg-muted overflow-hidden">
              {/* Time elapsed bar */}
              <div
                className="absolute inset-y-0 left-0 bg-muted-foreground/30"
                style={{ width: `${progressPercentage}%` }}
              />
              {/* Work completed bar */}
              <div
                className="absolute inset-y-0 left-0 bg-primary"
                style={{ width: `${stats.scheduleProgress}%` }}
              />
              {/* Today marker */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-foreground"
                style={{ left: `${progressPercentage}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-muted-foreground">
              <span>{project.start_date ? format(parseISO(project.start_date), "MMM d") : "Start"}</span>
              <span>{project.end_date ? format(parseISO(project.end_date), "MMM d") : "End"}</span>
            </div>
          </CardContent>
        </Card>

          <ProjectPipelineChecklist
            project={project}
            proposals={proposals}
            contract={contract}
            draws={draws}
            scheduleItems={scheduleItems}
            portalTokens={portalTokensState}
            onOpenSetupWizard={() => setSetupWizardOpen(true)}
            onOpenProjectSettings={() => setSettingsSheetOpen(true)}
            onOpenShare={() => setSharingSheetOpen(true)}
          />

          {stats.budgetSummary && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="space-y-1">
                  <CardTitle className="text-sm font-medium">Budget Summary</CardTitle>
                  <CardDescription>Budget vs committed vs actual with variance.</CardDescription>
                </div>
                <Badge
                  variant="outline"
                  className={
                    stats.budgetSummary.variancePercent > 100
                      ? "border-destructive/40 text-destructive"
                      : stats.budgetSummary.variancePercent > 90
                        ? "border-amber-500/50 text-amber-500"
                        : "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
                  }
                >
                  {stats.budgetSummary.variancePercent}% of budget
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-4">
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="text-xs text-muted-foreground">Adjusted budget</p>
                    <p className="text-lg font-semibold">
                      {(stats.budgetSummary.adjustedBudgetCents / 100).toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="text-xs text-muted-foreground">Committed</p>
                    <p className="text-lg font-semibold">
                      {(stats.budgetSummary.totalCommittedCents / 100).toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="text-xs text-muted-foreground">Actual</p>
                    <p className="text-lg font-semibold">
                      {(stats.budgetSummary.totalActualCents / 100).toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="text-xs text-muted-foreground">Invoiced</p>
                    <p className="text-lg font-semibold">
                      {(stats.budgetSummary.totalInvoicedCents / 100).toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 items-center">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Variance</span>
                    <span
                      className={
                        stats.budgetSummary.variancePercent > 100
                          ? "text-destructive font-semibold"
                          : stats.budgetSummary.variancePercent > 90
                            ? "text-amber-500 font-semibold"
                            : "text-emerald-600 dark:text-emerald-300 font-semibold"
                      }
                    >
                      {stats.budgetSummary.variancePercent}% (
                      {(stats.budgetSummary.varianceCents / 100).toLocaleString("en-US", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 0,
                      })}
                      )
                    </span>
                  </div>
                  <Separator orientation="vertical" className="h-6" />
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Gross margin</span>
                    <span className="font-semibold">{stats.budgetSummary.grossMarginPercent}%</span>
                  </div>
                  {typeof stats.budgetSummary.trendPercent === "number" && (
                    <>
                      <Separator orientation="vertical" className="h-6" />
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Trend vs prior snapshot</span>
                        <span
                          className={
                            stats.budgetSummary.trendPercent > 0
                              ? "text-amber-500 font-semibold"
                              : stats.budgetSummary.trendPercent < 0
                                ? "text-emerald-600 dark:text-emerald-300 font-semibold"
                                : "text-muted-foreground"
                          }
                        >
                          {stats.budgetSummary.trendPercent > 0 ? "▲" : stats.budgetSummary.trendPercent < 0 ? "▼" : "→"}{" "}
                          {Math.abs(Math.round(stats.budgetSummary.trendPercent))}%
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Stats Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Tasks</CardTitle>
                <CheckCircle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.completedTasks}/{stats.totalTasks}</div>
                <p className="text-xs text-muted-foreground">
                  {stats.openTasks} open • {stats.overdueTasks > 0 && (
                    <span className="text-destructive">{stats.overdueTasks} overdue</span>
                  )}
                </p>
                <Progress value={stats.totalTasks > 0 ? (stats.completedTasks / stats.totalTasks) * 100 : 0} className="mt-2" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Schedule Health</CardTitle>
                {stats.atRiskItems > 0 ? (
                  <AlertCircle className="h-4 w-4 text-warning" />
                ) : (
                  <TrendingUp className="h-4 w-4 text-success" />
                )}
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.scheduleProgress}%</div>
                <p className="text-xs text-muted-foreground">
                  {stats.atRiskItems > 0 ? (
                    <span className="text-warning">{stats.atRiskItems} items at risk</span>
                  ) : (
                    "On track"
                  )}
                </p>
                <Progress value={stats.scheduleProgress} className="mt-2" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Milestones</CardTitle>
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.upcomingMilestones}</div>
                <p className="text-xs text-muted-foreground">upcoming milestones</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Field Activity</CardTitle>
                <Camera className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.recentPhotos}</div>
                <p className="text-xs text-muted-foreground">
                  photos • {stats.openPunchItems} punch items
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Recent Activity */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Recent Activity</CardTitle>
                <CardDescription>Latest updates on this project</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[320px] pr-4">
                  <div className="space-y-4">
                    {activity.length > 0 ? activity.map((event) => {
                      const { icon, title, description } = formatActivityEvent(event)
                      return (
                        <div key={event.id} className="flex gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                            {icon}
                          </div>
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-medium leading-none">{title}</p>
                            {description && (
                              <p className="text-sm text-muted-foreground">{description}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {formatDistanceToNow(parseISO(event.created_at), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      )
                    }) : (
                      <p className="text-sm text-muted-foreground text-center py-8">No recent activity</p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Upcoming Items */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Coming Up</CardTitle>
                <CardDescription>Upcoming schedule items</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {upcomingItems.length > 0 ? upcomingItems.map((item) => (
                    <div key={item.id} className="flex items-start gap-3 rounded-lg border p-3">
                      <div className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-medium",
                        item.item_type === "milestone" ? "bg-chart-3/20 text-chart-3" : "bg-muted"
                      )}>
                        {item.start_date ? format(parseISO(item.start_date), "dd") : "—"}
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium leading-none">{item.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{item.item_type}</p>
                      </div>
                      <Badge variant="outline" className={scheduleStatusColors[item.status] ?? ""}>
                        {item.progress ?? 0}%
                      </Badge>
                    </div>
                  )) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No upcoming items</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* At Risk Section */}
        {atRiskItems.length > 0 && (
          <Card className="border-warning/50">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-warning" />
                <CardTitle className="text-base">Attention Required</CardTitle>
              </div>
              <CardDescription>Items that need immediate attention</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {atRiskItems.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center justify-between rounded-lg border border-warning/30 bg-warning/5 p-3">
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.end_date ? `Due ${format(parseISO(item.end_date), "MMM d")}` : "No end date"}
                      </p>
                    </div>
                    <Badge variant="outline" className={scheduleStatusColors[item.status] ?? "bg-warning/20 text-warning"}>
                      {item.status.replace("_", " ")}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
