"use client";

import {
  useEffect,
  useMemo,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import type {
  Company,
  ComplianceStatusSummary,
  Contact,
  Project,
} from "@/lib/types";
import type { CommitmentSummary } from "@/lib/services/commitments";
import type { ClientCompanyReceivablesSummary } from "@/lib/services/companies";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
import type {
  VendorScorecardSummary,
  VendorTaxReadinessSummary,
} from "@/lib/services/directory-intelligence";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { CompanyForm } from "@/components/companies/company-form";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet";
import { PortalInviteDialog } from "@/components/contacts/portal-invite-dialog";
import { CompanyCommitments } from "@/components/companies/company-commitments";
import { CompanyPayables } from "@/components/companies/company-payables";
import { CompanyComplianceTab } from "@/components/companies/company-compliance-tab";
import { PrequalificationCard } from "@/components/companies/prequalification-card";
import type { Prequalification } from "@/lib/services/prequalification";
import {
  EmptyState,
  Section,
  TABLE_EDGE,
  formatDate,
  formatMoneyFromCents,
} from "@/components/companies/company-detail-ui";
import {
  archiveCompanyAction,
  getCompanyComplianceStatusAction,
  restoreCompanyAction,
} from "@/app/(app)/companies/actions";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Edit,
  ExternalLink,
  Mail,
  MapPin,
  MoreHorizontal,
  Phone,
  Plus,
} from "@/components/icons";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

import { unwrapAction } from "@/lib/action-result"

function formatType(value?: string) {
  if (!value) return "Other";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAddress(company: Company) {
  const address = company.address;
  if (!address) return undefined;
  if (typeof address === "string") return address;
  return (
    address.formatted ||
    [
      address.street1,
      address.street2,
      address.city,
      address.state,
      address.postal_code,
    ]
      .filter(Boolean)
      .join(", ")
  );
}

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

function companyNeedsCompliance(company: Company) {
  return (
    company.company_type === "subcontractor" ||
    company.company_type === "supplier"
  );
}

function scrollToSection(id: string) {
  document
    .getElementById(id)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}

function ContactChip({
  icon,
  href,
  children,
  external,
}: {
  icon: ReactNode;
  href?: string;
  children: ReactNode;
  external?: boolean;
}) {
  if (!children) return null;
  const inner = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
  if (!href) {
    return <span className="text-sm text-muted-foreground">{inner}</span>;
  }
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      {inner}
    </a>
  );
}

function W9Value({
  readiness,
}: {
  readiness?: VendorTaxReadinessSummary | null;
}) {
  if (!readiness || !readiness.requires_1099) {
    return <span className="text-muted-foreground">Not required</span>;
  }
  const map: Record<
    VendorTaxReadinessSummary["w9_status"],
    { label: string; className: string }
  > = {
    ready: { label: "On file", className: "text-success" },
    pending_review: { label: "Pending review", className: "text-warning" },
    missing: { label: "Missing", className: "text-warning" },
    rejected: { label: "Rejected", className: "text-destructive" },
    not_required: { label: "Not required", className: "text-muted-foreground" },
  };
  const status = map[readiness.w9_status] ?? map.missing;
  return <span className={status.className}>{status.label}</span>;
}

function ClientReceivables({
  summary,
  stagger,
  fill = false,
  className,
}: {
  summary?: ClientCompanyReceivablesSummary | null;
  stagger: number;
  fill?: boolean;
  className?: string;
}) {
  const rows = summary?.projects ?? [];
  return (
    <Section
      title="Receivables"
      count={rows.length}
      stagger={stagger}
      fill={fill}
      className={className}
      bodyClassName="overflow-x-auto"
    >
      {summary && !summary.can_view_invoices ? (
        <div className="border-b px-4 py-3 text-sm text-muted-foreground">
          Invoice totals require invoice access. Contract values and client
          projects are still shown.
        </div>
      ) : null}
      {rows.length > 0 ? (
        <Table className={cn("min-w-[760px]", TABLE_EDGE)}>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-48">Project</TableHead>
              <TableHead className="text-right">Contract</TableHead>
              <TableHead className="text-right">Invoiced</TableHead>
              <TableHead className="text-right">Collected</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead className="text-right">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.project_id} className="group relative">
                <TableCell>
                  <Link
                    href={`/projects/${row.project_id}`}
                    className="font-medium underline-offset-4 after:absolute after:inset-0 group-hover:underline"
                  >
                    {row.project_name}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMoneyFromCents(row.contract_value_cents)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatMoneyFromCents(row.invoiced_cents)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatMoneyFromCents(row.collected_cents)}
                </TableCell>
                <TableCell className="text-right font-mono font-medium tabular-nums">
                  {formatMoneyFromCents(row.outstanding_cents)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatDate(row.last_activity)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState>No client projects yet.</EmptyState>
      )}
    </Section>
  );
}

const EXPAND_TRANSITION = { duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const;

type AttentionTone = "warning" | "destructive";

interface AttentionItem {
  key: string;
  tone: AttentionTone;
  label: string;
  detail?: string;
  onClick?: () => void;
}

export function CompanyDetailPage({
  company,
  projectHistory,
  commitments,
  vendorBills,
  clientReceivables,
  vendorScorecard = null,
  vendorTaxReadiness = null,
  projects,
  canEdit,
  canArchive,
  prequalification = null,
}: {
  company: Company & { contacts: Contact[] };
  projectHistory: { id: string; name: string }[];
  commitments: CommitmentSummary[];
  vendorBills: VendorBillSummary[];
  clientReceivables?: ClientCompanyReceivablesSummary | null;
  vendorScorecard?: VendorScorecardSummary | null;
  vendorTaxReadiness?: VendorTaxReadinessSummary | null;
  projects: Project[];
  canEdit: boolean;
  canArchive: boolean;
  prequalification?: Prequalification | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [contactCreateOpen, setContactCreateOpen] = useState(false);
  const [contactDetailId, setContactDetailId] = useState<string | undefined>();
  const [contactDetailOpen, setContactDetailOpen] = useState(false);
  const [inviteContact, setInviteContact] = useState<Contact | undefined>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [complianceSheetOpen, setComplianceSheetOpen] = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<"commitments" | null>(null);
  const [complianceStatus, setComplianceStatus] =
    useState<ComplianceStatusSummary | null>(null);

  const isClientCompany = company.company_type === "client";
  const isVendorCompany =
    company.company_type === "subcontractor" ||
    company.company_type === "supplier";
  const showCompliance = companyNeedsCompliance(company);
  const address = formatAddress(company);

  const projectCount = useMemo(() => {
    const ids = new Set<string>();
    projectHistory.forEach((p) => ids.add(p.id));
    commitments.forEach((c) => ids.add(c.project_id));
    vendorBills.forEach((b) => ids.add(b.project_id));
    (clientReceivables?.projects ?? []).forEach((p) => ids.add(p.project_id));
    return ids.size;
  }, [clientReceivables, commitments, projectHistory, vendorBills]);

  const overdueBills = useMemo(() => {
    if (isClientCompany) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return vendorBills.filter((bill) => {
      if (bill.status === "paid" || !bill.due_date) return false;
      const paid = bill.paid_cents ?? 0;
      if ((bill.total_cents ?? 0) - paid <= 0) return false;
      return new Date(`${bill.due_date}T00:00:00`) < today;
    });
  }, [isClientCompany, vendorBills]);

  const attention = useMemo<AttentionItem[]>(() => {
    if (!isVendorCompany) return [];
    const items: AttentionItem[] = [];

    if (overdueBills.length > 0) {
      const cents = overdueBills.reduce(
        (sum, b) => sum + ((b.total_cents ?? 0) - (b.paid_cents ?? 0)),
        0,
      );
      items.push({
        key: "overdue",
        tone: "destructive",
        label: `${overdueBills.length} overdue ${overdueBills.length === 1 ? "bill" : "bills"}`,
        detail: formatMoneyFromCents(cents),
        onClick: () => scrollToSection("payables"),
      });
    }

    if (complianceStatus && !complianceStatus.is_compliant) {
      const missing = complianceStatus.missing.length;
      const expired = complianceStatus.expired.length;
      const expiring = complianceStatus.expiring_soon.length;
      const parts = [
        missing > 0 ? `${missing} missing` : null,
        expired > 0 ? `${expired} expired` : null,
        expiring > 0 ? `${expiring} expiring` : null,
      ].filter(Boolean);
      items.push({
        key: "compliance",
        tone: missing > 0 || expired > 0 ? "destructive" : "warning",
        label: "Compliance action required",
        detail: parts.join(" · ") || undefined,
        onClick: () => setComplianceSheetOpen(true),
      });
    }

    if (
      vendorTaxReadiness?.requires_1099 &&
      (vendorTaxReadiness.w9_status === "missing" ||
        vendorTaxReadiness.w9_status === "rejected")
    ) {
      items.push({
        key: "w9",
        tone: vendorTaxReadiness.w9_status === "rejected" ? "destructive" : "warning",
        label: `W-9 ${vendorTaxReadiness.w9_status} for ${vendorTaxReadiness.tax_year}`,
        onClick: () => scrollToSection("profile"),
      });
    }

    return items;
  }, [complianceStatus, isVendorCompany, overdueBills, vendorTaxReadiness]);

  useEffect(() => {
    if (!showCompliance) {
      setComplianceStatus(null);
      return;
    }
    let cancelled = false;
    getCompanyComplianceStatusAction(company.id)
      .then((status) => {
        if (!cancelled) setComplianceStatus(status);
      })
      .catch(() => {
        if (!cancelled) setComplianceStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, showCompliance]);

  // Deep-link from the directory compliance review sheet.
  useEffect(() => {
    if (searchParams.get("tab") === "compliance" && showCompliance) {
      setComplianceSheetOpen(true);
    }
  }, [searchParams, showCompliance]);

  const refreshComplianceStatus = () => {
    if (!showCompliance) return;
    getCompanyComplianceStatusAction(company.id)
      .then(setComplianceStatus)
      .catch(() => {});
  };

  const complianceReady = complianceStatus?.is_compliant ?? null;

  const restoreArchivedCompany = async () => {
    try {
      unwrapAction(await restoreCompanyAction(company.id));
      toast({ title: "Company restored" });
      router.push(`/companies/${company.id}`);
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
        if (!canArchive) {
          toast({
            title: "Permission required",
            description: "You need directory write access.",
          });
          return;
        }
        unwrapAction(await archiveCompanyAction(company.id));
        setArchiveDialogOpen(false);
        toast({
          title: "Company archived",
          action: (
            <ToastAction
              altText="Undo archive"
              onClick={() => void restoreArchivedCompany()}
            >
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

  const openContact = (id: string) => {
    setContactDetailId(id);
    setContactDetailOpen(true);
  };

  const openPortalInvite = (contact: Contact) => {
    setInviteContact(contact);
    setInviteOpen(true);
  };

  const renderProfile = (placement: string, stagger: number) => (
    <Section
      id="profile"
      title="Profile"
      stagger={stagger}
      fill
      className={placement}
    >
      <div className="px-4 py-2">
        <DetailRow
          label="Payment terms"
          value={company.default_payment_terms || "—"}
        />
        <DetailRow label="License" value={company.license_number || "—"} />
        <DetailRow
          label="Rating"
          value={company.rating ? `${company.rating}/5` : "—"}
        />
        <DetailRow label="Projects" value={projectCount} />
        {isVendorCompany ? (
          <>
            <button
              type="button"
              onClick={() => setComplianceSheetOpen(true)}
              className="flex w-full items-baseline justify-between gap-4 py-2 text-sm"
            >
              <span className="shrink-0 text-muted-foreground">Compliance</span>
              <span className="flex min-w-0 items-center gap-1.5 font-medium">
                {complianceReady === null ? (
                  <span className="text-muted-foreground">View</span>
                ) : complianceReady ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    <span className="text-success">Compliant</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                    <span className="text-warning">Action required</span>
                  </>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            </button>
            <DetailRow
              label="Performance score"
              value={
                vendorScorecard &&
                vendorScorecard.rating_label !== "Needs data"
                  ? `${Math.round(vendorScorecard.score)} · ${vendorScorecard.rating_label}`
                  : "Not enough data yet"
              }
            />
            <DetailRow
              label={`W-9 (${vendorTaxReadiness?.tax_year ?? new Date().getFullYear()})`}
              value={<W9Value readiness={vendorTaxReadiness} />}
            />
          </>
        ) : null}
      </div>
      {company.internal_notes || company.notes ? (
        <div className="space-y-3 border-t px-4 py-3 text-sm">
          {company.internal_notes ? (
            <div>
              <div className="mb-1 microlabel">Internal notes</div>
              <p className="whitespace-pre-wrap text-foreground/90">
                {company.internal_notes}
              </p>
            </div>
          ) : null}
          {company.notes ? (
            <div>
              <div className="mb-1 microlabel">Shared notes</div>
              <p className="whitespace-pre-wrap text-foreground/90">
                {company.notes}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {isVendorCompany ? (
        <div className="border-t p-4">
          <PrequalificationCard companyId={company.id} prequalification={prequalification} canEdit={canEdit} />
        </div>
      ) : null}
    </Section>
  );

  const renderContacts = (placement: string, stagger: number) => (
    <Section
      title="Contacts"
      count={company.contacts.length}
      stagger={stagger}
      fill
      className={placement}
      action={
        canEdit ? (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 h-8"
            onClick={() => setContactCreateOpen(true)}
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
                    {index === 0 ? (
                      <Badge variant="secondary">Primary</Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {contact.role || formatType(contact.contact_type)}
                  </div>
                </div>
                <div className="hidden min-w-0 shrink-0 text-right sm:block">
                  {contact.email ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {contact.email}
                    </div>
                  ) : null}
                  {contact.phone ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {contact.phone}
                    </div>
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
  );

  const dimmed = expandedPanel === "commitments";
  const dimClass =
    "lg:transition-opacity lg:duration-300" +
    (dimmed ? " lg:pointer-events-none lg:opacity-0" : "");

  return (
    <div className="flex min-h-full flex-col bg-background lg:h-full lg:min-h-0">
      {/* ── Header: identity + what needs attention ─────────────────────── */}
      <section className="desk-rise shrink-0 border-b bg-card">
        <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center border bg-muted/40 text-sm font-semibold text-muted-foreground">
                {initialsFor(company.name)}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    {company.name}
                  </h1>
                  <Badge variant="secondary">
                    {formatType(company.company_type)}
                  </Badge>
                  {company.trade ? (
                    <Badge variant="outline">{company.trade}</Badge>
                  ) : null}
                  {showCompliance && complianceReady !== null ? (
                    <button
                      type="button"
                      onClick={() => setComplianceSheetOpen(true)}
                      className={cn(
                        "inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs font-medium transition-colors",
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
                      {complianceReady ? "Ready to work" : "Action required"}
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <ContactChip
                    icon={<Mail className="h-3.5 w-3.5" />}
                    href={company.email ? `mailto:${company.email}` : undefined}
                  >
                    {company.email}
                  </ContactChip>
                  <ContactChip
                    icon={<Phone className="h-3.5 w-3.5" />}
                    href={company.phone ? `tel:${company.phone}` : undefined}
                  >
                    {company.phone}
                  </ContactChip>
                  <ContactChip
                    icon={<ExternalLink className="h-3.5 w-3.5" />}
                    href={company.website || undefined}
                    external
                  >
                    {company.website?.replace(/^https?:\/\//, "")}
                  </ContactChip>
                  <ContactChip icon={<MapPin className="h-3.5 w-3.5" />}>
                    {address}
                  </ContactChip>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {canEdit ? (
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="h-9 w-9">
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Company actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    onSelect={() => setEditOpen(true)}
                    disabled={!canEdit}
                  >
                    <Edit className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
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

          {/* What needs attention — only when there is something */}
          {attention.length > 0 ? (
            <div className="mt-4 flex flex-col gap-2 border-t pt-4">
              {attention.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onClick}
                  className={cn(
                    "flex items-center gap-3 border px-3 py-2 text-left transition-colors",
                    item.tone === "destructive"
                      ? "border-destructive/30 bg-destructive/10 hover:bg-destructive/15"
                      : "border-warning/30 bg-warning/10 hover:bg-warning/15",
                  )}
                >
                  <AlertTriangle
                    className={cn(
                      "h-4 w-4 shrink-0",
                      item.tone === "destructive" ? "text-destructive" : "text-warning",
                    )}
                  />
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                    {item.label}
                  </span>
                  {item.detail ? (
                    <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
                      {item.detail}
                    </span>
                  ) : null}
                  {item.onClick ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Working area: fixed 2×2 dashboard on lg, stacked on mobile ───── */}
      <div className="mx-auto flex w-full max-w-7xl flex-col px-4 py-6 sm:px-6 lg:min-h-0 lg:flex-1 lg:px-8 lg:py-5">
        {isClientCompany ? (
          <div className="grid grid-cols-1 gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:grid-rows-2">
            <ClientReceivables
              summary={clientReceivables}
              stagger={1}
              fill
              className="lg:col-span-2 lg:row-start-1"
            />
            {renderProfile("lg:col-start-1 lg:row-start-2", 2)}
            {renderContacts("lg:col-start-2 lg:row-start-2", 3)}
          </div>
        ) : (
          <div className="relative grid grid-cols-1 gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:grid-rows-2 lg:overflow-hidden">
            <CompanyCommitments
              companyId={company.id}
              commitments={commitments}
              projects={projects}
              canEdit={canEdit}
              stagger={1}
              fill
              expanded={false}
              onToggleExpand={(next) =>
                setExpandedPanel(next ? "commitments" : null)
              }
              className={cn("lg:col-start-1 lg:row-start-1", dimClass)}
            />
            <CompanyPayables
              vendorBills={vendorBills}
              stagger={2}
              fill
              className={cn("lg:col-start-2 lg:row-start-1", dimClass)}
            />
            {renderProfile(cn("lg:col-start-1 lg:row-start-2", dimClass), 3)}
            {renderContacts(cn("lg:col-start-2 lg:row-start-2", dimClass), 4)}

            <AnimatePresence>
              {expandedPanel === "commitments" ? (
                <motion.div
                  key="commitments-overlay"
                  className="absolute inset-0 z-20 hidden origin-top-left lg:block"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={EXPAND_TRANSITION}
                >
                  <CompanyCommitments
                    companyId={company.id}
                    commitments={commitments}
                    projects={projects}
                    canEdit={canEdit}
                    fill
                    expanded
                    onToggleExpand={(next) =>
                      setExpandedPanel(next ? "commitments" : null)
                    }
                    className="lg:h-full"
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        )}
      </div>

      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="gap-0 p-0 sm:max-w-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <div className="border-b px-6 pt-6 pb-4">
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

      <Dialog open={contactCreateOpen} onOpenChange={setContactCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
            <DialogDescription>
              New contacts will default to this company as their primary company.
            </DialogDescription>
          </DialogHeader>
          <ContactForm
            key={contactCreateOpen ? "open" : "closed"}
            companies={[company]}
            defaultPrimaryCompanyId={company.id}
            onSubmitted={() => setContactCreateOpen(false)}
            onCancel={() => setContactCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <ContactDetailSheet
        contactId={contactDetailId}
        open={contactDetailOpen}
        onOpenChange={setContactDetailOpen}
        onInvitePortal={canEdit ? openPortalInvite : undefined}
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

      {showCompliance ? (
        <Sheet
          open={complianceSheetOpen}
          onOpenChange={(open) => {
            setComplianceSheetOpen(open);
            if (!open) refreshComplianceStatus();
          }}
        >
          <SheetContent
            side="right"
            mobileFullscreen
            className="gap-0 p-0 sm:max-w-3xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
            style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
          >
            <div className="border-b px-6 pt-6 pb-4">
              <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
                Compliance
              </SheetTitle>
              <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
                {company.name} — required documents, review, and waivers.
              </SheetDescription>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CompanyComplianceTab company={company} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive company?</AlertDialogTitle>
            <AlertDialogDescription>
              {company.name} will be hidden from the directory. You can restore
              it with Undo after archiving.
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
    </div>
  );
}
