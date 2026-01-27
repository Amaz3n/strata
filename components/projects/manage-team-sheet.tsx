"use client"

import { useEffect, useMemo, useState, useCallback } from "react"
import Link from "next/link"
import { toast } from "sonner"

import type { Company, Contact, ProjectVendor } from "@/lib/types"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"

import {
  addProjectMembersAction,
  getProjectTeamDirectoryAction,
  getProjectVendorsAction,
  removeProjectMemberAction,
  removeProjectVendorAction,
  updateProjectMemberRoleAction,
  updateProjectVendorAction,
  addProjectVendorAction,
  createAndAssignVendorAction,
} from "@/app/(app)/projects/[id]/actions"
import type { ProjectRoleOption, ProjectTeamMember, TeamDirectoryEntry } from "@/app/(app)/projects/[id]/actions"

import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  MoreHorizontal,
  Plus,
  Search,
  Users,
  Building2,
  X,
  Check,
  UserPlus,
  ExternalLink,
  Mail,
  Phone,
  ChevronRight,
  Briefcase,
} from "@/components/icons"

export interface ManageTeamSheetProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  team: ProjectTeamMember[]
  contacts: Contact[]
  companies: Company[]
  projectVendors: ProjectVendor[]
}

type ViewMode = "team" | "directory"

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

const VENDOR_ROLE_LABELS: Record<string, string> = {
  subcontractor: "Subcontractor",
  supplier: "Supplier",
  consultant: "Consultant",
  architect: "Architect",
  engineer: "Engineer",
  client: "Client",
}

export function ManageTeamSheet({
  projectId,
  open,
  onOpenChange,
  team,
  contacts,
  companies,
  projectVendors,
}: ManageTeamSheetProps) {
  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("team")
  const [searchQuery, setSearchQuery] = useState("")

  // Local state synced with props
  const [teamMembers, setTeamMembers] = useState<ProjectTeamMember[]>(team)
  const [projectVendorsState, setProjectVendorsState] = useState<ProjectVendor[]>(projectVendors)

  useEffect(() => setTeamMembers(team), [team])
  useEffect(() => setProjectVendorsState(projectVendors), [projectVendors])

  // Loading states
  const [loading, setLoading] = useState(false)
  const [directoryLoading, setDirectoryLoading] = useState(false)

  // Directory data
  const [projectRoles, setProjectRoles] = useState<ProjectRoleOption[]>([])
  const [availablePeople, setAvailablePeople] = useState<TeamDirectoryEntry[]>([])

  // Add member mode
  const [addMode, setAddMode] = useState<"team" | "vendor" | null>(null)
  const [selectedRoleId, setSelectedRoleId] = useState<string | undefined>()
  const [selectedVendorRole, setSelectedVendorRole] = useState<ProjectVendorInput["role"]>("subcontractor")

  // Quick create vendor
  const [quickCreateName, setQuickCreateName] = useState("")
  const [quickCreateType, setQuickCreateType] = useState<"company" | "contact">("company")

  async function refreshProjectVendors() {
    const refreshed = await getProjectVendorsAction(projectId)
    setProjectVendorsState(refreshed)
  }

  async function loadTeamDirectory() {
    setDirectoryLoading(true)
    try {
      const { roles, people } = await getProjectTeamDirectoryAction(projectId)
      setProjectRoles(roles)
      setAvailablePeople(people)
      if (!selectedRoleId && roles.length > 0) setSelectedRoleId(roles[0].id)
    } catch (error) {
      console.error(error)
      toast.error("Unable to load team directory")
    } finally {
      setDirectoryLoading(false)
    }
  }

  useEffect(() => {
    if (open) void loadTeamDirectory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Reset search when switching views
  useEffect(() => {
    setSearchQuery("")
    setAddMode(null)
  }, [viewMode])

  // Reset state when sheet closes
  useEffect(() => {
    if (!open) {
      setAddMode(null)
      setSearchQuery("")
      setQuickCreateName("")
    }
  }, [open])

  async function handleAddMember(userId: string) {
    const roleId = selectedRoleId ?? projectRoles[0]?.id
    if (!roleId) {
      toast.error("Choose a project role first")
      return
    }

    setLoading(true)
    try {
      const added = await addProjectMembersAction(projectId, { userIds: [userId], roleId })
      setTeamMembers((prev) => {
        const map = new Map(prev.map((m) => [m.user_id, m]))
        added.forEach((m) => map.set(m.user_id, m))
        return Array.from(map.values())
      })
      toast.success("Added to project")
      await loadTeamDirectory()
    } catch (error) {
      console.error(error)
      toast.error("Failed to add member")
    } finally {
      setLoading(false)
    }
  }

  async function handleRemoveMember(memberId: string) {
    setLoading(true)
    try {
      await removeProjectMemberAction(projectId, memberId)
      setTeamMembers((prev) => prev.filter((m) => m.id !== memberId))
      toast.success("Removed from project")
      await loadTeamDirectory()
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove member")
    } finally {
      setLoading(false)
    }
  }

  async function handleRoleChange(memberId: string, roleId: string) {
    setLoading(true)
    try {
      const updated = await updateProjectMemberRoleAction(projectId, memberId, roleId)
      setTeamMembers((prev) => prev.map((m) => (m.id === memberId ? updated : m)))
      toast.success("Role updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to update role")
    } finally {
      setLoading(false)
    }
  }

  async function handleAssignVendor(entity: { type: "company" | "contact"; id: string }) {
    setLoading(true)
    try {
      await addProjectVendorAction(projectId, {
        project_id: projectId,
        company_id: entity.type === "company" ? entity.id : undefined,
        contact_id: entity.type === "contact" ? entity.id : undefined,
        role: selectedVendorRole,
      })
      await refreshProjectVendors()
      toast.success("Added to project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to add")
    } finally {
      setLoading(false)
    }
  }

  async function handleRemoveVendor(vendorId: string) {
    setLoading(true)
    try {
      await removeProjectVendorAction(projectId, vendorId)
      setProjectVendorsState((prev) => prev.filter((v) => v.id !== vendorId))
      toast.success("Removed from project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove")
    } finally {
      setLoading(false)
    }
  }

  async function handleQuickCreateVendor() {
    if (!quickCreateName.trim()) return

    setLoading(true)
    try {
      await createAndAssignVendorAction(projectId, {
        kind: quickCreateType,
        name: quickCreateName.trim(),
        role: selectedVendorRole,
      })
      await refreshProjectVendors()
      setQuickCreateName("")
      setAddMode(null)
      toast.success("Created and added to project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to create")
    } finally {
      setLoading(false)
    }
  }

  // Filtered lists
  const filteredTeam = useMemo(() => {
    const search = searchQuery.trim().toLowerCase()
    return teamMembers.filter((member) => {
      if (!search) return true
      return (
        member.full_name.toLowerCase().includes(search) ||
        member.email.toLowerCase().includes(search) ||
        member.role_label?.toLowerCase().includes(search)
      )
    })
  }, [searchQuery, teamMembers])

  const filteredVendors = useMemo(() => {
    const search = searchQuery.trim().toLowerCase()
    return projectVendorsState.filter((vendor) => {
      if (!search) return true
      const haystack = [
        vendor.company?.name,
        vendor.company?.trade,
        vendor.contact?.full_name,
        vendor.contact?.email,
        vendor.role,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(search)
    })
  }, [searchQuery, projectVendorsState])

  // Available people not yet on project
  const availableToAdd = useMemo(() => {
    const search = searchQuery.trim().toLowerCase()
    return availablePeople
      .filter((person) => !person.project_member_id)
      .filter((person) => {
        if (!search) return true
        return (
          person.full_name.toLowerCase().includes(search) ||
          person.email.toLowerCase().includes(search)
        )
      })
  }, [availablePeople, searchQuery])

  // Available vendors not yet assigned
  const assignedCompanyIds = useMemo(
    () => new Set(projectVendorsState.map((v) => v.company_id).filter(Boolean) as string[]),
    [projectVendorsState]
  )
  const assignedContactIds = useMemo(
    () => new Set(projectVendorsState.map((v) => v.contact_id).filter(Boolean) as string[]),
    [projectVendorsState]
  )

  const availableVendors = useMemo(() => {
    const search = searchQuery.trim().toLowerCase()
    const companyOptions = companies
      ?.filter((c) => !assignedCompanyIds.has(c.id))
      .map((c) => ({
        id: c.id,
        type: "company" as const,
        name: c.name,
        subtitle: c.trade || c.company_type,
      })) ?? []
    const contactOptions = contacts
      ?.filter((c) => !assignedContactIds.has(c.id))
      .map((c) => ({
        id: c.id,
        type: "contact" as const,
        name: c.full_name,
        subtitle: c.email || c.role,
      })) ?? []
    const combined = [...companyOptions, ...contactOptions]
    if (!search) return combined
    return combined.filter((item) =>
      item.name.toLowerCase().includes(search) ||
      (item.subtitle?.toLowerCase().includes(search) ?? false)
    )
  }, [searchQuery, companies, contacts, assignedCompanyIds, assignedContactIds])

  const counts = {
    team: teamMembers.length,
    directory: projectVendorsState.length,
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 gap-0 overflow-hidden fast-sheet-animation"
      >
        {/* Header */}
        <div className="shrink-0 border-b bg-background">
          <SheetHeader className="px-5 pt-5 pb-4">
            <SheetTitle className="text-base font-semibold">Project Team</SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Manage who has access to this project
            </SheetDescription>
          </SheetHeader>

          {/* View toggle */}
          <div className="px-5 pb-4">
            <div className="flex p-1 bg-muted/50 rounded-lg">
              <button
                onClick={() => setViewMode("team")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all",
                  viewMode === "team"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Users className="h-4 w-4" />
                <span>Team</span>
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px] font-medium">
                  {counts.team}
                </Badge>
              </button>
              <button
                onClick={() => setViewMode("directory")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all",
                  viewMode === "directory"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Building2 className="h-4 w-4" />
                <span>Directory</span>
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px] font-medium">
                  {counts.directory}
                </Badge>
              </button>
            </div>
          </div>
        </div>

        {/* Search + Add */}
        <div className="shrink-0 px-5 py-3 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={viewMode === "team" ? "Search team members..." : "Search directory..."}
                className="pl-9 h-9 bg-background"
              />
            </div>
            <Button
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setAddMode(viewMode === "team" ? "team" : "vendor")}
              disabled={loading}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Add</span>
            </Button>
          </div>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1">
          {viewMode === "team" ? (
            <div className="p-3">
              {filteredTeam.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title={teamMembers.length === 0 ? "No team members yet" : "No results"}
                  description={
                    teamMembers.length === 0
                      ? "Add people from your organization to collaborate on this project."
                      : "Try adjusting your search."
                  }
                  action={
                    teamMembers.length === 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAddMode("team")}
                      >
                        <UserPlus className="h-4 w-4 mr-2" />
                        Add first member
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="space-y-2">
                  {filteredTeam.map((member) => (
                    <TeamMemberCard
                      key={member.id}
                      member={member}
                      projectRoles={projectRoles}
                      onRoleChange={(roleId) => handleRoleChange(member.id, roleId)}
                      onRemove={() => handleRemoveMember(member.id)}
                      loading={loading}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3">
              {filteredVendors.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title={projectVendorsState.length === 0 ? "No directory entries" : "No results"}
                  description={
                    projectVendorsState.length === 0
                      ? "Add subcontractors, suppliers, and other external contacts."
                      : "Try adjusting your search."
                  }
                  action={
                    projectVendorsState.length === 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAddMode("vendor")}
                      >
                        <Building2 className="h-4 w-4 mr-2" />
                        Add first entry
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="space-y-2">
                  {filteredVendors.map((vendor) => (
                    <VendorCard
                      key={vendor.id}
                      vendor={vendor}
                      onRemove={() => handleRemoveVendor(vendor.id)}
                      loading={loading}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Add Team Member Panel */}
        {addMode === "team" && (
          <div className="absolute inset-0 bg-background flex flex-col z-10">
            <div className="shrink-0 px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Add Team Member</h3>
                <p className="text-sm text-muted-foreground">Select people from your organization</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setAddMode(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Role selector */}
            <div className="shrink-0 px-5 py-3 border-b bg-muted/30">
              <Select
                value={selectedRoleId ?? projectRoles[0]?.id ?? ""}
                onValueChange={setSelectedRoleId}
                disabled={!projectRoles.length}
              >
                <SelectTrigger className="h-9 bg-background">
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
            </div>

            <Command className="flex-1 border-none">
              <CommandInput
                placeholder="Search people..."
                value={searchQuery}
                onValueChange={setSearchQuery}
              />
              <CommandList className="max-h-none flex-1">
                <CommandEmpty>No people found</CommandEmpty>
                <CommandGroup>
                  {availableToAdd.map((person) => (
                    <CommandItem
                      key={person.user_id}
                      value={`${person.full_name} ${person.email}`}
                      onSelect={() => handleAddMember(person.user_id)}
                      disabled={loading}
                      className="gap-3 py-3"
                    >
                      <Avatar className="h-9 w-9">
                        <AvatarImage src={person.avatar_url} alt={person.full_name} />
                        <AvatarFallback className="text-xs bg-muted">
                          {getInitials(person.full_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{person.full_name}</span>
                          {person.is_current_user && (
                            <Badge variant="outline" className="text-[10px] h-4">You</Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground truncate block">
                          {person.email}
                        </span>
                      </div>
                      <Plus className="h-4 w-4 text-muted-foreground" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        )}

        {/* Add Vendor Panel */}
        {addMode === "vendor" && (
          <div className="absolute inset-0 bg-background flex flex-col z-10">
            <div className="shrink-0 px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-semibold">Add to Directory</h3>
                <p className="text-sm text-muted-foreground">Assign existing or create new</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  setAddMode(null)
                  setQuickCreateName("")
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Role selector */}
            <div className="shrink-0 px-5 py-3 border-b bg-muted/30">
              <Select
                value={selectedVendorRole}
                onValueChange={(v) => setSelectedVendorRole(v as ProjectVendorInput["role"])}
              >
                <SelectTrigger className="h-9 bg-background">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subcontractor">Subcontractor</SelectItem>
                  <SelectItem value="supplier">Supplier</SelectItem>
                  <SelectItem value="consultant">Consultant</SelectItem>
                  <SelectItem value="architect">Architect</SelectItem>
                  <SelectItem value="engineer">Engineer</SelectItem>
                  <SelectItem value="client">Client</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Command className="flex-1 border-none">
              <CommandInput
                placeholder="Search or type to create..."
                value={searchQuery}
                onValueChange={(v) => {
                  setSearchQuery(v)
                  setQuickCreateName(v)
                }}
              />
              <CommandList className="max-h-none flex-1">
                {searchQuery.trim() && availableVendors.length === 0 && (
                  <div className="p-2">
                    <button
                      className="w-full flex items-center gap-3 p-3 rounded-lg border border-dashed hover:border-primary hover:bg-primary/5 transition-colors text-left"
                      onClick={handleQuickCreateVendor}
                      disabled={loading}
                    >
                      <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                        <Plus className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium block">Create "{searchQuery.trim()}"</span>
                        <div className="flex items-center gap-2 mt-0.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setQuickCreateType("company")
                            }}
                            className={cn(
                              "text-xs px-2 py-0.5 rounded-full transition-colors",
                              quickCreateType === "company"
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:text-foreground"
                            )}
                          >
                            Company
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setQuickCreateType("contact")
                            }}
                            className={cn(
                              "text-xs px-2 py-0.5 rounded-full transition-colors",
                              quickCreateType === "contact"
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:text-foreground"
                            )}
                          >
                            Contact
                          </button>
                        </div>
                      </div>
                    </button>
                  </div>
                )}

                {availableVendors.length > 0 && (
                  <>
                    {searchQuery.trim() && (
                      <div className="p-2 pb-0">
                        <button
                          className="w-full flex items-center gap-3 p-3 rounded-lg border border-dashed hover:border-primary hover:bg-primary/5 transition-colors text-left"
                          onClick={handleQuickCreateVendor}
                          disabled={loading}
                        >
                          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                            <Plus className="h-4 w-4 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="font-medium">Create "{searchQuery.trim()}"</span>
                          </div>
                        </button>
                      </div>
                    )}
                    <CommandGroup heading="Existing">
                      {availableVendors.map((item) => (
                        <CommandItem
                          key={`${item.type}-${item.id}`}
                          value={`${item.name} ${item.subtitle ?? ""}`}
                          onSelect={() => handleAssignVendor({ type: item.type, id: item.id })}
                          disabled={loading}
                          className="gap-3 py-3"
                        >
                          <Avatar className="h-9 w-9">
                            <AvatarFallback className="text-xs bg-muted">
                              {item.type === "company" ? (
                                <Building2 className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                getInitials(item.name)
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{item.name}</span>
                              <Badge variant="outline" className="text-[10px] h-4 capitalize">
                                {item.type}
                              </Badge>
                            </div>
                            {item.subtitle && (
                              <span className="text-xs text-muted-foreground truncate block">
                                {item.subtitle}
                              </span>
                            )}
                          </div>
                          <Plus className="h-4 w-4 text-muted-foreground" />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}

                {!searchQuery.trim() && availableVendors.length === 0 && (
                  <CommandEmpty>
                    <div className="text-center py-6">
                      <p className="text-sm text-muted-foreground">No companies or contacts available</p>
                      <p className="text-xs text-muted-foreground mt-1">Type a name to create one</p>
                    </div>
                  </CommandEmpty>
                )}
              </CommandList>
            </Command>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// Team Member Card
function TeamMemberCard({
  member,
  projectRoles,
  onRoleChange,
  onRemove,
  loading,
}: {
  member: ProjectTeamMember
  projectRoles: ProjectRoleOption[]
  onRoleChange: (roleId: string) => void
  onRemove: () => void
  loading: boolean
}) {
  return (
    <div className="group flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors">
      <Avatar className="h-10 w-10">
        <AvatarImage src={member.avatar_url} alt={member.full_name} />
        <AvatarFallback className="text-sm bg-muted">
          {getInitials(member.full_name)}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Link
            href={`/people/${member.user_id}`}
            className="font-medium text-sm hover:underline truncate"
          >
            {member.full_name}
          </Link>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate">{member.email}</span>
        </div>
      </div>

      <Select
        value={member.role_id ?? ""}
        onValueChange={onRoleChange}
        disabled={loading}
      >
        <SelectTrigger className="h-7 w-auto gap-1 border-none bg-muted/50 hover:bg-muted px-2 text-xs font-medium shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {projectRoles.map((role) => (
            <SelectItem key={role.id} value={role.id} className="text-xs">
              {role.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
            disabled={loading}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/people/${member.user_id}`} className="gap-2">
              <ExternalLink className="h-4 w-4" />
              View profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`mailto:${member.email}`} className="gap-2">
              <Mail className="h-4 w-4" />
              Send email
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive gap-2"
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
            Remove from project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Vendor Card
function VendorCard({
  vendor,
  onRemove,
  loading,
}: {
  vendor: ProjectVendor
  onRemove: () => void
  loading: boolean
}) {
  const name = vendor.company?.name ?? vendor.contact?.full_name ?? "Unknown"
  const email = vendor.contact?.email ?? vendor.company?.email
  const phone = vendor.contact?.phone ?? vendor.company?.phone
  const trade = vendor.company?.trade
  const roleLabel = VENDOR_ROLE_LABELS[vendor.role] ?? vendor.role

  return (
    <div className="group flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors">
      <Avatar className="h-10 w-10 mt-0.5">
        <AvatarFallback className="text-sm bg-muted">
          {vendor.company ? (
            <Building2 className="h-4 w-4 text-muted-foreground" />
          ) : (
            getInitials(name)
          )}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{name}</span>
          <Badge variant="secondary" className="text-[10px] h-4 shrink-0">
            {roleLabel}
          </Badge>
        </div>

        {trade && (
          <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
            <Briefcase className="h-3 w-3" />
            <span>{trade}</span>
          </div>
        )}

        <div className="flex items-center gap-3 mt-1.5">
          {email && (
            <a
              href={`mailto:${email}`}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Mail className="h-3 w-3" />
              <span className="truncate max-w-[140px]">{email}</span>
            </a>
          )}
          {phone && (
            <a
              href={`tel:${phone}`}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Phone className="h-3 w-3" />
              <span>{phone}</span>
            </a>
          )}
        </div>

        {vendor.scope && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
            {vendor.scope}
          </p>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
        onClick={onRemove}
        disabled={loading}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}

// Empty State
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="font-medium text-sm">{title}</h3>
      <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
