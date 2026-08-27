"use client";

import { Fragment, Suspense, use, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { Company, Contact } from "@/lib/types";
import type { DirectoryRoleState } from "@/lib/services/directory";
import { roleStatusLabel } from "@/lib/directory/roles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CompanyForm } from "@/components/companies/company-form";
import { ContactForm } from "@/components/contacts/contact-form";
import { PartyTabNav, type PartyTab } from "@/components/directory/account/party-tab-nav";
import {
  DeferredPartyRolesEditor,
  type PartyRolesData,
} from "@/components/directory/account/party-roles-editor";
import {
  archiveCompanyAction,
  restoreCompanyAction,
  setCompanyPaymentAccessStatusAction,
} from "@/app/(app)/companies/actions";
import { archiveContactAction, restoreContactAction } from "@/app/(app)/contacts/actions";
import type { DirectoryVendorHeaderSignals } from "@/lib/directory/vendor-data";
import { unwrapAction } from "@/lib/action-result";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  CreditCard,
  Edit,
  MoreHorizontal,
  Plus,
  Tag,
} from "@/components/icons";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { initialsFor } from "@/lib/directory/initials";
import { useToast } from "@/hooks/use-toast";

export type PartyHeaderSubject =
  | { kind: "company"; company: Pick<Company, "id" | "name" | "email" | "trade"> }
  | {
      kind: "contact"
      contact: Pick<Contact, "id" | "full_name" | "email" | "role"> & {
        primary_company?: { name: string }
      }
    }

type EditablePartyHeaderSubject =
  | { kind: "company"; company: Company & { contacts: Contact[] } }
  | { kind: "contact"; contact: Contact }

function DeferredPartyEditForm({
  subject,
  onSubmitted,
  onCancel,
}: {
  subject: Promise<EditablePartyHeaderSubject | null>
  onSubmitted: () => void
  onCancel: () => void
}) {
  const editable = use(subject)
  if (!editable) {
    return <p className="text-sm text-muted-foreground">This directory record is unavailable.</p>
  }
  return editable.kind === "company" ? (
    <CompanyForm company={editable.company} onSubmitted={onSubmitted} onCancel={onCancel} />
  ) : (
    <ContactForm
      contact={editable.contact}
      companies={[]}
      onSubmitted={onSubmitted}
      onCancel={onCancel}
    />
  )
}

function DeferredComplianceBadge({
  signals,
  href,
}: {
  signals: Promise<DirectoryVendorHeaderSignals>;
  href: string;
}) {
  const { complianceReady } = use(signals);
  if (complianceReady === null) return null;
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 border px-1.5 text-[11px] font-medium transition-colors",
        complianceReady
          ? "border-success/30 bg-success/[0.06] text-success hover:bg-success/10"
          : "border-warning/35 bg-warning/[0.07] text-warning hover:bg-warning/10",
      )}
    >
      {complianceReady ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertTriangle className="h-3 w-3" />
      )}
      {complianceReady ? "Compliant" : "Action required"}
    </Link>
  );
}

function DeferredPaymentAccessItems({
  signals,
  isPending,
  onChange,
}: {
  signals: Promise<DirectoryVendorHeaderSignals>;
  isPending: boolean;
  onChange: (status: "active" | "suspended" | "revoked") => void;
}) {
  const { paymentStatus } = use(signals);
  const enrolled = paymentStatus !== null && paymentStatus !== "not_started";
  if (!enrolled) return null;
  const paused = paymentStatus === "suspended" || paymentStatus === "revoked";
  return (
    <>
      <DropdownMenuSeparator />
      {paused ? (
        <DropdownMenuItem onSelect={() => onChange("active")} disabled={isPending}>
          Restore electronic payment
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuItem onSelect={() => onChange("suspended")} disabled={isPending}>
            Suspend electronic payment
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onChange("revoked")}
            disabled={isPending}
          >
            Revoke electronic payment
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

export function PartyAccountHeader({
  subject,
  editableSubject,
  roles,
  rolesData,
  isVendor,
  isClient,
  canEdit,
  canArchive,
  complianceHref,
  vendorSignals,
  tabs,
}: {
  subject: PartyHeaderSubject;
  editableSubject: Promise<EditablePartyHeaderSubject | null>;
  /** What this party is to the org. Replaces the single type badge. */
  roles: DirectoryRoleState[];
  /** The same roles in full, for the manager behind the chips. */
  rolesData: Promise<PartyRolesData | null>;
  isVendor: boolean;
  isClient: boolean;
  canEdit: boolean;
  canArchive: boolean;
  complianceHref: string | null;
  vendorSignals?: Promise<DirectoryVendorHeaderSignals>;
  tabs: PartyTab[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const isCompany = subject.kind === "company";
  const partyId = isCompany ? subject.company.id : subject.contact.id;
  const name = isCompany ? subject.company.name : subject.contact.full_name;
  const email = isCompany ? subject.company.email : subject.contact.email;
  const noun = isCompany ? "Company" : "Contact";

  const restoreArchived = async () => {
    try {
      if (isCompany) unwrapAction(await restoreCompanyAction(partyId));
      else unwrapAction(await restoreContactAction(partyId));
      toast({ title: `${noun} restored` });
      router.push(`/directory/${partyId}`);
      router.refresh();
    } catch (error) {
      toast({
        title: `Unable to restore ${noun.toLowerCase()}`,
        description: (error as Error).message,
      });
    }
  };

  const confirmArchive = () => {
    startTransition(async () => {
      try {
        if (isCompany) unwrapAction(await archiveCompanyAction(partyId));
        else unwrapAction(await archiveContactAction(partyId));
        setArchiveDialogOpen(false);
        toast({
          title: `${noun} archived`,
          action: (
            <ToastAction altText="Undo archive" onClick={() => void restoreArchived()}>
              Undo
            </ToastAction>
          ),
        });
        router.push(isCompany ? "/directory" : "/directory?kind=contact");
      } catch (error) {
        toast({
          title: `Unable to archive ${noun.toLowerCase()}`,
          description: (error as Error).message,
        });
      }
    });
  };

  const changePaymentAccess = (nextStatus: "active" | "suspended" | "revoked") =>
    startTransition(async () => {
      try {
        unwrapAction(await setCompanyPaymentAccessStatusAction(partyId, nextStatus));
        toast({
          title:
            nextStatus === "active"
              ? "Payment access restored"
              : nextStatus === "suspended"
                ? "Payment access suspended"
                : "Payment access revoked",
          description:
            nextStatus === "active"
              ? "The next payment to this vendor is held for your new-vendor hold period before it can be released."
              : nextStatus === "suspended"
                ? "Existing in-flight payments are unchanged; future runs are blocked and the vendor's payment page is closed."
                : "Their payment claim is withdrawn with their access. Existing in-flight payments are unchanged.",
        });
        router.refresh();
      } catch (error) {
        toast({
          title: "Unable to change payment access",
          description: (error as Error).message,
        });
      }
    });

  // A person's title at their company, or a company's trade — the one line of
  // context under the name that is not already a role chip.
  const meta = (
    isCompany
      ? [subject.company.trade]
      : [subject.contact.role, subject.contact.primary_company?.name]
  ).filter(Boolean) as string[];

  const primaryAction = isCompany && isVendor ? (
    <Button
      asChild
      size="sm"
      className="hidden h-8 bg-foreground px-3 text-background hover:bg-foreground/85 sm:inline-flex"
    >
      <Link href={`/payables?new=1&vendor=${partyId}`} aria-label="Add bill">
        <Plus className="h-3.5 w-3.5" />
        Add bill
      </Link>
    </Button>
  ) : isClient ? (
    <Button
      asChild
      size="sm"
      className="hidden h-8 bg-foreground px-3 text-background hover:bg-foreground/85 sm:inline-flex"
    >
      <Link
        href={`/billing/receive-payment?partyType=${subject.kind}&partyId=${partyId}`}
        aria-label="Receive payment"
      >
        <CreditCard className="h-3.5 w-3.5" />
        Receive payment
      </Link>
    </Button>
  ) : canEdit ? (
    <Button
      variant="outline"
      size="sm"
      className="hidden h-8 px-3 sm:inline-flex"
      onClick={() => setEditOpen(true)}
    >
      <Edit className="h-3.5 w-3.5" />
      Edit
    </Button>
  ) : null;

  return (
    <section className="shrink-0 border-b bg-background" data-record-header={subject.kind}>
      <div className="flex min-h-[4.75rem] w-full items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="relative grid h-10 w-10 shrink-0 place-items-center border border-foreground/15 bg-foreground/[0.035] font-mono text-[11px] font-semibold tracking-[0.08em] text-foreground">
            {initialsFor(name)}
            <span
              aria-hidden
              className="absolute -right-px -top-px h-2 w-2 border-b border-l border-foreground/20 bg-background"
            />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="max-w-full truncate text-lg font-semibold leading-tight tracking-[-0.025em] text-foreground">
                {name}
              </h1>
              {roles.map((role) => (
                <span
                  key={role.key}
                  className="inline-flex h-5 shrink-0 items-center gap-1.5 border border-border/70 bg-muted/20 px-1.5 text-[11px] text-muted-foreground"
                >
                  <span aria-hidden className="h-1 w-1 bg-foreground/45" />
                  {role.label}
                  {role.status !== "active" ? (
                    <span className="text-muted-foreground/65">
                      {roleStatusLabel(role.status)}
                    </span>
                  ) : null}
                </span>
              ))}
              {complianceHref && vendorSignals ? (
                <Suspense fallback={null}>
                  <DeferredComplianceBadge signals={vendorSignals} href={complianceHref} />
                </Suspense>
              ) : null}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {meta.map((part, index) => (
                <Fragment key={part}>
                  {index > 0 ? <span aria-hidden className="text-border">/</span> : null}
                  <span className="truncate">{part}</span>
                </Fragment>
              ))}
              {email ? (
                <>
                  {meta.length > 0 ? <span aria-hidden className="text-border">/</span> : null}
                  <a
                    href={`mailto:${email}`}
                    className="truncate underline-offset-4 transition-colors hover:text-foreground hover:underline"
                  >
                    {email}
                  </a>
                </>
              ) : null}
              {meta.length === 0 && !email ? <span>No profile details yet</span> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {primaryAction}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                className="h-8 w-8 bg-background"
                aria-label={`${noun} actions`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isCompany && isVendor ? (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/payables?new=1&vendor=${partyId}`}>
                      <Plus className="mr-2 h-4 w-4" />
                      Enter bill
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/payables?tab=pay&q=${encodeURIComponent(name)}`}>
                      <CreditCard className="mr-2 h-4 w-4" />
                      Pay
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/directory/${partyId}/compliance`}>
                      <AlertTriangle className="mr-2 h-4 w-4" />
                      Compliance setup
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/directory/${partyId}/prequalification`}>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Prequalification setup
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {isClient ? (
                <>
                  <DropdownMenuItem asChild>
                    <Link
                      href={`/billing/receive-payment?partyType=${subject.kind}&partyId=${partyId}`}
                    >
                      <CreditCard className="mr-2 h-4 w-4" />
                      Receive payment
                    </Link>
                  </DropdownMenuItem>
                  {!isCompany ? (
                    <DropdownMenuItem asChild>
                      <Link href={`/estimates?recipient=${partyId}`}>
                        <Plus className="mr-2 h-4 w-4" />
                        Create estimate
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem onSelect={() => setEditOpen(true)} disabled={!canEdit}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRolesOpen(true)} disabled={!canEdit}>
                <Tag className="mr-2 h-4 w-4" />
                Manage roles
              </DropdownMenuItem>
              {isCompany && isVendor && canEdit && vendorSignals ? (
                <Suspense fallback={null}>
                  <DeferredPaymentAccessItems
                    signals={vendorSignals}
                    isPending={isPending}
                    onChange={changePaymentAccess}
                  />
                </Suspense>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setArchiveDialogOpen(true)}
                disabled={isPending || !canArchive}
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="w-full border-t bg-muted/[0.22]">
        <PartyTabNav tabs={tabs} vendorSignals={vendorSignals} />
      </div>

      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="fast-sheet-animation flex flex-col gap-0 p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-2xl"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <div className="border-b px-6 pb-4 pt-6">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              Edit {noun.toLowerCase()}
            </SheetTitle>
            <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
              {isCompany
                ? "Update company profile, payment defaults, and notes."
                : "Update this person's details and where they work."}
            </SheetDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {editOpen ? (
              <Suspense
                fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}
              >
                <DeferredPartyEditForm
                  subject={editableSubject}
                  onSubmitted={() => setEditOpen(false)}
                  onCancel={() => setEditOpen(false)}
                />
              </Suspense>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={rolesOpen} onOpenChange={setRolesOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="fast-sheet-animation flex flex-col gap-0 p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-md"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <div className="border-b px-6 pb-4 pt-6">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              Roles
            </SheetTitle>
            <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
              What {name} is to your organization. Roles decide which tabs, pickers and
              obligations apply, and a party can hold more than one.
            </SheetDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {rolesOpen ? (
              <Suspense fallback={<p className="text-sm text-muted-foreground">Loading roles…</p>}>
                <DeferredPartyRolesEditor
                  partyId={partyId}
                  kind={subject.kind}
                  data={rolesData}
                  canEdit={canEdit}
                />
              </Suspense>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {noun.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              {name} will be hidden from the directory. You can restore it with Undo after
              archiving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmArchive}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
