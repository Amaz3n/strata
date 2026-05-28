"use client";

import {
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type {
  Company,
  ComplianceStatusSummary,
  Contact,
  Project,
} from "@/lib/types";
import type { CommitmentSummary } from "@/lib/services/commitments";
import type { VendorBillSummary } from "@/lib/services/vendor-bills";
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
import { CompanyForm } from "@/components/companies/company-form";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet";
import { CompanyContractsTab } from "@/components/companies/company-contracts-tab";
import { CompanyInvoicesTab } from "@/components/companies/company-invoices-tab";
import { CompanyComplianceTab } from "@/components/companies/company-compliance-tab";
import {
  archiveCompanyAction,
  getCompanyComplianceStatusAction,
} from "@/app/(app)/companies/actions";
import {
  AlertCircle,
  CheckCircle2,
  Edit,
  ExternalLink,
  Mail,
  MapPin,
  MoreHorizontal,
  Phone,
  Plus,
  Trash2,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatType(value?: string) {
  if (!value) return "Other";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
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

function Section({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex flex-col border bg-card", className)}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate text-lg font-semibold tabular-nums",
          emphasis ? "text-foreground" : "text-foreground/90",
        )}
      >
        {value}
      </div>
    </div>
  );
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

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

type DetailView = "overview" | "contracts" | "invoices" | "compliance";

export function CompanyDetailPage({
  company,
  projectHistory,
  commitments,
  vendorBills,
  projects,
  canEdit,
  canArchive,
}: {
  company: Company & { contacts: Contact[] };
  projectHistory: { id: string; name: string }[];
  commitments: CommitmentSummary[];
  vendorBills: VendorBillSummary[];
  projects: Project[];
  canEdit: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [contactCreateOpen, setContactCreateOpen] = useState(false);
  const [contactDetailId, setContactDetailId] = useState<string | undefined>();
  const [contactDetailOpen, setContactDetailOpen] = useState(false);
  const [view, setView] = useState<DetailView>("overview");
  const [complianceStatus, setComplianceStatus] =
    useState<ComplianceStatusSummary | null>(null);

  const totals = useMemo(() => {
    const committed = commitments.reduce(
      (sum, c) => sum + (c.total_cents ?? 0),
      0,
    );
    const billed = vendorBills.reduce(
      (sum, b) => sum + (b.total_cents ?? 0),
      0,
    );
    const paid = vendorBills.reduce(
      (sum, b) =>
        sum +
        (b.paid_cents ?? (b.status === "paid" ? (b.total_cents ?? 0) : 0)),
      0,
    );
    return {
      committed,
      billed,
      paid,
      remaining: Math.max(0, committed - billed),
    };
  }, [commitments, vendorBills]);

  const address = formatAddress(company);
  const showCompliance = companyNeedsCompliance(company);

  const workRows = useMemo(() => {
    const rows = new Map<
      string,
      {
        id: string;
        name: string;
        committed: number;
        billed: number;
        paid: number;
        lastActivity?: string;
      }
    >();

    for (const project of projectHistory) {
      rows.set(project.id, {
        id: project.id,
        name: project.name,
        committed: 0,
        billed: 0,
        paid: 0,
      });
    }

    for (const commitment of commitments) {
      const current = rows.get(commitment.project_id) ?? {
        id: commitment.project_id,
        name: commitment.project_name ?? "Untitled project",
        committed: 0,
        billed: 0,
        paid: 0,
      };
      current.committed += commitment.total_cents ?? 0;
      current.billed += commitment.billed_cents ?? 0;
      current.paid += commitment.paid_cents ?? 0;
      current.lastActivity = [
        current.lastActivity,
        commitment.updated_at,
        commitment.created_at,
      ]
        .filter(Boolean)
        .sort()
        .at(-1);
      rows.set(commitment.project_id, current);
    }

    for (const bill of vendorBills) {
      const current = rows.get(bill.project_id) ?? {
        id: bill.project_id,
        name: bill.project_name ?? "Untitled project",
        committed: 0,
        billed: 0,
        paid: 0,
      };
      current.billed += bill.total_cents ?? 0;
      current.paid +=
        bill.paid_cents ??
        (bill.status === "paid" ? (bill.total_cents ?? 0) : 0);
      current.lastActivity = [
        current.lastActivity,
        bill.updated_at,
        bill.bill_date,
        bill.created_at,
      ]
        .filter(Boolean)
        .sort()
        .at(-1);
      rows.set(bill.project_id, current);
    }

    return Array.from(rows.values()).sort((a, b) =>
      (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
    );
  }, [commitments, projectHistory, vendorBills]);

  useEffect(() => {
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
  }, [company.id]);

  const archive = () => {
    startTransition(async () => {
      try {
        if (!canArchive) {
          toast({
            title: "Permission required",
            description: "You need admin or member management access.",
          });
          return;
        }
        await archiveCompanyAction(company.id);
        toast({ title: "Company archived" });
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

  const complianceReady = complianceStatus?.is_compliant ?? null;

  const navItems: Array<{ value: DetailView; label: string }> = [
    { value: "overview", label: "Overview" },
    { value: "contracts", label: "Contracts" },
    { value: "invoices", label: "Invoices" },
    ...(showCompliance
      ? [{ value: "compliance" as const, label: "Compliance" }]
      : []),
  ];

  return (
    <div className="flex min-h-full flex-col bg-muted/20">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="flex flex-col gap-4 px-6 pt-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center border bg-muted/40 text-base font-semibold text-muted-foreground">
              {initialsFor(company.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
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
                    onClick={() => setView("compliance")}
                    className={cn(
                      "inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs font-medium transition-colors",
                      complianceReady
                        ? "border-emerald-600/30 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400"
                        : "border-amber-600/30 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-400",
                    )}
                  >
                    {complianceReady ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <AlertCircle className="h-3 w-3" />
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
                  onSelect={archive}
                  disabled={isPending || !canArchive}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Financial KPI strip — symmetric, single source of truth */}
        <div className="mt-5 grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-4">
          <Stat label="Committed" value={formatMoneyFromCents(totals.committed)} emphasis />
          <Stat label="Billed" value={formatMoneyFromCents(totals.billed)} />
          <Stat label="Paid" value={formatMoneyFromCents(totals.paid)} />
          <Stat label="Remaining" value={formatMoneyFromCents(totals.remaining)} emphasis />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto border-t px-4">
          {navItems.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setView(item.value)}
              className={cn(
                "relative h-11 shrink-0 px-3 text-sm font-medium transition-colors",
                view === item.value
                  ? "text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Overview */}
      {view === "overview" ? (
        <div className="flex-1 space-y-4 p-4 sm:p-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="Contacts"
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
                <div className="divide-y">
                  {company.contacts.map((contact, index) => (
                    <button
                      key={contact.id}
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
                  ))}
                </div>
              ) : (
                <EmptyState>No contacts linked yet.</EmptyState>
              )}
            </Section>

            <Section title="Details">
              <div className="px-4 py-2">
                <DetailRow
                  label="Payment terms"
                  value={company.default_payment_terms || "—"}
                />
                <DetailRow
                  label="License"
                  value={company.license_number || "—"}
                />
                <DetailRow
                  label="Rating"
                  value={company.rating ? `${company.rating}/5` : "—"}
                />
                <DetailRow label="Projects" value={projectHistory.length} />
                <DetailRow label="Contacts" value={company.contacts.length} />
              </div>
              {company.internal_notes || company.notes ? (
                <div className="space-y-3 border-t px-4 py-3 text-sm">
                  {company.internal_notes ? (
                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Internal notes
                      </div>
                      <p className="whitespace-pre-wrap text-foreground/90">
                        {company.internal_notes}
                      </p>
                    </div>
                  ) : null}
                  {company.notes ? (
                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Shared notes
                      </div>
                      <p className="whitespace-pre-wrap text-foreground/90">
                        {company.notes}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Section>
          </div>

          <Section title="Work history" bodyClassName="overflow-x-auto">
            {workRows.length > 0 ? (
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead className="pl-4">Project</TableHead>
                    <TableHead className="text-right">Contracted</TableHead>
                    <TableHead className="text-right">Billed</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Remaining</TableHead>
                    <TableHead className="pr-4 text-right">Last activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workRows.map((row) => (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => router.push(`/projects/${row.id}`)}
                    >
                      <TableCell className="pl-4 font-medium">
                        <Link
                          href={`/projects/${row.id}`}
                          onClick={(event) => event.stopPropagation()}
                          className="hover:text-primary"
                        >
                          {row.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoneyFromCents(row.committed)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoneyFromCents(row.billed)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoneyFromCents(row.paid)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoneyFromCents(Math.max(0, row.committed - row.billed))}
                      </TableCell>
                      <TableCell className="pr-4 text-right text-muted-foreground">
                        {formatDate(row.lastActivity)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState>No project history yet.</EmptyState>
            )}
          </Section>
        </div>
      ) : null}

      {/* Contracts */}
      {view === "contracts" ? (
        <div className="flex-1 p-4 sm:p-6">
          <CompanyContractsTab
            companyId={company.id}
            commitments={commitments}
            projects={projects}
          />
        </div>
      ) : null}

      {/* Invoices */}
      {view === "invoices" ? (
        <div className="flex-1 p-4 sm:p-6">
          <CompanyInvoicesTab
            companyId={company.id}
            commitments={commitments}
            vendorBills={vendorBills}
          />
        </div>
      ) : null}

      {/* Compliance */}
      {view === "compliance" && showCompliance ? (
        <div className="flex-1 bg-card">
          <CompanyComplianceTab company={company} />
        </div>
      ) : null}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit company</DialogTitle>
            <DialogDescription>
              Update company profile, payment defaults, and notes.
            </DialogDescription>
          </DialogHeader>
          <CompanyForm
            company={company}
            onSubmitted={() => setEditOpen(false)}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={contactCreateOpen} onOpenChange={setContactCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
            <DialogDescription>
              New contacts will default to this company as their primary
              company.
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
      />
    </div>
  );
}
