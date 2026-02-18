"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import type { Contact, Contract, PortalAccessToken, Project, Proposal } from "@/lib/types"
import type { ProjectTeamMember, TeamDirectoryEntry } from "./actions"
import {
  applyScheduleTemplateAction,
  createClientContactAndAssignAction,
  createDrawScheduleFromContractAction,
  getProjectTeamDirectoryAction,
  listScheduleTemplatesAction,
  sendClientPortalInviteAction,
  setProjectManagerAction,
  updateProjectSettingsAction,
} from "./actions"
import { createPortalTokenAction } from "@/app/(app)/sharing/actions"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  DollarSign,
  FileText,
  Link2,
  MapPin,
  Settings,
  Sparkles,
  Users,
} from "@/components/icons"
import { cn } from "@/lib/utils"

type ScheduleTemplate = {
  id: string
  name: string
  description?: string
}

type DrawPreset = {
  key: string
  label: string
  description: string
  draws: Array<{ title: string; percent: number }>
}

const DRAW_PRESETS: DrawPreset[] = [
  {
    key: "five_draw",
    label: "5 draws (common)",
    description: "Deposit → Foundation → Framing → Dry-in → Completion",
    draws: [
      { title: "Deposit", percent: 10 },
      { title: "Foundation", percent: 20 },
      { title: "Framing", percent: 25 },
      { title: "Dry-in", percent: 25 },
      { title: "Completion", percent: 20 },
    ],
  },
  {
    key: "three_draw",
    label: "3 draws (simple)",
    description: "Start → Midpoint → Completion",
    draws: [
      { title: "Start", percent: 30 },
      { title: "Midpoint", percent: 40 },
      { title: "Completion", percent: 30 },
    ],
  },
]

export function ProjectSetupWizardSheet({
  open,
  onOpenChange,
  onOpenProjectSettings,
  onOpenTeamSheet,
  project,
  contacts,
  team,
  proposals,
  contract,
  scheduleItemCount,
  drawsCount,
  portalTokens,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: Project
  contacts: Contact[]
  team: ProjectTeamMember[]
  proposals: Proposal[]
  contract: Contract | null
  scheduleItemCount: number
  drawsCount: number
  portalTokens: PortalAccessToken[]
  onOpenProjectSettings?: () => void
  onOpenTeamSheet?: () => void
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState("basics")
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [hasAttemptedTemplateLoad, setHasAttemptedTemplateLoad] = useState(false)
  const [directoryPeople, setDirectoryPeople] = useState<TeamDirectoryEntry[]>([])
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [hasAttemptedDirectoryLoad, setHasAttemptedDirectoryLoad] = useState(false)

  const safeContacts = useMemo(() => (Array.isArray(contacts) ? contacts : []), [contacts])
  const safeTeam = useMemo(() => (Array.isArray(team) ? team : []), [team])
  const [localContacts, setLocalContacts] = useState<Contact[]>(safeContacts)
  const [createdClientPortalToken, setCreatedClientPortalToken] = useState<PortalAccessToken | null>(null)

  const [savingBasics, startSavingBasics] = useTransition()
  const [savingPm, startSavingPm] = useTransition()
  const [applyingTemplate, startApplyingTemplate] = useTransition()
  const [creatingDraws, startCreatingDraws] = useTransition()
  const [creatingPortal, startCreatingPortal] = useTransition()
  const [creatingContact, startCreatingContact] = useTransition()
  const [sendingPortalInvite, startSendingPortalInvite] = useTransition()

  const [projectStatus, setProjectStatus] = useState<Project["status"]>(project.status)
  const [address, setAddress] = useState(project.address ?? "")
  const [startDate, setStartDate] = useState(project.start_date ?? "")
  const [totalValue, setTotalValue] = useState(project.total_value ? String(project.total_value) : "")
  const [clientId, setClientId] = useState<string>(project.client_id ?? "none")

  const [newClientName, setNewClientName] = useState("")
  const [newClientEmail, setNewClientEmail] = useState("")
  const [newClientPhone, setNewClientPhone] = useState("")

  const [pmUserId, setPmUserId] = useState<string>("")
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("")
  const [drawPresetKey, setDrawPresetKey] = useState<string>(DRAW_PRESETS[0].key)
  const [portalOrigin, setPortalOrigin] = useState("")

  const activeClientPortalToken = useMemo(
    () => {
      if (createdClientPortalToken && !createdClientPortalToken.revoked_at) return createdClientPortalToken
      return (Array.isArray(portalTokens) ? portalTokens : []).find((token) => token.portal_type === "client" && !token.revoked_at) ?? null
    },
    [createdClientPortalToken, portalTokens],
  )

  const hasClientPortal = useMemo(
    () => !!activeClientPortalToken,
    [activeClientPortalToken],
  )
  const hasProposal = useMemo(() => proposals.length > 0, [proposals])

  const hasAcceptedProposal = useMemo(
    () => proposals.some((p) => p.status === "accepted" || !!p.accepted_at),
    [proposals],
  )
  const hasContract = !!contract

  const pmCandidates = useMemo(() => {
    const members = new Map<string, { user_id: string; full_name: string; email: string; source: "project" | "org" }>()

    safeTeam.forEach((member) => {
      members.set(member.user_id, {
        user_id: member.user_id,
        full_name: member.full_name,
        email: member.email ?? "",
        source: "project",
      })
    })

    directoryPeople.forEach((person) => {
      if (members.has(person.user_id)) return
      members.set(person.user_id, {
        user_id: person.user_id,
        full_name: person.full_name,
        email: person.email ?? "",
        source: "org",
      })
    })

    return Array.from(members.values()).sort((a, b) => a.full_name.localeCompare(b.full_name))
  }, [directoryPeople, safeTeam])

  const selectedClientContactId = clientId !== "none" ? clientId : (project.client_id ?? activeClientPortalToken?.contact_id ?? null)
  const selectedClientContact = localContacts.find((contact) => contact.id === selectedClientContactId)
  const portalLink = activeClientPortalToken
    ? `${portalOrigin || process.env.NEXT_PUBLIC_APP_URL || ""}/p/${activeClientPortalToken.token}`
    : ""

  const steps = useMemo(() => {
    const hasClient = clientId !== "none"
    const hasPm = !!pmUserId || safeTeam.some((m) => m.role === "pm" || m.role === "project_manager")
    return [
      {
        key: "basics",
        label: "Basics",
        description: "Client, status, dates, and value.",
        icon: MapPin,
        done: hasClient && !!address.trim(),
      },
      {
        key: "precon",
        label: "Precon",
        description: "Pipeline, estimate, proposal, and bids handoff.",
        icon: Sparkles,
        done: hasProposal || hasContract,
      },
      {
        key: "team",
        label: "Team",
        description: "Assign a project manager.",
        icon: Users,
        done: hasPm,
      },
      {
        key: "contract",
        label: "Contract",
        description: "Execute contract with BYO docs e-sign.",
        icon: FileText,
        done: hasContract,
      },
      {
        key: "schedule",
        label: "Schedule",
        description: "Optional: apply starter milestones.",
        icon: CalendarDays,
        done: scheduleItemCount > 0,
      },
      {
        key: "draws",
        label: "Draws",
        description: "Create a draw schedule.",
        icon: DollarSign,
        done: drawsCount > 0,
      },
      {
        key: "portal",
        label: "Portal",
        description: "Invite the client to the portal.",
        icon: Link2,
        done: hasClientPortal,
      },
    ]
  }, [address, clientId, drawsCount, hasClientPortal, hasContract, hasProposal, pmUserId, scheduleItemCount, safeTeam])

  const doneCount = steps.filter((s) => s.done).length
  const progress = Math.round((doneCount / steps.length) * 100)
  const activeStep = steps.find((step) => step.key === activeTab) ?? steps[0]
  const nextIncompleteStep = steps.find((step) => !step.done)
  const NextIncompleteIcon = nextIncompleteStep?.icon
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.key === activeTab),
  )
  const previousStep = steps[activeIndex - 1]
  const nextStep = steps[activeIndex + 1]

  useEffect(() => {
    if (!open) return
    setProjectStatus(project.status)
    setAddress(project.address ?? "")
    setStartDate(project.start_date ?? "")
    setTotalValue(project.total_value ? String(project.total_value) : "")
    setClientId(project.client_id ?? "none")
    const currentPm = safeTeam.find((member) => member.role === "pm" || member.role === "project_manager")
    setPmUserId(currentPm?.user_id ?? "")
    const stepOrder = [
      { key: "basics", done: !!project.client_id && !!(project.address ?? "").trim() },
      { key: "precon", done: hasProposal || !!contract },
      { key: "team", done: safeTeam.some((m) => m.role === "pm" || m.role === "project_manager") },
      { key: "contract", done: !!contract },
      { key: "schedule", done: scheduleItemCount > 0 },
      { key: "draws", done: drawsCount > 0 },
      { key: "portal", done: hasClientPortal },
    ]
    const firstIncomplete = stepOrder.find((step) => !step.done)
    setActiveTab(firstIncomplete?.key ?? "basics")
  }, [open, project, safeTeam, scheduleItemCount, drawsCount, hasClientPortal, hasProposal, contract])

  useEffect(() => {
    setLocalContacts(safeContacts)
  }, [safeContacts])

  useEffect(() => {
    if (typeof window === "undefined") return
    setPortalOrigin(window.location.origin)
  }, [])

  useEffect(() => {
    if (!open) return
    if (activeClientPortalToken) {
      setCreatedClientPortalToken(activeClientPortalToken)
    }
  }, [open, activeClientPortalToken])

  useEffect(() => {
    if (!open || hasAttemptedTemplateLoad) return
    setHasAttemptedTemplateLoad(true)
    setTemplatesError(null)
    setTemplatesLoading(true)
    void listScheduleTemplatesAction()
      .then((data: any[]) => {
        setTemplates(
          (data ?? []).map((template) => ({
            id: template.id,
            name: template.name,
            description: template.description ?? undefined,
          })),
        )
      })
      .catch((error: any) => {
        console.error(error)
        setTemplatesError(error?.message ?? "Could not load templates")
      })
      .finally(() => setTemplatesLoading(false))
  }, [open, hasAttemptedTemplateLoad])

  useEffect(() => {
    if (!open || hasAttemptedDirectoryLoad) return
    setHasAttemptedDirectoryLoad(true)
    setDirectoryLoading(true)
    void getProjectTeamDirectoryAction(project.id)
      .then((result) => {
        setDirectoryPeople(result.people ?? [])
      })
      .catch((error: any) => {
        console.error(error)
        toast.error("Could not load org team directory")
      })
      .finally(() => setDirectoryLoading(false))
  }, [open, hasAttemptedDirectoryLoad, project.id])

  useEffect(() => {
    if (open) return
    setHasAttemptedTemplateLoad(false)
    setHasAttemptedDirectoryLoad(false)
  }, [open])

  function retryTemplatesLoad() {
    setHasAttemptedTemplateLoad(false)
  }

  function copyPortalLink() {
    if (!portalLink) return
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("Could not copy portal link")
      return
    }
    void navigator.clipboard
      .writeText(portalLink)
      .then(() => toast.success("Portal link copied"))
      .catch(() => toast.error("Could not copy portal link"))
  }

  function openPortalLink() {
    if (!portalLink) return
    window.open(portalLink, "_blank", "noopener,noreferrer")
  }

  function refresh() {
    router.refresh()
  }

  function openTab(key: string) {
    setActiveTab(key)
  }

  function handleOpenProjectSettings() {
    if (!onOpenProjectSettings) return
    onOpenChange(false)
    onOpenProjectSettings()
  }

  function handleOpenTeamSheet() {
    if (!onOpenTeamSheet) return
    onOpenChange(false)
    onOpenTeamSheet()
  }

  function renderStepFooter() {
    return (
      <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => previousStep && openTab(previousStep.key)}
          disabled={!previousStep}
        >
          Back
        </Button>
        {nextStep ? (
          <Button size="sm" onClick={() => openTab(nextStep.key)} className="gap-2">
            Next: {nextStep.label}
            <ChevronRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
            Close wizard
          </Button>
        )}
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-4xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 gap-0 overflow-hidden fast-sheet-animation"
      >
        <div className="shrink-0 border-b bg-muted/30">
          <SheetHeader className="px-6 pt-6 pb-4">
            <SheetTitle className="flex items-center gap-2 text-base font-semibold">
              <Sparkles className="h-4 w-4 text-primary" />
              Project setup wizard
            </SheetTitle>
            <SheetDescription>
              Complete the one-time setup to move from lead → proposal → contract → project execution.
            </SheetDescription>
            <div className="mt-4 flex items-center gap-3">
              <Progress value={progress} className="h-2" />
              <div className="text-xs text-muted-foreground">
                {doneCount}/{steps.length} complete
              </div>
            </div>
          </SheetHeader>
        </div>

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="px-6 py-6">
              <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
                <div className="space-y-4">
                  <div className="rounded-xl border bg-card p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">Next up</div>
                      <Badge variant="outline">{doneCount}/{steps.length}</Badge>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <div
                        className={cn(
                          "flex size-9 items-center justify-center rounded-lg border",
                          nextIncompleteStep
                            ? "bg-primary/10 text-primary border-primary/20"
                            : "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
                        )}
                      >
                        {NextIncompleteIcon ? (
                          <NextIncompleteIcon className="h-4 w-4" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                      </div>
                      <div>
                        <div className="text-sm font-medium">
                          {nextIncompleteStep?.label ?? "Setup complete"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {nextIncompleteStep?.description ?? "Everything is ready for launch."}
                        </div>
                      </div>
                    </div>
                    {nextIncompleteStep ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-4 w-full"
                        onClick={() => openTab(nextIncompleteStep.key)}
                      >
                        Continue to {nextIncompleteStep.label}
                      </Button>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    {steps.map((step) => {
                      const isActive = step.key === activeTab
                      const StepIcon = step.icon
                      return (
                        <button
                          key={step.key}
                          type="button"
                          onClick={() => openTab(step.key)}
                          className={cn(
                            "w-full rounded-xl border px-3 py-3 text-left transition",
                            isActive
                              ? "border-primary/40 bg-primary/5 shadow-sm"
                              : "border-border/60 bg-background hover:border-border",
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                "flex size-9 items-center justify-center rounded-lg border",
                                step.done
                                  ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                                  : isActive
                                  ? "bg-primary/10 text-primary border-primary/20"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {step.done ? <CheckCircle2 className="h-4 w-4" /> : <StepIcon className="h-4 w-4" />}
                            </div>
                            <div className="flex-1 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">{step.label}</span>
                                {step.done ? (
                                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">
                                    Done
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="text-xs text-muted-foreground">{step.description}</p>
                            </div>
                            <ChevronRight
                              className={cn(
                                "mt-1 h-4 w-4 text-muted-foreground/60",
                                isActive && "text-primary",
                              )}
                            />
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 shadow-sm">
                    <div>
                      <div className="text-sm font-semibold text-foreground">{activeStep?.label}</div>
                      <div className="text-xs text-muted-foreground">{activeStep?.description}</div>
                    </div>
                    <Badge variant={activeStep?.done ? "secondary" : "outline"}>
                      {activeStep?.done ? "Done" : "In progress"}
                    </Badge>
                  </div>

                  <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                    <TabsList className="hidden" />

                    <TabsContent value="basics" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader className="space-y-1">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <CardTitle className="text-base">Project basics</CardTitle>
                              <CardDescription>Client, timeline, and rough value range.</CardDescription>
                            </div>
                            {onOpenProjectSettings ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 gap-2"
                                onClick={handleOpenProjectSettings}
                              >
                                <Settings className="h-4 w-4" />
                                Project settings
                              </Button>
                            ) : null}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Status</Label>
                              <Select value={projectStatus} onValueChange={(v) => setProjectStatus(v as any)}>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select status" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="planning">Planning</SelectItem>
                                  <SelectItem value="bidding">Bidding</SelectItem>
                                  <SelectItem value="active">Active</SelectItem>
                                  <SelectItem value="on_hold">On hold</SelectItem>
                                  <SelectItem value="completed">Completed</SelectItem>
                                  <SelectItem value="cancelled">Cancelled</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-2">
                              <Label>Start date</Label>
                              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label>Address</Label>
                            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" />
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Rough value</Label>
                              <Input
                                inputMode="numeric"
                                value={totalValue}
                                onChange={(e) => setTotalValue(e.target.value)}
                                placeholder="250000"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label>Primary client contact</Label>
                              <Select value={clientId ?? "none"} onValueChange={setClientId}>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select contact" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Not set</SelectItem>
                                  {localContacts
                                    .filter((c) => c.contact_type === "client" || c.contact_type === "consultant" || c.contact_type === "vendor")
                                    .map((contact) => (
                                      <SelectItem key={contact.id} value={contact.id}>
                                        {contact.full_name}
                                        {contact.email ? ` • ${contact.email}` : ""}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              onClick={() => {
                                setNewClientName("")
                                setNewClientEmail("")
                                setNewClientPhone("")
                              }}
                            >
                              Clear new client
                            </Button>
                            <Button
                              onClick={() => {
                                startSavingBasics(async () => {
                                  try {
                                    const parsedValue = totalValue.trim() ? Number(totalValue) : undefined
                                    if (totalValue.trim() && Number.isNaN(parsedValue)) {
                                      toast.error("Rough value must be a number")
                                      return
                                    }
                                    await updateProjectSettingsAction(project.id, {
                                      status: projectStatus,
                                      start_date: startDate || undefined,
                                      location: address ? { formatted: address, address } : undefined,
                                      total_value: parsedValue,
                                      client_id: clientId === "none" ? null : clientId,
                                    })
                                    toast.success("Saved project basics")
                                    refresh()
                                  } catch (error: any) {
                                    console.error(error)
                                    toast.error(error?.message ?? "Could not save project basics")
                                  }
                                })
                              }}
                              disabled={savingBasics}
                            >
                              {savingBasics ? "Saving..." : "Save basics"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Create a new client contact (optional)</CardTitle>
                          <CardDescription>Creates a contact and assigns it to this project.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Full name</Label>
                              <Input value={newClientName} onChange={(e) => setNewClientName(e.target.value)} placeholder="Jane Smith" />
                            </div>
                            <div className="space-y-2">
                              <Label>Email</Label>
                              <Input value={newClientEmail} onChange={(e) => setNewClientEmail(e.target.value)} placeholder="jane@example.com" />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label>Phone</Label>
                            <Input value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} placeholder="(555) 555-5555" />
                          </div>
                          <div className="flex items-center justify-end">
                            <Button
                              onClick={() => {
                                startCreatingContact(async () => {
                                  try {
                                    const newContact = await createClientContactAndAssignAction(project.id, {
                                      full_name: newClientName,
                                      email: newClientEmail || undefined,
                                      phone: newClientPhone || undefined,
                                    })
                                    setLocalContacts((prev) => [newContact as Contact, ...prev])
                                    setClientId(newContact.id)
                                    toast.success("Client contact created")
                                    setNewClientName("")
                                    setNewClientEmail("")
                                    setNewClientPhone("")
                                    refresh()
                                  } catch (error: any) {
                                    console.error(error)
                                    toast.error(error?.message ?? "Could not create contact")
                                  }
                                })
                              }}
                              disabled={creatingContact || newClientName.trim().length === 0}
                            >
                              {creatingContact ? "Creating..." : "Create and assign"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>

                    <TabsContent value="precon" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Preconstruction handoff</CardTitle>
                          <CardDescription>
                            Move from inbound lead to signed project with the full precon stack.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="flex items-center justify-between rounded-lg border p-3">
                              <span className="text-sm font-medium">Pipeline tracking</span>
                              <Badge variant="secondary">Workspace</Badge>
                            </div>
                            <div className="flex items-center justify-between rounded-lg border p-3">
                              <span className="text-sm font-medium">Estimate</span>
                              <Badge variant={hasProposal || hasContract ? "secondary" : "outline"}>
                                {hasProposal || hasContract ? "Started" : "Pending"}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between rounded-lg border p-3">
                              <span className="text-sm font-medium">Proposal</span>
                              <Badge variant={hasProposal ? "secondary" : "outline"}>
                                {hasProposal ? "Ready" : "Missing"}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between rounded-lg border p-3">
                              <span className="text-sm font-medium">Bid packages</span>
                              <Badge variant="outline">Optional</Badge>
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <Button asChild variant="outline" size="sm">
                              <Link href="/pipeline?view=prospects">Open pipeline</Link>
                            </Button>
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/estimates?project=${project.id}`}>Open estimates</Link>
                            </Button>
                            <Button asChild size="sm">
                              <Link href={`/projects/${project.id}/proposals`}>Open proposals</Link>
                            </Button>
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/projects/${project.id}/bids`}>Open bids</Link>
                            </Button>
                          </div>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>

                    <TabsContent value="team" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Assign project manager</CardTitle>
                          <CardDescription>
                            Sets the PM shown on the client portal. You can choose existing project members or anyone on your org team.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="space-y-2">
                            <Label>PM</Label>
                            <Select value={pmUserId} onValueChange={setPmUserId}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select a team member" />
                              </SelectTrigger>
                              <SelectContent>
                                {pmCandidates.length === 0 ? (
                                  <div className="px-2 py-3 text-xs text-muted-foreground">
                                    {directoryLoading ? "Loading team..." : "No team members found"}
                                  </div>
                                ) : null}
                                {pmCandidates.map((member) => (
                                  <SelectItem key={member.user_id} value={member.user_id}>
                                    {member.full_name} {member.email ? `• ${member.email}` : ""}
                                    {member.source === "project" ? " • On project" : " • Org team"}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                            Recommended setup: assign a PM here, then use <span className="font-medium text-foreground">Manage team</span> to add
                            superintendent, estimator/precon, and finance roles.
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            {onOpenTeamSheet ? (
                              <Button variant="outline" size="sm" onClick={handleOpenTeamSheet}>
                                Manage team
                              </Button>
                            ) : (
                              <div />
                            )}
                            <Button
                              onClick={() => {
                                startSavingPm(async () => {
                                  try {
                                    await setProjectManagerAction(project.id, pmUserId)
                                    toast.success("Project manager updated")
                                    refresh()
                                  } catch (error: any) {
                                    console.error(error)
                                    toast.error(error?.message ?? "Could not set project manager")
                                  }
                                })
                              }}
                              disabled={savingPm || !pmUserId}
                            >
                              {savingPm ? "Saving..." : "Set PM"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>

                    <TabsContent value="contract" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Contract execution (BYO docs)</CardTitle>
                          <CardDescription>
                            Use Signatures to upload your own contract PDF, place fields, and execute.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex items-center justify-between rounded-lg border p-3">
                            <div>
                              <div className="text-sm font-medium">Contract record</div>
                              <div className="text-xs text-muted-foreground">
                                {contract ? `${contract.title} • ${contract.status}` : (hasAcceptedProposal ? "Not found yet" : "Created after proposal acceptance")}
                              </div>
                            </div>
                            <Badge variant={contract ? "secondary" : "outline"}>{contract ? "Ready" : "Missing"}</Badge>
                          </div>

                          <div className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                            Contracts no longer need a fixed built-in form. Upload your own agreement and send it through the unified e-sign flow.
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap gap-2">
                              <Button asChild size="sm">
                                <Link href="/documents">Open Signatures</Link>
                              </Button>
                              <Button asChild variant="outline" size="sm">
                                <Link href={`/projects/${project.id}/documents`}>Project documents</Link>
                              </Button>
                            </div>
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/projects/${project.id}/proposals`}>Open proposals</Link>
                            </Button>
                          </div>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>

                    <TabsContent value="schedule" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Apply schedule template</CardTitle>
                          <CardDescription>
                            Optional starter milestones. Skip this if your team builds schedules manually.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="space-y-2">
                            <Label>Template</Label>
                            <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId} disabled={templatesLoading}>
                              <SelectTrigger>
                                <SelectValue placeholder={templatesLoading ? "Loading..." : "Select a template"} />
                              </SelectTrigger>
                              <SelectContent>
                                {templates.map((template) => (
                                  <SelectItem key={template.id} value={template.id}>
                                    {template.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {selectedTemplateId ? (
                              <p className="text-xs text-muted-foreground">
                                {templates.find((t) => t.id === selectedTemplateId)?.description ?? ""}
                              </p>
                            ) : null}
                            {templatesError ? (
                              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                                Could not load schedule templates. You can retry or start from the schedule page.
                              </div>
                            ) : null}
                            {!templatesLoading && templates.length === 0 && !templatesError ? (
                              <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                                No templates are configured yet for this org.
                              </div>
                            ) : null}
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground">
                              Current schedule items: <span className="font-medium text-foreground">{scheduleItemCount}</span>
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <Button asChild variant="outline" size="sm">
                                <Link href={`/projects/${project.id}/schedule`}>Open schedule</Link>
                              </Button>
                              {templatesError ? (
                                <Button size="sm" variant="outline" onClick={retryTemplatesLoad} disabled={templatesLoading}>
                                  Retry templates
                                </Button>
                              ) : null}
                              <Button
                                onClick={() => {
                                  startApplyingTemplate(async () => {
                                    try {
                                      await applyScheduleTemplateAction(project.id, selectedTemplateId)
                                      toast.success("Schedule template applied")
                                      refresh()
                                    } catch (error: any) {
                                      console.error(error)
                                      toast.error(error?.message ?? "Could not apply template")
                                    }
                                  })
                                }}
                                disabled={applyingTemplate || !selectedTemplateId || scheduleItemCount > 0}
                              >
                                {applyingTemplate ? "Applying..." : "Apply template"}
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>

                    <TabsContent value="draws" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Create draw schedule</CardTitle>
                          <CardDescription>
                            Requires an active contract. Proposal acceptance generates a contract automatically.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex items-center justify-between rounded-lg border p-3">
                            <div>
                              <div className="text-sm font-medium">Contract</div>
                              <div className="text-xs text-muted-foreground">
                                {contract ? `${contract.title} • ${(contract.total_cents ?? 0) / 100} ${contract.currency}` : (hasAcceptedProposal ? "Not found" : "Not created yet")}
                              </div>
                            </div>
                            <Badge variant={contract ? "secondary" : "outline"}>{contract ? "Ready" : "Missing"}</Badge>
                          </div>

                          <div className="space-y-2">
                            <Label>Template</Label>
                            <Select value={drawPresetKey} onValueChange={setDrawPresetKey}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select a draw template" />
                              </SelectTrigger>
                              <SelectContent>
                                {DRAW_PRESETS.map((preset) => (
                                  <SelectItem key={preset.key} value={preset.key}>
                                    {preset.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              {DRAW_PRESETS.find((p) => p.key === drawPresetKey)?.description}
                            </p>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground">
                              Existing draws: <span className="font-medium text-foreground">{drawsCount}</span>
                            </p>
                            <Button
                              onClick={() => {
                                startCreatingDraws(async () => {
                                  try {
                                    if (!contract) {
                                      toast.error("Add/accept a proposal to generate a contract first.")
                                      return
                                    }
                                    if (drawsCount > 0) {
                                      toast.error("This project already has a draw schedule.")
                                      return
                                    }

                                    const preset = DRAW_PRESETS.find((p) => p.key === drawPresetKey)
                                    if (!preset) {
                                      toast.error("Invalid draw template")
                                      return
                                    }

                                    const percentTotal = preset.draws.reduce((sum, d) => sum + d.percent, 0)
                                    if (percentTotal !== 100) {
                                      toast.error("Draw percentages must sum to 100%")
                                      return
                                    }

                                    await createDrawScheduleFromContractAction(
                                      project.id,
                                      contract.id,
                                      preset.draws.map((d) => ({
                                        title: d.title,
                                        percent: d.percent,
                                        due_trigger: "approval",
                                      })),
                                    )
                                    toast.success("Draw schedule created")
                                    refresh()
                                  } catch (error: any) {
                                    console.error(error)
                                    toast.error(error?.message ?? "Could not create draw schedule")
                                  }
                                })
                              }}
                              disabled={creatingDraws || !contract || drawsCount > 0}
                            >
                              {creatingDraws ? "Creating..." : "Create draw schedule"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>

                    <TabsContent value="portal" className="space-y-4">
                      <Card className="border-border/60 shadow-none">
                        <CardHeader>
                          <CardTitle className="text-base">Invite client to portal</CardTitle>
                          <CardDescription>
                            Create or reuse the client portal link, then copy it or email it directly to the client.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex items-center justify-between rounded-lg border p-3">
                            <div>
                              <div className="text-sm font-medium">Client portal link</div>
                              <div className="text-xs text-muted-foreground">
                                {activeClientPortalToken ? "Active link exists" : "No active link yet"}
                              </div>
                            </div>
                            <Badge variant={activeClientPortalToken ? "secondary" : "outline"}>
                              {activeClientPortalToken ? "Ready" : "Missing"}
                            </Badge>
                          </div>

                          {portalLink ? (
                            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                              <div className="text-xs font-medium text-muted-foreground">Portal URL</div>
                              <div className="break-all rounded-md border bg-background px-2 py-1.5 font-mono text-xs">
                                {portalLink}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" onClick={copyPortalLink}>
                                  Copy link
                                </Button>
                                <Button variant="outline" size="sm" onClick={openPortalLink}>
                                  Open link
                                </Button>
                              </div>
                            </div>
                          ) : null}

                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <Button
                              onClick={() => {
                                startCreatingPortal(async () => {
                                  try {
                                    if (activeClientPortalToken) {
                                      toast.success("Client portal link already exists")
                                      return
                                    }

                                    const contactIdValue = clientId !== "none" ? clientId : (project.client_id ?? undefined)

                                    const token = await createPortalTokenAction({
                                      project_id: project.id,
                                      portal_type: "client",
                                      contact_id: contactIdValue,
                                      name: "Client portal",
                                      permissions: {
                                        can_view_schedule: true,
                                        can_view_photos: true,
                                        can_view_documents: true,
                                        can_download_files: true,
                                        can_view_daily_logs: true,
                                        can_view_budget: true,
                                        can_view_invoices: true,
                                        can_pay_invoices: true,
                                        can_approve_change_orders: true,
                                        can_submit_selections: true,
                                        can_create_punch_items: true,
                                        can_message: true,
                                      },
                                    })

                                    setCreatedClientPortalToken(token as PortalAccessToken)
                                    toast.success("Client portal link created")
                                    refresh()
                                  } catch (error: any) {
                                    console.error(error)
                                    toast.error(error?.message ?? "Could not create portal link")
                                  }
                                })
                              }}
                              disabled={creatingPortal}
                            >
                              {creatingPortal ? "Creating..." : activeClientPortalToken ? "Portal ready" : "Create client portal link"}
                            </Button>

                            <Button
                              variant="outline"
                              onClick={() => {
                                startSendingPortalInvite(async () => {
                                  try {
                                    if (!activeClientPortalToken) {
                                      toast.error("Create a portal link first")
                                      return
                                    }
                                    await sendClientPortalInviteAction({
                                      projectId: project.id,
                                      portalTokenId: activeClientPortalToken.id,
                                      contactId: selectedClientContact?.id,
                                    })
                                    toast.success("Client invite sent")
                                  } catch (error: any) {
                                    console.error(error)
                                    toast.error(error?.message ?? "Could not send invite")
                                  }
                                })
                              }}
                              disabled={sendingPortalInvite || !activeClientPortalToken}
                            >
                              {sendingPortalInvite ? "Sending invite..." : "Email invite to client"}
                            </Button>
                          </div>

                          <p className="text-xs text-muted-foreground">
                            Invite will be sent to: {selectedClientContact?.email ?? "No client email selected"}
                          </p>
                        </CardContent>
                      </Card>

                      {renderStepFooter()}
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  )
}
