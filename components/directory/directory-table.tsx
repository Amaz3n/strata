"use client";

import { useEffect, useRef } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { Company, ComplianceStatusSummary, Contact } from "@/lib/types";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  Building2,
  Edit,
  Loader2,
  Mail,
  MoreHorizontal,
  Phone,
  Send,
} from "@/components/icons";

export type DirectoryView = "all" | "companies" | "people";
export type DirectorySortKey = "name" | "type" | "detail";
export type DirectorySortDirection = "asc" | "desc";

type DirectoryItem =
  | { type: "company"; id: string; name: string; company: Company }
  | { type: "contact"; id: string; name: string; contact: Contact };

interface DirectoryTableProps {
  companies: Company[];
  contacts: Contact[];
  entries?: DirectoryItem[];
  complianceStatusByCompanyId?: Record<string, ComplianceStatusSummary>;
  view: DirectoryView;
  sort: DirectorySortKey;
  direction: DirectorySortDirection;
  total: number;
  loadedCount: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onSortChange: (sort: DirectorySortKey) => void;
  onSelectCompany?: (id: string) => void;
  onSelectContact?: (id: string) => void;
  onEditCompany?: (company: Company) => void;
  onEditContact?: (contact: Contact) => void;
  onInviteContact?: (contact: Contact) => void;
  onArchiveCompany?: (companyId: string) => void;
  onArchiveContact?: (contactId: string) => void;
}

function formatType(value?: string) {
  if (!value) return "Other";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

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

function contactCompanyIds(contact: Contact) {
  return new Set(
    [
      contact.primary_company_id,
      ...(contact.companies?.map((link) => link.company_id) ?? []),
    ].filter(Boolean) as string[],
  );
}

function contactCompanyLabel(
  contact: Contact,
  companyById: Map<string, Company>,
) {
  if (contact.primary_company?.name) return contact.primary_company.name;
  if (contact.primary_company_id)
    return companyById.get(contact.primary_company_id)?.name;
  const linked = contact.companies?.[0]?.company_id;
  return linked ? companyById.get(linked)?.name : undefined;
}

function ContactMethods({ email, phone }: { email?: string; phone?: string }) {
  if (!email && !phone)
    return <span className="text-muted-foreground">No contact info</span>;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      {email ? (
        <a
          className="flex min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground"
          href={`mailto:${email}`}
        >
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{email}</span>
        </a>
      ) : null}
      {phone ? (
        <a
          className="flex min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground"
          href={`tel:${phone}`}
        >
          <Phone className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{phone}</span>
        </a>
      ) : null}
    </div>
  );
}

// Lowkey inline flag — only shown when a vendor actually needs attention.
function ComplianceFlag({ status }: { status?: ComplianceStatusSummary }) {
  if (!status || status.is_compliant) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
      <AlertTriangle className="h-3 w-3" />
      Action required
    </span>
  );
}

function SortHead({
  label,
  sortKey,
  activeSort,
  direction,
  className,
  onSortChange,
}: {
  label: string;
  sortKey: DirectorySortKey;
  activeSort: DirectorySortKey;
  direction: DirectorySortDirection;
  className?: string;
  onSortChange: (sort: DirectorySortKey) => void;
}) {
  const active = activeSort === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className="flex items-center gap-1.5 text-left hover:text-foreground"
        onClick={() => onSortChange(sortKey)}
      >
        {label}
        {active ? (
          direction === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

function InfiniteScrollSentinel({
  hasMore,
  isLoading,
  onLoadMore,
  rootRef,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onLoadMoreRef.current();
            break;
          }
        }
      },
      { root: rootRef.current ?? null, rootMargin: "400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, rootRef]);

  return <div ref={sentinelRef} aria-hidden className="h-px w-full" />;
}

export function DirectoryTable({
  companies,
  contacts,
  entries,
  complianceStatusByCompanyId = {},
  view,
  sort,
  direction,
  total,
  loadedCount,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSortChange,
  onSelectCompany,
  onSelectContact,
  onEditCompany,
  onEditContact,
  onInviteContact,
  onArchiveCompany,
  onArchiveContact,
}: DirectoryTableProps) {
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const desktopScrollRef = useRef<HTMLDivElement>(null);
  const companyById = new Map(
    companies.map((company) => [company.id, company]),
  );
  const contactsByCompany = new Map<string, Contact[]>();
  for (const contact of contacts) {
    for (const companyId of contactCompanyIds(contact)) {
      const current = contactsByCompany.get(companyId) ?? [];
      current.push(contact);
      contactsByCompany.set(companyId, current);
    }
  }

  const items: DirectoryItem[] =
    entries ??
    [
      ...companies.map((company) => ({
        type: "company" as const,
        id: company.id,
        name: company.name,
        company,
      })),
      ...contacts.map((contact) => ({
        type: "contact" as const,
        id: contact.id,
        name: contact.full_name,
        contact,
      })),
    ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Mobile list */}
      <div
        ref={mobileScrollRef}
        className="min-h-0 flex-1 overflow-auto md:hidden"
      >
        {items.length === 0 ? (
          <div className="flex h-56 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No directory entries match this view.
          </div>
        ) : (
          <>
            <ul className="divide-y">
              {items.map((item) =>
                item.type === "company" ? (
                  <CompanyMobileRow
                    key={`m-company-${item.id}`}
                    company={item.company}
                    contacts={contactsByCompany.get(item.id) ?? []}
                    complianceStatus={
                      complianceStatusByCompanyId[item.company.id]
                    }
                    onSelectCompany={onSelectCompany}
                    onEditCompany={onEditCompany}
                    onArchiveCompany={onArchiveCompany}
                  />
                ) : (
                  <ContactMobileRow
                    key={`m-contact-${item.id}`}
                    contact={item.contact}
                    companyLabel={contactCompanyLabel(item.contact, companyById)}
                    onSelectContact={onSelectContact}
                    onEditContact={onEditContact}
                    onInviteContact={onInviteContact}
                    onArchiveContact={onArchiveContact}
                  />
                ),
              )}
            </ul>
            {hasMore ? (
              <InfiniteScrollSentinel
                hasMore={hasMore}
                isLoading={isLoadingMore}
                onLoadMore={onLoadMore}
                rootRef={mobileScrollRef}
              />
            ) : null}
            <InfiniteScrollStatus
              hasMore={hasMore}
              isLoading={isLoadingMore}
              loadedCount={loadedCount}
              total={total}
              compact
            />
          </>
        )}
      </div>

      {/* Desktop table */}
      <div
        ref={desktopScrollRef}
        className="hidden min-h-0 flex-1 overflow-auto md:block"
      >
        <Table className="min-w-[960px]">
          <TableHeader className="sticky top-0 z-10 bg-background">
            {view === "companies" ? (
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <SortHead
                  label="Company"
                  sortKey="name"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[34%] pl-4"
                />
                <SortHead
                  label="Type"
                  sortKey="type"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[16%]"
                />
                <SortHead
                  label="Trade"
                  sortKey="detail"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[24%]"
                />
                <TableHead className="w-[22%]">Contact info</TableHead>
                <TableHead className="w-12 pr-4" />
              </TableRow>
            ) : view === "people" ? (
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <SortHead
                  label="Person"
                  sortKey="name"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[34%] pl-4"
                />
                <SortHead
                  label="Company"
                  sortKey="type"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[24%]"
                />
                <SortHead
                  label="Role"
                  sortKey="detail"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[18%]"
                />
                <TableHead className="w-[20%]">Contact info</TableHead>
                <TableHead className="w-12 pr-4" />
              </TableRow>
            ) : (
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <SortHead
                  label="Directory entry"
                  sortKey="name"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[36%] pl-4"
                />
                <SortHead
                  label="Kind"
                  sortKey="type"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[14%]"
                />
                <SortHead
                  label="Trade / role"
                  sortKey="detail"
                  activeSort={sort}
                  direction={direction}
                  onSortChange={onSortChange}
                  className="w-[22%]"
                />
                <TableHead className="w-[24%]">Contact</TableHead>
                <TableHead className="w-12 pr-4" />
              </TableRow>
            )}
          </TableHeader>
          <TableBody>
            {items.map((item) =>
              item.type === "company" ? (
                <CompanyRow
                  key={`company-${item.id}`}
                  item={item}
                  view={view}
                  contacts={contactsByCompany.get(item.id) ?? []}
                  complianceStatus={complianceStatusByCompanyId[item.company.id]}
                  onSelectCompany={onSelectCompany}
                  onEditCompany={onEditCompany}
                  onArchiveCompany={onArchiveCompany}
                />
              ) : (
                <ContactRow
                  key={`contact-${item.id}`}
                  item={item}
                  companyLabel={contactCompanyLabel(item.contact, companyById)}
                  view={view}
                  onSelectContact={onSelectContact}
                  onEditContact={onEditContact}
                  onInviteContact={onInviteContact}
                  onArchiveContact={onArchiveContact}
                />
              ),
            )}
            {items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-56 text-center text-muted-foreground"
                >
                  No directory entries match this view.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {items.length > 0 ? (
          <>
            {hasMore ? (
              <InfiniteScrollSentinel
                hasMore={hasMore}
                isLoading={isLoadingMore}
                onLoadMore={onLoadMore}
                rootRef={desktopScrollRef}
              />
            ) : null}
            <InfiniteScrollStatus
              hasMore={hasMore}
              isLoading={isLoadingMore}
              loadedCount={loadedCount}
              total={total}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function InfiniteScrollStatus({
  hasMore,
  isLoading,
  loadedCount,
  total,
  compact,
}: {
  hasMore: boolean;
  isLoading: boolean;
  loadedCount: number;
  total: number;
  compact?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading more…
      </div>
    );
  }
  if (hasMore) {
    return <div className={compact ? "h-16" : "h-12"} aria-hidden />;
  }
  return (
    <div className="px-4 py-4 text-center text-xs text-muted-foreground">
      {loadedCount === 0
        ? "No entries"
        : `Showing all ${total} ${total === 1 ? "entry" : "entries"}`}
    </div>
  );
}

function CompanyMobileRow({
  company,
  contacts,
  complianceStatus,
  onSelectCompany,
  onEditCompany,
  onArchiveCompany,
}: {
  company: Company;
  contacts: Contact[];
  complianceStatus?: ComplianceStatusSummary;
  onSelectCompany?: (id: string) => void;
  onEditCompany?: (company: Company) => void;
  onArchiveCompany?: (companyId: string) => void;
}) {
  const contactCount = company.contact_count ?? contacts.length;
  const metaParts = [
    formatType(company.company_type),
    company.trade,
    `${contactCount} ${contactCount === 1 ? "contact" : "contacts"}`,
  ].filter(Boolean) as string[];

  const hasActions = Boolean(onEditCompany || onArchiveCompany);

  return (
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={() => onSelectCompany?.(company.id)}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border bg-muted/40">
          <Building2 className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {company.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {metaParts.join(" · ")}
          </p>
          {company.email || company.phone ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {company.phone ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Phone className="h-2.5 w-2.5" />
                  <span className="truncate">{company.phone}</span>
                </span>
              ) : null}
              {company.email ? (
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <Mail className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{company.email}</span>
                </span>
              ) : null}
            </div>
          ) : null}
          {complianceStatus && !complianceStatus.is_compliant ? (
            <div className="mt-1.5">
              <ComplianceFlag status={complianceStatus} />
            </div>
          ) : null}
        </div>
      </button>
      {hasActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-auto w-12 shrink-0 text-muted-foreground active:bg-muted/60"
              aria-label={`Actions for ${company.name}`}
            >
              <MoreHorizontal className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEditCompany ? (
              <DropdownMenuItem onSelect={() => onEditCompany(company)}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
            ) : null}
            {onArchiveCompany ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onArchiveCompany(company.id)}
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

function ContactMobileRow({
  contact,
  companyLabel,
  onSelectContact,
  onEditContact,
  onInviteContact,
  onArchiveContact,
}: {
  contact: Contact;
  companyLabel?: string;
  onSelectContact?: (id: string) => void;
  onEditContact?: (contact: Contact) => void;
  onInviteContact?: (contact: Contact) => void;
  onArchiveContact?: (contactId: string) => void;
}) {
  const metaParts = [
    contact.role,
    companyLabel,
    formatType(contact.contact_type),
  ].filter(Boolean) as string[];
  const hasActions = Boolean(onEditContact || onInviteContact || onArchiveContact);

  return (
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={() => onSelectContact?.(contact.id)}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60"
      >
        <Avatar className="h-10 w-10 rounded-none border">
          <AvatarFallback className="rounded-none text-xs font-semibold text-muted-foreground">
            {initialsFor(contact.full_name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {contact.full_name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {metaParts.length > 0 ? metaParts.join(" · ") : "No details"}
          </p>
          {contact.email || contact.phone ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {contact.phone ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Phone className="h-2.5 w-2.5" />
                  <span className="truncate">{contact.phone}</span>
                </span>
              ) : null}
              {contact.email ? (
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <Mail className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{contact.email}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </button>
      {hasActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-auto w-12 shrink-0 text-muted-foreground active:bg-muted/60"
              aria-label={`Actions for ${contact.full_name}`}
            >
              <MoreHorizontal className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEditContact ? (
              <DropdownMenuItem onSelect={() => onEditContact(contact)}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
            ) : null}
            {onInviteContact ? (
              <DropdownMenuItem
                disabled={!contact.email}
                onSelect={() => onInviteContact(contact)}
              >
                <Send className="mr-2 h-4 w-4" />
                Portal invite
              </DropdownMenuItem>
            ) : null}
            {onArchiveContact ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onArchiveContact(contact.id)}
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

function CompanyRow({
  item,
  contacts,
  view,
  complianceStatus,
  onSelectCompany,
  onEditCompany,
  onArchiveCompany,
}: {
  item: Extract<DirectoryItem, { type: "company" }>;
  contacts: Contact[];
  view: DirectoryView;
  complianceStatus?: ComplianceStatusSummary;
  onSelectCompany?: (id: string) => void;
  onEditCompany?: (company: Company) => void;
  onArchiveCompany?: (companyId: string) => void;
}) {
  const company = item.company;
  const contactCount = company.contact_count ?? contacts.length;
  const openCompany = () => onSelectCompany?.(company.id);

  return (
    <TableRow
      className="group cursor-pointer align-middle hover:bg-muted/30"
      onClick={openCompany}
    >
      <TableCell className="pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center border bg-muted/40">
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {company.name}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{company.trade || "No trade"}</span>
              <span>·</span>
              <span>
                {contactCount} contact{contactCount === 1 ? "" : "s"}
              </span>
              {complianceStatus && !complianceStatus.is_compliant ? (
                <>
                  <span>·</span>
                  <ComplianceFlag status={complianceStatus} />
                </>
              ) : null}
            </div>
          </div>
        </div>
      </TableCell>
      {view === "companies" ? (
        <>
          <TableCell>
            <Badge variant="outline">{formatType(company.company_type)}</Badge>
          </TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {company.trade || "—"}
          </TableCell>
          <TableCell>
            <ContactMethods email={company.email} phone={company.phone} />
          </TableCell>
        </>
      ) : (
        <>
          <TableCell>
            <Badge variant="outline">Company</Badge>
          </TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {company.trade || formatType(company.company_type)}
          </TableCell>
          <TableCell>
            <ContactMethods email={company.email} phone={company.phone} />
          </TableCell>
        </>
      )}
      <TableCell
        className="pr-4 text-right"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Company actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEditCompany ? (
              <DropdownMenuItem onSelect={() => onEditCompany(company)}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
            ) : null}
            {onArchiveCompany ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onArchiveCompany(company.id)}
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function ContactRow({
  item,
  companyLabel,
  view,
  onSelectContact,
  onEditContact,
  onInviteContact,
  onArchiveContact,
}: {
  item: Extract<DirectoryItem, { type: "contact" }>;
  companyLabel?: string;
  view: DirectoryView;
  onSelectContact?: (id: string) => void;
  onEditContact?: (contact: Contact) => void;
  onInviteContact?: (contact: Contact) => void;
  onArchiveContact?: (contactId: string) => void;
}) {
  const contact = item.contact;
  const openContact = () => onSelectContact?.(contact.id);

  return (
    <TableRow
      className="group cursor-pointer align-middle hover:bg-muted/30"
      onClick={openContact}
    >
      <TableCell className="pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="h-9 w-9 rounded-none border">
            <AvatarFallback className="rounded-none text-xs font-semibold text-muted-foreground">
              {initialsFor(contact.full_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {contact.full_name}
            </div>
            {companyLabel ? (
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {companyLabel}
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>
      {view === "people" ? (
        <>
          <TableCell className="text-sm text-muted-foreground">
            {companyLabel ?? "—"}
          </TableCell>
          <TableCell>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">
                {formatType(contact.contact_type)}
              </Badge>
              {contact.role ? (
                <Badge variant="secondary">{contact.role}</Badge>
              ) : null}
            </div>
          </TableCell>
          <TableCell>
            <ContactMethods email={contact.email} phone={contact.phone} />
          </TableCell>
        </>
      ) : (
        <>
          <TableCell>
            <Badge variant="outline">Person</Badge>
          </TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {contact.role || formatType(contact.contact_type)}
          </TableCell>
          <TableCell>
            <ContactMethods email={contact.email} phone={contact.phone} />
          </TableCell>
        </>
      )}
      <TableCell
        className="pr-4 text-right"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Contact actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEditContact ? (
              <DropdownMenuItem onSelect={() => onEditContact(contact)}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
            ) : null}
            {onInviteContact ? (
              <DropdownMenuItem
                disabled={!contact.email}
                onSelect={() => onInviteContact(contact)}
              >
                <Send className="mr-2 h-4 w-4" />
                Portal invite
              </DropdownMenuItem>
            ) : null}
            {onArchiveContact ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onArchiveContact(contact.id)}
              >
                <Archive className="mr-2 h-4 w-4" />
                Archive
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
