"use client"

import { useEffect, useState, useTransition } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { Company, Contact } from "@/lib/types"
import { getCompanyAction } from "@/app/companies/actions"
import { TradeBadge } from "@/components/companies/trade-badge"
import { MapPin, Phone, Mail, Link2, Loader2 } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

interface CompanyDetail {
  company: Company
  projects: { id: string; name: string }[]
}

interface CompanyDetailSheetProps {
  companyId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CompanyDetailSheet({ companyId, open, onOpenChange }: CompanyDetailSheetProps) {
  const [data, setData] = useState<CompanyDetail | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  useEffect(() => {
    if (!open || !companyId) return
    startTransition(async () => {
      try {
        const result = await getCompanyAction(companyId)
        setData(result)
      } catch (error) {
        toast({ title: "Unable to load company", description: (error as Error).message })
      }
    })
  }, [companyId, open, toast])

  const company = data?.company

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Company details</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[80vh] pr-2">
          {!company || isPending ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold">{company.name}</h3>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <Badge variant="secondary">{company.company_type}</Badge>
                    <TradeBadge trade={company.trade} />
                    {company.license_number && <Badge variant="outline">Lic #{company.license_number}</Badge>}
                    {company.insurance_expiry && <Badge variant="outline">Ins exp {company.insurance_expiry}</Badge>}
                  </div>
                </div>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Contact info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  {company.phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4" />
                      <span>{company.phone}</span>
                    </div>
                  )}
                  {company.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      <span>{company.email}</span>
                    </div>
                  )}
                  {company.website && (
                    <div className="flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      <a href={company.website} className="text-primary hover:underline" target="_blank" rel="noreferrer">
                        {company.website}
                      </a>
                    </div>
                  )}
                  {company.address?.formatted && (
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      <span>{company.address.formatted}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Projects</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  {(data?.projects ?? []).length === 0 ? (
                    <p>No project history.</p>
                  ) : (
                    <div className="space-y-1">
                      {data?.projects.map((project) => (
                        <div key={project.id} className="flex items-center justify-between">
                          <span>{project.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Contacts</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  {(company.contacts as Contact[] | undefined)?.length ? (
                    company.contacts?.map((contact) => (
                      <div key={contact.id} className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-foreground">{contact.full_name}</div>
                          <div className="text-xs text-muted-foreground">{contact.role ?? contact.contact_type}</div>
                        </div>
                        {contact.phone && <span>{contact.phone}</span>}
                      </div>
                    ))
                  ) : (
                    <p>No contacts linked.</p>
                  )}
                </CardContent>
              </Card>

              {company.notes && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{company.notes}</p>
                </div>
              )}

              <Separator />
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}


