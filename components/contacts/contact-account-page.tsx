"use client"

import Link from "next/link"
import { ArrowUpRight, BriefcaseBusiness, Building2, Mail, Phone, ReceiptText } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PartyFinancialActivity } from "@/components/financial-parties/party-financial-activity"
import type { Contact } from "@/lib/types"
import type { PartyReceivablesSummary } from "@/lib/services/financial-parties"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

type Assignments = Awaited<ReturnType<typeof import("@/lib/services/contacts").getContactAssignments>>

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="border-l border-border/80 pl-5 first:border-l-0 first:pl-0">
      <p className="microlabel">{label}</p>
      <p className="mt-2 font-mono text-2xl font-medium tracking-tight tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

export function ContactAccountPage({
  contact,
  assignments,
  receivables,
  canEdit,
}: {
  contact: Contact & { company_details: NonNullable<Contact["primary_company"]>[] }
  assignments: Assignments
  receivables: PartyReceivablesSummary
  canEdit: boolean
}) {
  const address = contact.address?.formatted
  const hasReceivables = contact.contact_type === "client" || receivables.projects.length > 0

  return (
    <div className="min-h-full bg-muted/15">
      <section className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="capitalize">{contact.contact_type}</Badge>
              {contact.has_portal_access ? <Badge variant="outline">Portal access</Badge> : null}
            </div>
            <h1 className="mt-3 truncate text-2xl font-semibold tracking-tight">{contact.full_name}</h1>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
              {contact.email ? <a className="inline-flex items-center gap-1.5 hover:text-foreground" href={`mailto:${contact.email}`}><Mail className="h-3.5 w-3.5" />{contact.email}</a> : null}
              {contact.phone ? <a className="inline-flex items-center gap-1.5 hover:text-foreground" href={`tel:${contact.phone}`}><Phone className="h-3.5 w-3.5" />{contact.phone}</a> : null}
              {address ? <span>{address}</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {hasReceivables ? (
              <Button asChild>
                <Link href={`/billing/receive-payment?partyType=contact&partyId=${contact.id}`}>
                  <ReceiptText className="mr-2 h-4 w-4" />Receive payment
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline"><Link href={`/estimates?recipient=${contact.id}`}>Create estimate</Link></Button>
            {canEdit ? <Button asChild variant="outline"><Link href="/directory?view=people">Edit in directory</Link></Button> : null}
          </div>
        </div>
        {hasReceivables ? (
          <div className="mx-auto grid max-w-7xl grid-cols-2 gap-y-5 border-t px-4 py-5 sm:px-6 lg:grid-cols-4 lg:px-8">
            <Stat label="Contract value" value={formatMoneyCentsExact(receivables.contract_value_cents)} detail={`${receivables.projects.length} project${receivables.projects.length === 1 ? "" : "s"}`} />
            <Stat label="Invoiced" value={formatMoneyCentsExact(receivables.invoiced_cents)} detail={`${receivables.invoice_count} issued invoice${receivables.invoice_count === 1 ? "" : "s"}`} />
            <Stat label="Collected" value={formatMoneyCentsExact(receivables.collected_cents)} detail="Settled receipts" />
            <Stat label="Open balance" value={formatMoneyCentsExact(receivables.outstanding_cents)} detail="Operational AR balance" />
          </div>
        ) : null}
      </section>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[1.5fr_.7fr] lg:px-8">
        <section className="border bg-background">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Projects &amp; receivables</h2>
              <p className="text-xs text-muted-foreground">Attributed once through the project’s client contact.</p>
            </div>
            <Badge variant="outline">{receivables.projects.length}</Badge>
          </div>
          {receivables.projects.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2 font-medium">Project</th><th className="px-3 py-2 text-right font-medium">Invoiced</th><th className="px-3 py-2 text-right font-medium">Collected</th><th className="px-3 py-2 text-right font-medium">Open</th><th className="px-4 py-2" /></tr></thead>
                <tbody>
                  {receivables.projects.map((project) => (
                    <tr key={project.project_id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3"><Link className="font-medium underline-offset-4 hover:underline" href={`/projects/${project.project_id}`}>{project.project_name}</Link><p className="mt-0.5 text-xs text-muted-foreground">{project.invoice_count} invoice{project.invoice_count === 1 ? "" : "s"}</p></td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMoneyCentsExact(project.invoiced_cents)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground">{formatMoneyCentsExact(project.collected_cents)}</td>
                      <td className={cn("px-3 py-3 text-right font-mono font-medium tabular-nums", project.outstanding_cents > 0 && "text-foreground")}>{formatMoneyCentsExact(project.outstanding_cents)}</td>
                      <td className="px-4 py-3 text-right"><Button asChild size="sm" variant="ghost"><Link href={`/invoices?invoice=new&project=${project.project_id}&customer=${contact.id}`}>Create invoice<ArrowUpRight className="ml-1 h-3.5 w-3.5" /></Link></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="px-5 py-12 text-center text-sm text-muted-foreground">No projects are attributed to this contact yet.</p>}
        </section>

        <div className="space-y-5">
          <section className="border bg-background">
            <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Companies</h2></div>
            <div className="divide-y">
              {(contact.company_details ?? []).map((company) => (
                <Link key={company.id} href={`/companies/${company.id}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/30"><span className="inline-flex min-w-0 items-center gap-2"><Building2 className="h-4 w-4 text-muted-foreground" /><span className="truncate">{company.name}</span></span><ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" /></Link>
              ))}
              {!contact.company_details?.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">No linked companies.</p> : null}
            </div>
          </section>
          <section className="border bg-background">
            <div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Assignments</h2></div>
            <div className="divide-y">
              {assignments.schedule.map((item) => <div key={item.id} className="flex gap-2 px-4 py-3 text-sm"><BriefcaseBusiness className="mt-0.5 h-4 w-4 text-muted-foreground" /><div><p>{item.schedule_item?.name ?? "Schedule item"}</p><p className="text-xs text-muted-foreground">{item.project?.name ?? "Project"} · {item.role ?? "Assigned"}</p></div></div>)}
              {assignments.tasks.map((item) => <div key={item.id} className="flex gap-2 px-4 py-3 text-sm"><BriefcaseBusiness className="mt-0.5 h-4 w-4 text-muted-foreground" /><div><p>{item.task?.title ?? "Task"}</p><p className="text-xs text-muted-foreground">{item.project?.name ?? "Project"}{item.due_date ? ` · due ${item.due_date}` : ""}</p></div></div>)}
              {!assignments.schedule.length && !assignments.tasks.length ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">No assignments yet.</p> : null}
            </div>
          </section>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 pb-6 sm:px-6 lg:px-8">
        <PartyFinancialActivity summary={receivables} />
      </div>
    </div>
  )
}
