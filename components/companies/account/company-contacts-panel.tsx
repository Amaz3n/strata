"use client";

import { Fragment, useMemo, useState } from "react";

import type { Company, Contact, Project } from "@/lib/types";
import type { CompanyContactAccess } from "@/lib/services/portal-access";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet";
import { PortalInviteDialog } from "@/components/contacts/portal-invite-dialog";
import { StatusChip } from "@/components/companies/company-detail-ui";
import { Mail, MoreHorizontal, Phone } from "@/components/icons";
import { cn } from "@/lib/utils";

function initialsFor(value: string) {
  const parts = value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function formatType(value?: string) {
  if (!value) return "";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * How this person's portal access reads on the roster.
 *
 * The tab used to list names and phone numbers and stop there, which left the
 * question every other tab depends on unanswered: can this person actually get
 * in? A vendor with nobody able to sign in cannot send a certificate, sign a
 * waiver, or see a bill — and nothing on the page said so.
 */
function accessSignal(access?: CompanyContactAccess): {
  label: string;
  className: string;
  hint: string | null;
} | null {
  if (!access) return null;
  switch (access.status) {
    case "active":
      return access.accessMode === "account"
        ? {
            label: "Has an account",
            className: "border-success/40 text-success",
            hint: access.identityVerified ? null : "Email not verified yet",
          }
        : {
            label: "Invited",
            className: "border-border text-muted-foreground",
            hint: "Signs in with the link, no account yet",
          };
    case "paused":
      return { label: "Paused", className: "border-warning/40 text-warning", hint: null };
    case "expired":
      return { label: "Link expired", className: "border-warning/40 text-warning", hint: null };
    case "revoked":
    default:
      return { label: "Revoked", className: "border-border text-muted-foreground", hint: null };
  }
}

/**
 * Who works at this company, how to reach them, and who can get into the portal.
 *
 * Reachability is the spine: a contact row leads with the two things you do with
 * a contact — mail them, call them — and says plainly whether they can sign in.
 */
export function CompanyContactsPanel({
  company,
  projects,
  canEdit,
  accessByContactId,
}: {
  company: Company & { contacts: Contact[] };
  projects: Project[];
  canEdit: boolean;
  /** Portal access per contact. Empty when the read failed — never a lie. */
  accessByContactId: Record<string, CompanyContactAccess>;
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

  const openInvite = (contact: Contact) => {
    setInviteContact(contact);
    setInviteOpen(true);
  };

  /**
   * People who can transact first, then everyone else by name.
   *
   * The old list labelled whichever contact happened to sort first "Primary",
   * which was true only by accident — `primary_company_id` says this company is
   * where the person works, not that they are the one to call. Nothing on the
   * record designates a primary contact, so the roster does not invent one; it
   * leads with the people who can actually answer a request.
   */
  const contacts = useMemo(() => {
    const withAccess = company.contacts.map((contact) => ({
      contact,
      access: accessByContactId[contact.id],
    }));
    return withAccess.sort((a, b) => {
      const aAccount = a.access?.accessMode === "account" ? 0 : 1;
      const bAccount = b.access?.accessMode === "account" ? 0 : 1;
      if (aAccount !== bAccount) return aAccount - bAccount;
      return a.contact.full_name.localeCompare(b.contact.full_name);
    });
  }, [company.contacts, accessByContactId]);

  const reachable = contacts.filter((entry) => entry.access?.status === "active").length;
  const meta = [
    `${company.contacts.length} ${company.contacts.length === 1 ? "person" : "people"}`,
    reachable > 0 ? `${reachable} can sign in` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="desk-rise border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-muted/40 px-4 py-2.5">
          <span className="text-xs tabular-nums text-muted-foreground">
            {meta.join(" · ")}
          </span>
          {canEdit ? (
            <Button size="sm" className="h-7" onClick={() => setCreateOpen(true)}>
              Add contact
            </Button>
          ) : null}
        </div>

        {contacts.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <p className="text-sm text-muted-foreground">
              Nobody at {company.name} is on file yet.
            </p>
            {canEdit ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => setCreateOpen(true)}
              >
                Add the first contact
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="divide-y">
            {contacts.map(({ contact, access }) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                access={access}
                canEdit={canEdit}
                onOpen={() => openContact(contact.id)}
                onInvite={() => openInvite(contact)}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
            <DialogDescription>
              They will be filed under {company.name} as their primary company.
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
        onInvitePortal={canEdit ? (contact) => openInvite(contact) : undefined}
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
    </div>
  );
}

/**
 * One person.
 *
 * Email and phone are links, not decoration — the two things anybody does from
 * a contact list. They used to sit in a right-hand column that was hidden below
 * `sm`, which meant the phone number vanished on the device most likely to be
 * dialling it.
 */
function ContactRow({
  contact,
  access,
  canEdit,
  onOpen,
  onInvite,
}: {
  contact: Contact;
  access?: CompanyContactAccess;
  canEdit: boolean;
  onOpen: () => void;
  onInvite: () => void;
}) {
  const signal = accessSignal(access);
  const subtitle = contact.role || formatType(contact.contact_type);
  const scope = access
    ? [
        access.hasAccountScope ? "Vendor account" : null,
        ...(access.projectNames ?? []),
      ].filter(Boolean)
    : [];

  const actions = [
    canEdit && !access
      ? { key: "invite", label: "Invite to the portal", onSelect: onInvite }
      : null,
    canEdit && access && access.status !== "active"
      ? { key: "reinvite", label: "Send a new invitation", onSelect: onInvite }
      : null,
    { key: "open", label: "Open contact", onSelect: onOpen },
  ].filter((entry): entry is { key: string; label: string; onSelect: () => void } => entry !== null);

  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center border bg-muted/40 text-[11px] font-semibold text-muted-foreground"
      >
        {initialsFor(contact.full_name)}
      </span>

      {/* A fixed second track, so the contact details start at the same x on
          every row — each row is its own grid, and a content-sized track would
          resolve per row. Left-aligned inside it: an address is read
          left-to-right, and right-aligning them only tidied the edge nobody
          scans. */}
      <div className="grid min-w-0 flex-1 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="truncate text-left text-sm underline-offset-4 outline-none hover:underline focus-visible:underline"
            >
              {contact.full_name}
            </button>
            {signal ? <StatusChip label={signal.label} className={signal.className} /> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {[subtitle, signal?.hint, scope.join(" · ")].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>

        {/* The two things anyone actually does from a contact list. */}
        <div className="flex min-w-0 flex-col gap-0.5">
          {contact.email ? (
            <a
              href={`mailto:${contact.email}`}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <Mail aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{contact.email}</span>
            </a>
          ) : null}
          {contact.phone ? (
            <a
              href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}
              className="flex min-w-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <Phone aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{contact.phone}</span>
            </a>
          ) : null}
          {!contact.email && !contact.phone ? (
            <span className="text-xs text-muted-foreground">No email or phone on file</span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {canEdit && !access ? (
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "h-6 px-2 text-xs text-muted-foreground transition-opacity",
              "focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
            )}
            onClick={onInvite}
          >
            Invite
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 text-muted-foreground transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              aria-label={`Actions for ${contact.full_name}`}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.map((action, index) => (
              <Fragment key={action.key}>
                {action.key === "open" && index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={action.onSelect}>{action.label}</DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
