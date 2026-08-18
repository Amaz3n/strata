"use client";

import { useState } from "react";

import type { Company, Contact, Project } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet";
import { PortalInviteDialog } from "@/components/contacts/portal-invite-dialog";
import { EmptyState, Section } from "@/components/companies/company-detail-ui";
import { Plus } from "@/components/icons";

function initialsFor(value: string) {
  const parts = value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "CO";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function formatType(value?: string) {
  if (!value) return "Other";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function CompanyContactsPanel({
  company,
  projects,
  canEdit,
}: {
  company: Company & { contacts: Contact[] };
  projects: Project[];
  canEdit: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [inviteContact, setInviteContact] = useState<Contact | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);

  const openContact = (id: string) => {
    setDetailId(id);
    setDetailOpen(true);
  };

  return (
    <>
      <Section
        title="Contacts"
        count={company.contacts.length}
        stagger={1}
        action={
          canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 h-8"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add
            </Button>
          ) : null
        }
      >
        {company.contacts.length > 0 ? (
          <ul className="divide-y">
            {company.contacts.map((contact, index) => (
              <li key={contact.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  onClick={() => openContact(contact.id)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center border bg-muted/40 text-xs font-semibold text-muted-foreground">
                    {initialsFor(contact.full_name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {contact.full_name}
                      </span>
                      {contact.primary_company_id === company.id && index === 0 ? (
                        <Badge variant="secondary">Primary</Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {contact.role || formatType(contact.contact_type)}
                    </div>
                  </div>
                  <div className="hidden min-w-0 shrink-0 text-right sm:block">
                    {contact.email ? (
                      <div className="truncate text-xs text-muted-foreground">{contact.email}</div>
                    ) : null}
                    {contact.phone ? (
                      <div className="truncate text-xs text-muted-foreground">{contact.phone}</div>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No contacts linked yet.</EmptyState>
        )}
      </Section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
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

      <ContactDetailSheet
        contactId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onInvitePortal={
          canEdit
            ? (contact) => {
                setInviteContact(contact);
                setInviteOpen(true);
              }
            : undefined
        }
      />

      <PortalInviteDialog
        contact={inviteContact}
        projects={projects}
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) setInviteContact(undefined);
        }}
      />
    </>
  );
}
