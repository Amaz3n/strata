"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { Observation, SafetyIncident, ToolboxTalk } from "@/lib/services/safety"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import {
  createObservationAction,
  createSafetyIncidentAction,
  createToolboxTalkAction,
  deleteToolboxTalkAction,
  updateObservationAction,
  updateSafetyIncidentAction,
} from "./actions"

const SEVERITY_LABELS: Record<string, string> = {
  near_miss: "Near miss",
  first_aid: "First aid",
  medical_treatment: "Medical treatment",
  lost_time: "Lost time",
  fatality: "Fatality",
}

const severityStyles: Record<string, string> = {
  near_miss: "bg-muted text-muted-foreground border-muted",
  first_aid: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  medical_treatment: "bg-warning/15 text-warning border-warning/30",
  lost_time: "bg-destructive/15 text-destructive border-destructive/30",
  fatality: "bg-destructive/25 text-destructive border-destructive/40",
}

type CompanyOption = { id: string; name: string }

export function SafetyClient({
  projectId,
  incidents,
  talks,
  observations,
  companies,
  initialTab,
}: {
  projectId: string
  incidents: SafetyIncident[]
  talks: ToolboxTalk[]
  observations: Observation[]
  companies: CompanyOption[]
  initialTab?: string
}) {
  const defaultTab = initialTab === "talks" || initialTab === "observations" ? initialTab : "incidents"

  return (
    <Tabs defaultValue={defaultTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="incidents">Incidents ({incidents.length})</TabsTrigger>
        <TabsTrigger value="talks">Toolbox Talks ({talks.length})</TabsTrigger>
        <TabsTrigger value="observations">Observations ({observations.filter((o) => o.status === "open").length} open)</TabsTrigger>
      </TabsList>
      <TabsContent value="incidents" className="m-0">
        <IncidentsTab projectId={projectId} incidents={incidents} companies={companies} />
      </TabsContent>
      <TabsContent value="talks" className="m-0">
        <TalksTab projectId={projectId} talks={talks} />
      </TabsContent>
      <TabsContent value="observations" className="m-0">
        <ObservationsTab projectId={projectId} observations={observations} companies={companies} />
      </TabsContent>
    </Tabs>
  )
}

function useSubmit() {
  const [pending, startTransition] = useTransition()
  const submit = (work: () => Promise<void>) =>
    startTransition(() => {
      void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong"))
    })
  return { pending, submit }
}

function IncidentsTab({ projectId, incidents, companies }: { projectId: string; incidents: SafetyIncident[]; companies: CompanyOption[] }) {
  const router = useRouter()
  const { pending, submit } = useSubmit()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selected, setSelected] = useState<SafetyIncident | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setSelected(null); setSheetOpen(true) }}>Report incident</Button>
      </div>
      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead className="w-32">Date</TableHead>
              <TableHead className="w-36">Severity</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-36">Company</TableHead>
              <TableHead className="w-24 text-center">OSHA</TableHead>
              <TableHead className="w-28">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {incidents.length ? (
              incidents.map((incident) => (
                <TableRow key={incident.id} className="cursor-pointer" onClick={() => { setSelected(incident); setSheetOpen(true) }}>
                  <TableCell className="font-mono text-xs">{incident.incident_number}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(incident.occurred_at).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("text-[10px]", severityStyles[incident.severity])}>
                      {SEVERITY_LABELS[incident.severity] ?? incident.severity}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <span className="block truncate text-sm">{incident.description}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{incident.involved_company_name ?? "—"}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground">{incident.is_osha_recordable ? "Yes" : "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{incident.status.replace(/_/g, " ")}</Badge>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No incidents reported.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="flex w-full flex-col overflow-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-6 pb-4 pt-6">
            <SheetTitle>{selected ? `Incident #${selected.incident_number}` : "Report incident"}</SheetTitle>
            <SheetDescription>
              {selected ? "Investigation record — update status and root cause as it progresses." : "Lost-time and fatality reports alert org admins by email."}
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              const shared = {
                occurred_at: form.get("occurred_at") ? new Date(String(form.get("occurred_at"))).toISOString() : undefined,
                severity: form.get("severity"),
                classification: form.get("classification") || null,
                location: form.get("location") || null,
                description: form.get("description"),
                involved_company_id: form.get("involved_company_id") && form.get("involved_company_id") !== "__none__" ? form.get("involved_company_id") : null,
                involved_person_name: form.get("involved_person_name") || null,
                witness_names: form.get("witness_names") || null,
                immediate_action: form.get("immediate_action") || null,
                is_osha_recordable: form.get("is_osha_recordable") === "on",
              }
              submit(async () => {
                const photo = form.get("photo")
                let photoFileId = selected?.photo_file_id ?? null
                if (photo instanceof File && photo.size > 0) {
                  const upload = new FormData()
                  upload.append("file", photo)
                  upload.append("projectId", projectId)
                  upload.append("category", "photos")
                  upload.append("visibility", "private")
                  upload.append("folderPath", "/safety/incidents")
                  photoFileId = unwrapAction(await uploadFileAction(upload)).id
                }
                if (selected) {
                  unwrapAction(await updateSafetyIncidentAction(projectId, selected.id, {
                    ...shared,
                    photo_file_id: photoFileId,
                    root_cause: form.get("root_cause") || null,
                    status: form.get("status") || undefined,
                  }))
                  toast.success("Incident updated")
                } else {
                  unwrapAction(await createSafetyIncidentAction({ ...shared, project_id: projectId, photo_file_id: photoFileId }))
                  toast.success("Incident reported")
                }
                setSheetOpen(false)
                router.refresh()
              })
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Occurred at</Label>
                  <Input
                    name="occurred_at"
                    type="datetime-local"
                    required
                    defaultValue={selected ? new Date(selected.occurred_at).toISOString().slice(0, 16) : ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Severity</Label>
                  <Select name="severity" defaultValue={selected?.severity ?? "near_miss"}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Classification</Label>
                  <Select name="classification" defaultValue={selected?.classification ?? "injury"}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="injury">Injury</SelectItem>
                      <SelectItem value="illness">Illness</SelectItem>
                      <SelectItem value="property_damage">Property damage</SelectItem>
                      <SelectItem value="environmental">Environmental</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Location</Label>
                  <Input name="location" defaultValue={selected?.location ?? ""} placeholder="Level 2, grid B-4" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea name="description" required rows={4} defaultValue={selected?.description ?? ""} placeholder="What happened..." />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Involved company</Label>
                  <Select name="involved_company_id" defaultValue={selected?.involved_company_id ?? "__none__"}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None / own forces</SelectItem>
                      {companies.map((company) => (
                        <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Involved person</Label>
                  <Input name="involved_person_name" defaultValue={selected?.involved_person_name ?? ""} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Witnesses</Label>
                <Input name="witness_names" defaultValue={selected?.witness_names ?? ""} placeholder="Names, comma separated" />
              </div>
              <div className="space-y-2">
                <Label>Immediate action taken</Label>
                <Textarea name="immediate_action" rows={2} defaultValue={selected?.immediate_action ?? ""} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="incident-photo">Incident photo</Label>
                <Input id="incident-photo" name="photo" type="file" accept="image/*" capture="environment" disabled={pending} />
                {selected?.photo_file_id ? <a className="text-xs text-primary underline" href={`/api/files/${selected.photo_file_id}/raw`} target="_blank" rel="noreferrer">View current photo</a> : null}
              </div>
              {selected ? (
                <>
                  <div className="space-y-2">
                    <Label>Root cause</Label>
                    <Textarea name="root_cause" rows={2} defaultValue={selected.root_cause ?? ""} />
                  </div>
                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select name="status" defaultValue={selected.status}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="under_review">Under review</SelectItem>
                        <SelectItem value="closed">Closed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : null}
              <div className="flex items-center gap-2">
                <Checkbox name="is_osha_recordable" id="osha-recordable" defaultChecked={selected?.is_osha_recordable} />
                <Label htmlFor="osha-recordable" className="font-normal">OSHA recordable</Label>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
              {selected ? (
                <Button type="button" variant="outline" asChild>
                  <a href={`/projects/${projectId}/exports/incident?id=${selected.id}`} target="_blank" rel="noreferrer">Export PDF</a>
                </Button>
              ) : null}
              <div className="flex-1" />
              <Button type="button" variant="outline" onClick={() => setSheetOpen(false)} disabled={pending}>Cancel</Button>
              <Button type="submit" disabled={pending}>{pending ? "Saving..." : selected ? "Save changes" : "Report incident"}</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function TalksTab({ projectId, talks }: { projectId: string; talks: ToolboxTalk[] }) {
  const router = useRouter()
  const { pending, submit } = useSubmit()

  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 border p-4 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const target = event.currentTarget
          submit(async () => {
            const attendees = String(form.get("attendees") ?? "")
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const [name, ...companyParts] = line.split("|").map((part) => part.trim())
                return { name, company: companyParts.join(" | ") || null }
              })
            const signInSheet = form.get("sign_in_sheet")
            let fileId: string | null = null
            if (signInSheet instanceof File && signInSheet.size > 0) {
              const upload = new FormData()
              upload.append("file", signInSheet)
              upload.append("projectId", projectId)
              upload.append("category", "other")
              upload.append("visibility", "private")
              upload.append("folderPath", "/safety/toolbox-talks")
              fileId = unwrapAction(await uploadFileAction(upload)).id
            }
            unwrapAction(await createToolboxTalkAction({
              project_id: projectId,
              held_at: form.get("held_at"),
              topic: form.get("topic"),
              presenter_name: form.get("presenter_name") || null,
              attendee_count: attendees.length || (form.get("attendee_count") ? Number(form.get("attendee_count")) : null),
              attendees,
              file_id: fileId,
            }))
            toast.success("Toolbox talk recorded")
            target.reset()
            router.refresh()
          })
        }}
      >
        <Input name="held_at" type="date" required disabled={pending} />
        <Input name="topic" required placeholder="Topic (e.g. Ladder safety)" disabled={pending} />
        <Input name="presenter_name" placeholder="Presenter" disabled={pending} />
        <Input name="attendee_count" type="number" min={0} placeholder="Attendee count (if names unavailable)" disabled={pending} />
        <Textarea name="attendees" rows={4} placeholder={"Attendees, one per line\nName | Company"} disabled={pending} />
        <div className="space-y-1">
          <Label htmlFor="sign-in-sheet">Signed attendance sheet</Label>
          <Input id="sign-in-sheet" name="sign_in_sheet" type="file" accept="image/*,.pdf" disabled={pending} />
        </div>
        <Button type="submit" disabled={pending}>Record talk</Button>
      </form>
      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Date</TableHead>
              <TableHead>Topic</TableHead>
              <TableHead className="w-40">Presenter</TableHead>
              <TableHead className="w-28 text-center">Attendees</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {talks.length ? (
              talks.map((talk) => (
                <TableRow key={talk.id}>
                  <TableCell className="text-muted-foreground">{new Date(`${talk.held_at}T12:00:00`).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <div className="font-medium">{talk.topic}</div>
                    {talk.attendees.length > 0 ? <div className="text-xs text-muted-foreground">{talk.attendees.map((attendee) => attendee.company ? `${attendee.name} (${attendee.company})` : attendee.name).join(", ")}</div> : null}
                    {talk.file_id ? <a className="text-xs text-primary underline" href={`/api/files/${talk.file_id}/raw`} target="_blank" rel="noreferrer">Signed attendance sheet</a> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{talk.presenter_name ?? "—"}</TableCell>
                  <TableCell className="text-center tabular-nums">{talk.attendee_count ?? "—"}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        submit(async () => {
                          unwrapAction(await deleteToolboxTalkAction(projectId, talk.id))
                          router.refresh()
                        })
                      }
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No toolbox talks recorded.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function ObservationsTab({ projectId, observations, companies }: { projectId: string; observations: Observation[]; companies: CompanyOption[] }) {
  const router = useRouter()
  const { pending, submit } = useSubmit()

  return (
    <div className="space-y-4">
      <form
        className="grid gap-3 border p-4 md:grid-cols-[110px_130px_1fr_180px_auto]"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const target = event.currentTarget
          const companyValue = String(form.get("company_id") || "__none__")
          submit(async () => {
            const photo = form.get("photo")
            let photoFileId: string | null = null
            if (photo instanceof File && photo.size > 0) {
              const upload = new FormData()
              upload.append("file", photo)
              upload.append("projectId", projectId)
              upload.append("category", "photos")
              upload.append("visibility", "private")
              upload.append("folderPath", "/safety/observations")
              photoFileId = unwrapAction(await uploadFileAction(upload)).id
            }
            unwrapAction(await createObservationAction({
              project_id: projectId,
              kind: form.get("kind"),
              category: form.get("category") || null,
              description: form.get("description"),
              company_id: companyValue === "__none__" ? null : companyValue,
              photo_file_id: photoFileId,
            }))
            toast.success("Observation recorded")
            target.reset()
            router.refresh()
          })
        }}
      >
        <Select name="kind" defaultValue="safety" disabled={pending}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="safety">Safety</SelectItem>
            <SelectItem value="quality">Quality</SelectItem>
          </SelectContent>
        </Select>
        <Select name="category" defaultValue="at_risk" disabled={pending}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="positive">Positive</SelectItem>
            <SelectItem value="at_risk">At risk</SelectItem>
            <SelectItem value="deficiency">Deficiency</SelectItem>
          </SelectContent>
        </Select>
        <Input name="description" required placeholder="One-line observation..." disabled={pending} />
        <Select name="company_id" defaultValue="__none__" disabled={pending}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">No company</SelectItem>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input className="md:col-span-4" name="photo" type="file" accept="image/*" capture="environment" disabled={pending} />
        <Button type="submit" disabled={pending}>Record</Button>
      </form>
      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead className="w-24">Type</TableHead>
              <TableHead className="w-28">Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-36">Company</TableHead>
              <TableHead className="w-28">Date</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {observations.length ? (
              observations.map((observation) => (
                <TableRow key={observation.id}>
                  <TableCell className="font-mono text-xs">{observation.observation_number}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{observation.kind}</TableCell>
                  <TableCell>
                    {observation.category ? (
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] capitalize",
                          observation.category === "positive" && "bg-success/15 text-success border-success/30",
                          observation.category === "at_risk" && "bg-warning/15 text-warning border-warning/30",
                          observation.category === "deficiency" && "bg-destructive/15 text-destructive border-destructive/30",
                        )}
                      >
                        {observation.category.replace(/_/g, " ")}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-0">
                    <span className="block truncate text-sm">{observation.description}</span>
                    {observation.photo_file_id ? <a className="text-xs text-primary underline" href={`/api/files/${observation.photo_file_id}/raw`} target="_blank" rel="noreferrer">View photo</a> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{observation.company_name ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(observation.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Badge variant={observation.status === "open" ? "outline" : "secondary"} className="capitalize">{observation.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {observation.status === "open" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          submit(async () => {
                            unwrapAction(await updateObservationAction(projectId, observation.id, { status: "resolved" }))
                            router.refresh()
                          })
                        }
                      >
                        Resolve
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">No observations recorded.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
