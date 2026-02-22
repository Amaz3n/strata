"use client"

import { useState } from "react"

import type { Company, Contact } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ContactForm } from "@/components/contacts/contact-form"

export function CompanyContactsTab({
  company,
  onOpenContact,
  canEdit = false,
}: {
  company: Company & { contacts: Contact[] }
  onOpenContact: (id: string) => void
  canEdit?: boolean
}) {
  const [createOpen, setCreateOpen] = useState(false)

  const formatPhone = (phone?: string | null) => {
    if (!phone) return "—"
    const digits = phone.replace(/\D/g, "")
    if (digits.length === 10) {
      const [, area, mid, last] = digits.match(/(\d{3})(\d{3})(\d{4})/) || []
      if (area && mid && last) return `(${area}) ${mid}-${last}`
    }
    return phone
  }

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            Add contact
          </Button>
        </div>
      ) : null}

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Name</TableHead>
              <TableHead className="px-4 py-3">Role</TableHead>
              <TableHead className="px-4 py-3">Type</TableHead>
              <TableHead className="px-4 py-3">Email</TableHead>
              <TableHead className="px-4 py-3">Phone</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {company.contacts.map((contact) => (
              <TableRow
                key={contact.id}
                className="divide-x align-top hover:bg-muted/40 cursor-pointer"
                onClick={() => onOpenContact(contact.id)}
              >
                <TableCell className="font-medium px-4 py-3">{contact.full_name}</TableCell>
                <TableCell className="px-4 py-3 text-sm text-muted-foreground">{contact.role || "—"}</TableCell>
                <TableCell className="px-4 py-3">
                  <Badge variant="secondary" className="capitalize">
                    {contact.contact_type}
                  </Badge>
                </TableCell>
                <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                  {contact.email ? (
                    <a
                      href={`mailto:${contact.email}`}
                      className="text-foreground hover:text-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {contact.email}
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-sm text-muted-foreground">{formatPhone(contact.phone)}</TableCell>
              </TableRow>
            ))}
            {company.contacts.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                  No contacts linked.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add contact to {company.name}</DialogTitle>
            <DialogDescription>
              New contacts will default to this company as their primary company.
            </DialogDescription>
          </DialogHeader>
          <ContactForm
            key={createOpen ? "open" : "closed"}
            companies={[company]}
            defaultPrimaryCompanyId={company.id}
            onSubmitted={() => setCreateOpen(false)}
            onCancel={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
