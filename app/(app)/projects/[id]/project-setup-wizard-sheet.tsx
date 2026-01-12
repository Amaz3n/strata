"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import type { Contact, Contract, PortalAccessToken, Project, Proposal, ScheduleItem } from "@/lib/types"
import type { ProjectTeamMember } from "./actions"
import {
  applyScheduleTemplateAction,
  createClientContactAndAssignAction,
  createDrawScheduleFromContractAction,
  listScheduleTemplatesAction,
  setProjectManagerAction,
  updateProjectSettingsAction,
} from "./actions"
import { createPortalTokenAction } from "@/app/(app)/sharing/actions"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

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
  project,
  contacts,
  team,
  proposals,
  contract,
  scheduleItems,
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
  scheduleItems: ScheduleItem[]
  drawsCount: number
  portalTokens: PortalAccessToken[]
}) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState("basics")
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)

  const safeContacts = Array.isArray(contacts) ? contacts : []
  const safeTeam = Array.isArray(team) ? team : []
  const safeScheduleItems = Array.isArray(scheduleItems) ? scheduleItems : []

  const [savingBasics, startSavingBasics] = useTransition()
  const [savingPm, startSavingPm] = useTransition()
  const [applyingTemplate, startApplyingTemplate] = useTransition()
  const [creatingDraws, startCreatingDraws] = useTransition()
  const [creatingPortal, startCreatingPortal] = useTransition()
  const [creatingContact, startCreatingContact] = useTransition()

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

  const hasClientPortal = useMemo(
    () => (Array.isArray(portalTokens) ? portalTokens : []).some((t) => t.portal_type === "client" && !t.revoked_at),
    [portalTokens],
  )

  const hasAcceptedProposal = useMemo(
    () => proposals.some((p) => p.status === "accepted" || !!p.accepted_at),
    [proposals],
  )

  const steps = useMemo(() => {
    const hasClient = !!project.client_id
    const hasPm = safeTeam.some((m) => m.role === "pm")
    return [
      { key: "basics", label: "Basics", done: hasClient && !!address.trim() },
      { key: "team", label: "Team", done: hasPm },
      { key: "schedule", label: "Schedule", done: safeScheduleItems.length > 0 },
      { key: "draws", label: "Draws", done: drawsCount > 0 },
      { key: "portal", label: "Portal", done: hasClientPortal },
    ]
  }, [address, drawsCount, hasClientPortal, project.client_id, safeScheduleItems.length, safeTeam])

  const doneCount = steps.filter((s) => s.done).length

  useEffect(() => {
    if (!open) return
    setProjectStatus(project.status)
    setAddress(project.address ?? "")
    setStartDate(project.start_date ?? "")
    setTotalValue(project.total_value ? String(project.total_value) : "")
    setClientId(project.client_id ?? "none")
  }, [open, project])

  useEffect(() => {
    if (!open) return
    if (templates.length > 0 || templatesLoading) return
    setTemplatesLoading(true)
    void listScheduleTemplatesAction()
      .then((data: any[]) => {
        setTemplates(
          (data ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description ?? undefined,
          })),
        )
      })
      .catch((error: any) => {
        console.error(error)
        toast.error("Could not load schedule templates")
      })
      .finally(() => setTemplatesLoading(false))
  }, [open, templates.length, templatesLoading])

  function refresh() {
    router.refresh()
  }

  function openTab(key: string) {
    setActiveTab(key)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl">
        <SheetHeader className="pb-4">
          <SheetTitle>Project setup wizard</SheetTitle>
          <SheetDescription>
            Complete the one-time setup to move from lead → proposal → contract → project execution.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center justify-between gap-2 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            {steps.map((step) => (
              <Button
                key={step.key}
                variant={activeTab === step.key ? "default" : "outline"}
                size="sm"
                onClick={() => openTab(step.key)}
              >
                {step.label}
                {step.done ? <Badge variant="secondary" className="ml-2">Done</Badge> : null}
              </Button>
            ))}
          </div>
          <Badge variant="outline">{doneCount}/{steps.length} complete</Badge>
        </div>

        <Separator className="mb-4" />

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="hidden" />

          <TabsContent value="basics" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Project basics</CardTitle>
                <CardDescription>Client, timeline, and rough value range.</CardDescription>
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
                        {safeContacts
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

            <Card>
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
                          await createClientContactAndAssignAction(project.id, {
                            full_name: newClientName,
                            email: newClientEmail || undefined,
                            phone: newClientPhone || undefined,
                          })
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
          </TabsContent>

          <TabsContent value="team" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Assign project manager</CardTitle>
                <CardDescription>Sets the PM shown on the client portal.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>PM</Label>
                  <Select value={pmUserId} onValueChange={setPmUserId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a team member" />
                    </SelectTrigger>
                    <SelectContent>
                      {safeTeam.map((member) => (
                        <SelectItem key={member.user_id} value={member.user_id}>
                          {member.full_name} {member.email ? `• ${member.email}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-end">
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
          </TabsContent>

          <TabsContent value="schedule" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Apply schedule template</CardTitle>
                <CardDescription>Only available if the schedule is currently empty.</CardDescription>
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
                  {selectedTemplateId
                    ? (
                      <p className="text-xs text-muted-foreground">
                        {templates.find((t) => t.id === selectedTemplateId)?.description ?? ""}
                      </p>
                    )
                    : null}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    Current schedule items: <span className="font-medium text-foreground">{safeScheduleItems.length}</span>
                  </p>
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
                    disabled={applyingTemplate || !selectedTemplateId || safeScheduleItems.length > 0}
                  >
                    {applyingTemplate ? "Applying..." : "Apply template"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="draws" className="space-y-4">
            <Card>
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
          </TabsContent>

          <TabsContent value="portal" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Invite client to portal</CardTitle>
                <CardDescription>Creates a client portal link with sensible defaults.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="text-sm font-medium">Client portal link</div>
                    <div className="text-xs text-muted-foreground">
                      {hasClientPortal ? "Active link exists" : "No active link yet"}
                    </div>
                  </div>
                  <Badge variant={hasClientPortal ? "secondary" : "outline"}>{hasClientPortal ? "Ready" : "Missing"}</Badge>
                </div>

                <div className="flex items-center justify-end">
                  <Button
                    onClick={() => {
                      startCreatingPortal(async () => {
                        try {
                          if (hasClientPortal) {
                            toast.success("Client portal link already exists")
                            return
                          }

                          const contactIdValue = project.client_id ?? undefined

                          await createPortalTokenAction({
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
                    {creatingPortal ? "Creating..." : hasClientPortal ? "Portal ready" : "Create client portal link"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

