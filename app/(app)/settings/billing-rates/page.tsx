import { Archive, Plus, Trash2, WalletCards } from "lucide-react"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  archiveBillingRateScheduleFormAction,
  assignBillingRateScheduleFormAction,
  createBillingRateFormAction,
  createBillingRateOverrideFormAction,
  createBillingRateScheduleFormAction,
  deleteBillingRateFormAction,
  deleteBillingRateOverrideFormAction,
  listBillingRateOptionsAction,
  listBillingRateOverridesAction,
  listBillingRateSchedulesAction,
} from "./actions"

import { unwrapAction } from "@/lib/action-result"

export const dynamic = "force-dynamic"

const NONE = "__none__"

async function createBillingRateScheduleForm(formData: FormData) {
  "use server"
  unwrapAction(await createBillingRateScheduleFormAction(formData))
}

async function archiveBillingRateScheduleForm(scheduleId: string) {
  "use server"
  unwrapAction(await archiveBillingRateScheduleFormAction(scheduleId))
}

async function assignBillingRateScheduleForm(formData: FormData) {
  "use server"
  unwrapAction(await assignBillingRateScheduleFormAction(formData))
}

async function createBillingRateForm(formData: FormData) {
  "use server"
  unwrapAction(await createBillingRateFormAction(formData))
}

async function deleteBillingRateForm(rateId: string) {
  "use server"
  unwrapAction(await deleteBillingRateFormAction(rateId))
}

async function createBillingRateOverrideForm(formData: FormData) {
  "use server"
  unwrapAction(await createBillingRateOverrideFormAction(formData))
}

async function deleteBillingRateOverrideForm(overrideId: string) {
  "use server"
  unwrapAction(await deleteBillingRateOverrideFormAction(overrideId))
}

export default async function BillingRatesPage() {
  const [schedules, overrides, options] = await Promise.all([
    listBillingRateSchedulesAction(),
    listBillingRateOverridesAction(),
    listBillingRateOptionsAction(),
  ])
  const assignableSchedules = schedules.filter((schedule) => schedule.status !== "archived")

  return (
    <PageLayout
      title="Billing Rates"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Billing Rates" },
      ]}
    >
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Billing Rates</h1>
          <p className="text-sm text-muted-foreground">Manage T&M labor, equipment, material markup, and project overrides.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <WalletCards className="h-4 w-4" />
              New schedule
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createBillingRateScheduleForm} className="grid gap-4 md:grid-cols-[1fr_1.5fr_160px_auto] md:items-end">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input name="name" required placeholder="Standard T&M 2026" />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Input name="description" placeholder="Default owner-facing bill rates" />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select name="status" defaultValue="active">
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit">
                <Plus className="h-4 w-4" />
                Create
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assign schedule to project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form action={assignBillingRateScheduleForm} className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(240px,1fr)_auto] lg:items-end">
              <div className="space-y-2">
                <Label>T&M project</Label>
                <Select name="project_id">
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose project" /></SelectTrigger>
                  <SelectContent>
                    {options.contracts.map((contract: any) => (
                      <SelectItem key={contract.id} value={projectIdFromContract(contract)}>
                        {projectLabel(contract)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Rate schedule</Label>
                <Select name="rate_schedule_id" defaultValue={NONE}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {assignableSchedules.map((schedule) => (
                      <SelectItem key={schedule.id} value={schedule.id}>{schedule.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit">Assign</Button>
            </form>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Contract</TableHead>
                    <TableHead>Assigned schedule</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {options.contracts.map((contract: any) => (
                    <TableRow key={contract.id}>
                      <TableCell>{projectLabel(contract)}</TableCell>
                      <TableCell>{contractLabel(contract)}</TableCell>
                      <TableCell>{scheduleName(assignableSchedules, contract.rate_schedule_id)}</TableCell>
                    </TableRow>
                  ))}
                  {options.contracts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-20 text-center text-sm text-muted-foreground">
                        No active T&M projects yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {schedules.map((schedule) => (
            <Card key={schedule.id}>
              <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {schedule.name}
                    <Badge variant={schedule.status === "active" ? "default" : "outline"}>{schedule.status}</Badge>
                  </CardTitle>
                  {schedule.description ? <p className="mt-1 text-sm text-muted-foreground">{schedule.description}</p> : null}
                </div>
                {schedule.status !== "archived" ? (
                  <form action={archiveBillingRateScheduleForm.bind(null, schedule.id)}>
                    <Button size="sm" variant="outline">
                      <Archive className="h-4 w-4" />
                      Archive
                    </Button>
                  </form>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-4">
                <RateTable rates={schedule.rates} />
                {schedule.status !== "archived" ? (
                  <>
                    <Separator />
                    <form action={createBillingRateForm} className="space-y-4">
                      <input type="hidden" name="schedule_id" value={schedule.id} />
                      <RateFields options={options} />
                      <div className="flex justify-end">
                        <Button type="submit">
                          <Plus className="h-4 w-4" />
                          Add rate
                        </Button>
                      </div>
                    </form>
                  </>
                ) : null}
              </CardContent>
            </Card>
          ))}
          {schedules.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">No billing rate schedules yet.</CardContent>
            </Card>
          ) : null}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project overrides</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form action={createBillingRateOverrideForm} className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>T&M project</Label>
                  <Select name="project_contract">
                    <SelectTrigger className="w-full"><SelectValue placeholder="Choose project" /></SelectTrigger>
                    <SelectContent>
                      {options.contracts.map((contract: any) => {
                        return (
                          <SelectItem key={contract.id} value={`${projectIdFromContract(contract)}:${contract.id}`}>
                            {projectLabel(contract)} · {contractLabel(contract)}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Related schedule</Label>
                  <Select name="schedule_id" defaultValue={NONE}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Project-only override</SelectItem>
                      {assignableSchedules.map((schedule) => (
                        <SelectItem key={schedule.id} value={schedule.id}>{schedule.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <RateFields options={options} />
              <div className="flex justify-end">
                <Button type="submit">
                  <Plus className="h-4 w-4" />
                  Add override
                </Button>
              </div>
            </form>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overrides.map((override) => (
                    <TableRow key={override.id}>
                      <TableCell>
                        <div className="font-medium">{override.project_name ?? "Project override"}</div>
                        {override.contract_label ? <div className="text-xs text-muted-foreground">{override.contract_label}</div> : null}
                      </TableCell>
                      <TableCell>{rateTarget(override)}</TableCell>
                      <TableCell>{rateDisplay(override)}</TableCell>
                      <TableCell>{formatRange(override.effective_from, override.effective_to)}</TableCell>
                      <TableCell className="text-right">
                        <form action={deleteBillingRateOverrideForm.bind(null, override.id)}>
                          <Button size="icon" variant="ghost" aria-label="Delete project override">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                  {overrides.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                        No project overrides yet.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}

function RateFields({ options }: { options: Awaited<ReturnType<typeof listBillingRateOptionsAction>> }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[160px_1fr_1fr_1fr_1fr_120px_120px_110px_110px_110px_140px_140px] lg:items-end">
      <div className="space-y-2">
        <Label>Kind</Label>
        <Select name="kind" defaultValue="labor_role">
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="labor_role">Labor role</SelectItem>
            <SelectItem value="person">Person</SelectItem>
            <SelectItem value="equipment">Equipment</SelectItem>
            <SelectItem value="material">Material</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Role</Label>
        <Input name="role_name" placeholder="Carpenter" />
      </div>
      <div className="space-y-2">
        <Label>Person</Label>
        <Select name="user_id" defaultValue={NONE}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {options.teamMembers.map((member: any) => (
              <SelectItem key={member.user.id} value={member.user.id}>
                {member.user.full_name || member.user.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Equipment</Label>
        <Input name="equipment_name" placeholder="Mini excavator" />
      </div>
      <div className="space-y-2">
        <Label>Cost code</Label>
        <Select name="cost_code_id" defaultValue={NONE}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Default</SelectItem>
            {options.costCodes.map((code: any) => (
              <SelectItem key={code.id} value={code.id}>{code.code} {code.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Rate</Label>
        <Input name="rate_amount" type="number" min="0" step="0.01" placeholder="95" />
      </div>
      <div className="space-y-2">
        <Label>Markup %</Label>
        <Input name="markup_percent" type="number" min="0" max="300" step="0.01" placeholder="20" />
      </div>
      <div className="space-y-2">
        <Label>Unit</Label>
        <Select name="unit" defaultValue="hour">
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="hour">Hour</SelectItem>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="each">Each</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>OT</Label>
        <Input name="ot_multiplier" type="number" min="1" max="4" step="0.01" defaultValue="1.5" />
      </div>
      <div className="space-y-2">
        <Label>DT</Label>
        <Input name="dt_multiplier" type="number" min="1" max="4" step="0.01" defaultValue="2" />
      </div>
      <div className="space-y-2">
        <Label>From</Label>
        <Input name="effective_from" type="date" />
      </div>
      <div className="space-y-2">
        <Label>To</Label>
        <Input name="effective_to" type="date" />
      </div>
    </div>
  )
}

function RateTable({ rates }: { rates: any[] }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Target</TableHead>
            <TableHead>Rate</TableHead>
            <TableHead>Multipliers</TableHead>
            <TableHead>Effective</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rates.map((rate) => (
            <TableRow key={rate.id}>
              <TableCell>{rateTarget(rate)}</TableCell>
              <TableCell>{rateDisplay(rate)}</TableCell>
              <TableCell>OT {rate.ot_multiplier}x · DT {rate.dt_multiplier}x</TableCell>
              <TableCell>{formatRange(rate.effective_from, rate.effective_to)}</TableCell>
              <TableCell className="text-right">
                <form action={deleteBillingRateForm.bind(null, rate.id)}>
                  <Button size="icon" variant="ghost" aria-label="Delete rate">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </form>
              </TableCell>
            </TableRow>
          ))}
          {rates.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">No rates on this schedule yet.</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}

function projectFromContract(contract: any) {
  return Array.isArray(contract.project) ? contract.project[0] : contract.project
}

function projectIdFromContract(contract: any) {
  return String(projectFromContract(contract)?.id ?? contract.project_id ?? contract.id)
}

function projectLabel(contract: any) {
  const project = projectFromContract(contract)
  return project?.name ?? "Unnamed project"
}

function contractLabel(contract: any) {
  return [contract.number, contract.title].filter(Boolean).join(" ") || "T&M contract"
}

function scheduleName(schedules: Array<{ id: string; name: string }>, scheduleId?: string | null) {
  if (!scheduleId) return "Unassigned"
  return schedules.find((schedule) => schedule.id === scheduleId)?.name ?? "Archived or missing schedule"
}

function rateTarget(rate: any) {
  if (rate.kind === "person") return rate.user_name ?? "Person"
  if (rate.kind === "equipment") return rate.equipment_name ?? "Equipment"
  if (rate.kind === "material") {
    return [rate.cost_code_code, rate.cost_code_name].filter(Boolean).join(" ") || "Material default"
  }
  return rate.role_name ?? "Labor role"
}

function rateDisplay(rate: any) {
  if (rate.kind === "material" && rate.markup_percent != null) return `${rate.markup_percent}% markup`
  if (rate.rate_cents != null) return `${formatMoney(rate.rate_cents)} / ${rate.unit ?? "hour"}`
  return "No rate"
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function formatRange(from?: string | null, to?: string | null) {
  if (!from && !to) return "Always"
  return `${from ?? "Start"} to ${to ?? "Open"}`
}
