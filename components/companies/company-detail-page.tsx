"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import type { Company, ComplianceStatusSummary, Contact, Project } from "@/lib/types"
import type { CommitmentSummary } from "@/lib/services/commitments"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { CompanyForm } from "@/components/companies/company-form"
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet"
import { CompanyContractsTab } from "@/components/companies/company-contracts-tab"
import { CompanyInvoicesTab } from "@/components/companies/company-invoices-tab"
import { CompanyComplianceTab } from "@/components/companies/company-compliance-tab"
import { CompanyProjectsTab } from "@/components/companies/company-projects-tab"
import { CompanyContactsTab } from "@/components/companies/company-contacts-tab"
import { archiveCompanyAction, getCompanyComplianceStatusAction } from "@/app/(app)/companies/actions"
import { useToast } from "@/hooks/use-toast"

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

// Compliance is tracked via the document/requirements system, so this page
// uses the compliance status summary rather than legacy company fields.

export function CompanyDetailPage({
  company,
  projectHistory,
  commitments,
  vendorBills,
  projects,
  canEdit,
  canArchive,
}: {
  company: Company & { contacts: Contact[] }
  projectHistory: { id: string; name: string }[]
  commitments: CommitmentSummary[]
  vendorBills: VendorBillSummary[]
  projects: Project[]
  canEdit: boolean
  canArchive: boolean
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [editOpen, setEditOpen] = useState(false)
  const [contactDetailId, setContactDetailId] = useState<string | undefined>()
  const [contactDetailOpen, setContactDetailOpen] = useState(false)
  const [tab, setTab] = useState("overview")
  const [complianceStatus, setComplianceStatus] = useState<ComplianceStatusSummary | null>(null)

  const totals = useMemo(() => {
    const committed = commitments.reduce((sum, c) => sum + (c.total_cents ?? 0), 0)
    const billed = vendorBills.reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    const paid = vendorBills.reduce((sum, b) => sum + (b.paid_cents ?? (b.status === "paid" ? b.total_cents ?? 0 : 0)), 0)
    return { committed, billed, paid }
  }, [commitments, vendorBills])

  useEffect(() => {
    let cancelled = false
    getCompanyComplianceStatusAction(company.id)
      .then((status) => {
        if (cancelled) return
        setComplianceStatus(status)
      })
      .catch(() => {
        if (cancelled) return
        setComplianceStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [company.id])

  const archive = () => {
    startTransition(async () => {
      try {
        if (!canArchive) {
          toast({ title: "Permission required", description: "You need admin or member management access." })
          return
        }
        await archiveCompanyAction(company.id)
        toast({ title: "Company archived" })
        router.push("/directory?view=companies")
      } catch (error) {
        toast({ title: "Unable to archive company", description: (error as Error).message })
      }
    })
  }

  const openContact = (id: string) => {
    setContactDetailId(id)
    setContactDetailOpen(true)
  }

  return (
    <div className="space-y-6">
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="contacts">Contacts</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
            <TabsTrigger value="contracts">Contracts</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="compliance">Compliance</TabsTrigger>
          </TabsList>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-10 w-10">
                <span className="sr-only">Company actions</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  if (!canEdit) return
                  setEditOpen(true)
                }}
                disabled={!canEdit}
              >
                Edit company
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={(e) => {
                  e.preventDefault()
                  archive()
                }}
                disabled={isPending || !canArchive}
              >
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Edit company</DialogTitle>
                <DialogDescription>Update company profile, compliance, and defaults.</DialogDescription>
              </DialogHeader>
              <CompanyForm company={company} onSubmitted={() => setEditOpen(false)} onCancel={() => setEditOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Compliance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={complianceStatus?.is_compliant ? "secondary" : "outline"}>
                    {complianceStatus ? (complianceStatus.is_compliant ? "Compliant" : "Action required") : "—"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Missing</span>
                  <span className="font-medium text-foreground">{complianceStatus?.missing.length ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Pending review</span>
                  <span className="font-medium text-foreground">{complianceStatus?.pending_review.length ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Expired</span>
                  <span className="font-medium text-foreground">{complianceStatus?.expired.length ?? "—"}</span>
                </div>
                <div className="pt-2">
                  <Button variant="outline" size="sm" onClick={() => setTab("compliance")}>
                    Review in Compliance tab
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Contract totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Committed</span>
                  <span className="font-medium">{formatMoneyFromCents(totals.committed)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Billed</span>
                  <span className="font-medium">{formatMoneyFromCents(totals.billed)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Paid</span>
                  <span className="font-medium">{formatMoneyFromCents(totals.paid)}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Quick info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Type</span>
                  <Badge variant="secondary">{company.company_type}</Badge>
                </div>
                {company.trade && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Trade</span>
                    <Badge variant="outline">{company.trade}</Badge>
                  </div>
                )}
                {company.rating && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Rating</span>
                    <span className="font-medium text-foreground">{company.rating}/5</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Email</span>
                  <span className="text-foreground">{company.email || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Phone</span>
                  <span className="text-foreground">{company.phone || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Website</span>
                  <span className="text-foreground">{company.website || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Default terms</span>
                  <span className="text-foreground">{company.default_payment_terms || "—"}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Internal notes</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground whitespace-pre-wrap">
              {company.internal_notes || "—"}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contacts">
          <CompanyContactsTab company={company} onOpenContact={openContact} />
        </TabsContent>

        <TabsContent value="projects">
          <CompanyProjectsTab projects={projectHistory} />
        </TabsContent>

        <TabsContent value="contracts">
          <CompanyContractsTab companyId={company.id} commitments={commitments} projects={projects} />
        </TabsContent>

        <TabsContent value="invoices">
          <CompanyInvoicesTab companyId={company.id} commitments={commitments} vendorBills={vendorBills} />
        </TabsContent>

        <TabsContent value="compliance">
          <CompanyComplianceTab company={company} />
        </TabsContent>
      </Tabs>

      <ContactDetailSheet contactId={contactDetailId} open={contactDetailOpen} onOpenChange={setContactDetailOpen} />
    </div>
  )
}
