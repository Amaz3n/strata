"use client";

import { Fragment, useState, useTransition, type CSSProperties } from "react";
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
import { Badge } from "@/components/ui/badge";
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
  archiveCompanyAction,
  restoreCompanyAction,
  setCompanyPaymentAccessStatusAction,
} from "@/app/(app)/companies/actions";
import { archiveContactAction, restoreContactAction } from "@/app/(app)/contacts/actions";
import type { CompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations";
import { unwrapAction } from "@/lib/action-result";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Edit,
  Plus,
} from "@/components/icons";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { initialsFor } from "@/lib/directory/initials";
import { useToast } from "@/hooks/use-toast";

export type PartyHeaderSubject =
  | { kind: "company"; company: Company & { contacts: Contact[] } }
  | { kind: "contact"; contact: Contact }

export function PartyAccountHeader({
  subject,
  roles,
  isVendor,
  isClient,
  canEdit,
  canArchive,
  complianceReady,
  complianceHref,
  paymentStatus,
  tabs,
}: {
  subject: PartyHeaderSubject;
  /** What this party is to the org. Replaces the single type badge. */
  roles: DirectoryRoleState[];
  isVendor: boolean;
  isClient: boolean;
  canEdit: boolean;
  canArchive: boolean;
  complianceReady: boolean | null;
  complianceHref: string | null;
  paymentStatus: CompanyPaymentReadiness["status"] | null;
  tabs: PartyTab[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
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

  const paymentEnrolled = paymentStatus !== null && paymentStatus !== "not_started";
  const paymentPaused = paymentStatus === "suspended" || paymentStatus === "revoked";
  const showPaymentAccess = isCompany && isVendor && canEdit && paymentEnrolled;

  return (
    <section
      className="desk-rise shrink-0 border-b bg-card"
      style={{ "--desk-stagger": 0 } as CSSProperties}
    >
      <div className="w-full px-4 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center border bg-muted/40 text-xs font-semibold text-muted-foreground">
              {initialsFor(name)}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-semibold tracking-tight text-foreground">
                  {name}
                </h1>
                {roles.map((role) => (
                  <Badge key={role.key} variant="outline" className="shrink-0 font-normal">
                    {role.label}
                    {role.status !== "active" ? (
                      <span className="ml-1.5 text-muted-foreground">
                        {roleStatusLabel(role.status)}
                      </span>
                    ) : null}
                  </Badge>
                ))}
                {complianceHref && complianceReady !== null ? (
                  <Link
                    href={complianceHref}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-xs font-medium transition-colors",
                      complianceReady
                        ? "border-success/40 text-success hover:bg-success/10"
                        : "border-warning/40 text-warning hover:bg-warning/10",
                    )}
                  >
                    {complianceReady ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {complianceReady ? "Compliant" : "Action required"}
                  </Link>
                ) : null}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {meta.map((part, index) => (
                  <Fragment key={part}>
                    {index > 0 ? <span aria-hidden>·</span> : null}
                    <span className="truncate">{part}</span>
                  </Fragment>
                ))}
                {email ? (
                  <>
                    {meta.length > 0 ? <span aria-hidden>·</span> : null}
                    <a
                      href={`mailto:${email}`}
                      className="truncate underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      {email}
                    </a>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0">
                Actions
                <ChevronDown className="ml-1.5 h-4 w-4" />
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
              {showPaymentAccess ? (
                <>
                  <DropdownMenuSeparator />
                  {paymentPaused ? (
                    <DropdownMenuItem
                      onSelect={() => changePaymentAccess("active")}
                      disabled={isPending}
                    >
                      Restore electronic payment
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        onSelect={() => changePaymentAccess("suspended")}
                        disabled={isPending}
                      >
                        Suspend electronic payment
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => changePaymentAccess("revoked")}
                        disabled={isPending}
                      >
                        Revoke electronic payment
                      </DropdownMenuItem>
                    </>
                  )}
                </>
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

      <div className="mt-3 w-full">
        <PartyTabNav tabs={tabs} />
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
            {isCompany ? (
              <CompanyForm
                company={subject.company}
                onSubmitted={() => setEditOpen(false)}
                onCancel={() => setEditOpen(false)}
              />
            ) : (
              <ContactForm
                contact={subject.contact}
                companies={[]}
                onSubmitted={() => setEditOpen(false)}
                onCancel={() => setEditOpen(false)}
              />
            )}
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
