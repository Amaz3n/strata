"use client";

import { Fragment, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { Company, Contact } from "@/lib/types";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { CompanyForm } from "@/components/companies/company-form";
import { CompanyTabNav, type CompanyTab } from "@/components/companies/account/company-tab-nav";
import {
  archiveCompanyAction,
  restoreCompanyAction,
  setCompanyPaymentAccessStatusAction,
} from "@/app/(app)/companies/actions";
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
import { useToast } from "@/hooks/use-toast";

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

export function CompanyAccountHeader({
  company,
  posture,
  canEdit,
  canArchive,
  complianceReady,
  complianceHref,
  paymentStatus,
  tabs,
}: {
  company: Company & { contacts: Contact[] };
  posture: "vendor" | "client" | "other";
  canEdit: boolean;
  canArchive: boolean;
  complianceReady: boolean | null;
  complianceHref: string | null;
  paymentStatus: CompanyPaymentReadiness["status"] | null;
  tabs: CompanyTab[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const restoreArchivedCompany = async () => {
    try {
      unwrapAction(await restoreCompanyAction(company.id));
      toast({ title: "Company restored" });
      router.push(`/directory/${company.id}`);
      router.refresh();
    } catch (error) {
      toast({
        title: "Unable to restore company",
        description: (error as Error).message,
      });
    }
  };

  const confirmArchive = () => {
    startTransition(async () => {
      try {
        unwrapAction(await archiveCompanyAction(company.id));
        setArchiveDialogOpen(false);
        toast({
          title: "Company archived",
          action: (
            <ToastAction altText="Undo archive" onClick={() => void restoreArchivedCompany()}>
              Undo
            </ToastAction>
          ),
        });
        router.push("/directory?view=companies");
      } catch (error) {
        toast({
          title: "Unable to archive company",
          description: (error as Error).message,
        });
      }
    });
  };

  const changePaymentAccess = (nextStatus: "active" | "suspended" | "revoked") =>
    startTransition(async () => {
      try {
        unwrapAction(await setCompanyPaymentAccessStatusAction(company.id, nextStatus));
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

  const meta = [formatType(company.company_type), company.trade].filter(Boolean) as string[];
  const paymentEnrolled =
    paymentStatus !== null && paymentStatus !== "not_started";
  const paymentPaused = paymentStatus === "suspended" || paymentStatus === "revoked";
  const showPaymentAccess = posture === "vendor" && canEdit && paymentEnrolled;

  return (
    <section className="desk-rise shrink-0 border-b bg-card" style={{ "--desk-stagger": 0 } as CSSProperties}>
      <div className="w-full px-4 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center border bg-muted/40 text-xs font-semibold text-muted-foreground">
              {initialsFor(company.name)}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-base font-semibold tracking-tight text-foreground">
                  {company.name}
                </h1>
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
                {company.email ? (
                  <>
                    {meta.length > 0 ? <span aria-hidden>·</span> : null}
                    <a
                      href={`mailto:${company.email}`}
                      className="truncate underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      {company.email}
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
            <DropdownMenuContent align="end" className="w-48">
              {posture === "vendor" ? (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/payables?new=1&vendor=${company.id}`}>
                      <Plus className="mr-2 h-4 w-4" />
                      Enter bill
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/payables?tab=pay&q=${encodeURIComponent(company.name)}`}>
                      <CreditCard className="mr-2 h-4 w-4" />
                      Pay
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {posture === "client" ? (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/billing/receive-payment?partyType=company&partyId=${company.id}`}>
                      <CreditCard className="mr-2 h-4 w-4" />
                      Receive payment
                    </Link>
                  </DropdownMenuItem>
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
        <CompanyTabNav tabs={tabs} />
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
              Edit company
            </SheetTitle>
            <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
              Update company profile, payment defaults, and notes.
            </SheetDescription>
          </div>
          <div className="min-h-0 flex-1 px-6 py-4">
            <CompanyForm
              company={company}
              onSubmitted={() => setEditOpen(false)}
              onCancel={() => setEditOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive company?</AlertDialogTitle>
            <AlertDialogDescription>
              {company.name} will be hidden from the directory. You can restore it with Undo after
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
