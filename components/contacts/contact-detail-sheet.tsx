"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { Company, Contact } from "@/lib/types"
import { getContactAction } from "@/app/(app)/contacts/actions"
import { trackInCrmAction } from "@/app/(app)/pipeline/actions"
import { Mail, Phone, Loader2, Contact as ContactIcon } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

interface ContactDetail {
  contact: Contact
  assignments: Awaited<ReturnType<typeof getContactAction>>["assignments"]
}

interface ContactDetailSheetProps {
  contactId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ContactDetailSheet({ contactId, open, onOpenChange }: ContactDetailSheetProps) {
  const [data, setData] = useState<ContactDetail | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isTrackingCrm, setIsTrackingCrm] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  useEffect(() => {
    if (!open || !contactId) return
    startTransition(async () => {
      try {
        const result = await getContactAction(contactId)
        setData(result as ContactDetail)
      } catch (error) {
        toast({ title: "Unable to load contact", description: (error as Error).message })
      }
    })
  }, [contactId, open, toast])

  const contact = data?.contact

  const handleTrackInPipeline = async () => {
    if (!contact) return
    setIsTrackingCrm(true)
    try {
      await trackInCrmAction(contact.id)
      router.refresh()
      toast({ title: "Contact tracked in Pipeline" })
      router.push(`/prospects`)
    } catch (error) {
      toast({ title: "Failed to track in Pipeline", description: (error as Error).message })
    } finally {
      setIsTrackingCrm(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Contact details</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[80vh] pr-2">
          {!contact || isPending ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div>
                <h3 className="text-lg font-semibold">{contact.full_name}</h3>
                <div className="flex flex-wrap gap-2 mt-2">
                  <Badge variant="secondary">{contact.contact_type}</Badge>
                  {contact.primary_company?.name && <Badge variant="outline">{contact.primary_company.name}</Badge>}
                  {contact.has_portal_access && <Badge variant="outline">Portal access</Badge>}
                </div>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Contact info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  {contact.phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4" />
                      <span>{contact.phone}</span>
                    </div>
                  )}
                  {contact.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      <span>{contact.email}</span>
                    </div>
                  )}
                  {contact.notes && (
                    <div className="text-muted-foreground text-sm whitespace-pre-wrap">{contact.notes}</div>
                  )}
                  {(contact.crm_source || contact.external_crm_id) && (
                    <div className="text-xs text-muted-foreground">
                      {contact.crm_source && <span>CRM: {contact.crm_source}</span>}
                      {contact.crm_source && contact.external_crm_id ? " · " : ""}
                      {contact.external_crm_id && <span>ID: {contact.external_crm_id}</span>}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Companies</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  {(contact.company_details as Company[] | undefined)?.length ? (
                    contact.company_details?.map((company) => (
                      <div key={company.id} className="flex items-center justify-between">
                        <span>{company.name}</span>
                        <Badge variant="outline">{company.company_type}</Badge>
                      </div>
                    ))
                  ) : (
                    <p>No linked companies.</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Assignments</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  {data?.assignments.schedule.length === 0 && data?.assignments.tasks.length === 0 ? (
                    <p>No assignments yet.</p>
                  ) : (
                    <>
                      {data?.assignments.schedule.map((item) => (
                        <div key={item.id} className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-foreground">{item.schedule_item?.name ?? "Schedule item"}</div>
                            <div className="text-xs text-muted-foreground">
                              {item.project_id} · {item.role ?? "Assigned"}
                            </div>
                          </div>
                          {item.confirmed_at && <Badge variant="outline">Confirmed</Badge>}
                        </div>
                      ))}
                      {data?.assignments.tasks.map((item) => (
                        <div key={item.id} className="flex items-center justify-between">
                          <div>
                            <div className="font-medium text-foreground">{item.task?.title ?? "Task"}</div>
                            <div className="text-xs text-muted-foreground">{item.role ?? "Assigned"}</div>
                          </div>
                          {item.due_date && <Badge variant="outline">Due {item.due_date}</Badge>}
                        </div>
                      ))}
                    </>
                  )}
                </CardContent>
              </Card>

              <Separator />
              <div className="flex justify-between gap-2">
                <Button
                  variant="outline"
                  onClick={handleTrackInPipeline}
                  disabled={isTrackingCrm}
                >
                  <ContactIcon className="h-4 w-4 mr-2" />
                  {isTrackingCrm ? "Tracking..." : "Track in Pipeline"}
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" asChild>
                    <Link href={`/estimates?recipient=${contact.id}`}>Create estimate</Link>
                  </Button>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                </div>
              </div>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}





