"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { archiveCompanyAction } from "@/app/(app)/companies/actions";
import { archiveContactAction } from "@/app/(app)/contacts/actions";
import { listDirectoryPageAction } from "@/app/(app)/directory/actions";
import type { Company, Contact } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CompanyForm } from "@/components/companies/company-form";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet";
import { ImportContactsSheet } from "@/components/directory/import-contacts-sheet";
import {
  DirectoryTable,
  type DirectorySortDirection,
  type DirectorySortKey,
  type DirectoryView,
} from "@/components/directory/directory-table";
import {
  Building2,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
  User,
  X,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface DirectoryClientProps {
  companies: Company[];
  contacts: Contact[];
  canCreate: boolean;
  canDelete?: boolean;
  view: DirectoryView;
  search: string;
  typeFilter: string;
  tradeFilter: string;
  sort: DirectorySortKey;
  direction: DirectorySortDirection;
  page: number;
  pageSize: number;
  total: number;
  trades: string[];
}

export function DirectoryClient({
  companies: initialCompanies,
  contacts: initialContacts,
  canCreate,
  canDelete = false,
  view,
  search,
  typeFilter,
  tradeFilter,
  sort,
  direction,
  page: _initialPage,
  pageSize,
  total: initialTotal,
  trades,
}: DirectoryClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [companies, setCompanies] = useState<Company[]>(initialCompanies);
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [loadedPage, setLoadedPage] = useState(1);
  const [total, setTotal] = useState(initialTotal);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const filterKey = `${view}|${search}|${typeFilter}|${tradeFilter}|${sort}|${direction}`;
  const lastFilterKey = useRef(filterKey);
  const generation = useRef(0);
  useEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      generation.current += 1;
      setCompanies(initialCompanies);
      setContacts(initialContacts);
      setLoadedPage(1);
      setTotal(initialTotal);
      setIsLoadingMore(false);
    } else {
      // Same filter key but server props refreshed (router.refresh, navigation back) — sync first page.
      setCompanies((prev) =>
        prev.length === 0 || loadedPage === 1 ? initialCompanies : prev,
      );
      setContacts((prev) =>
        prev.length === 0 || loadedPage === 1 ? initialContacts : prev,
      );
      setTotal(initialTotal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, initialCompanies, initialContacts, initialTotal]);

  const loadedCount = companies.length + contacts.length;
  const hasMore = loadedCount < total;

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    const fetchGeneration = generation.current;
    try {
      const next = loadedPage + 1;
      const result = await listDirectoryPageAction({
        view,
        page: next,
        pageSize,
        search,
        type: typeFilter,
        trade: tradeFilter,
        sort,
        direction,
      });
      if (fetchGeneration !== generation.current) return;
      setCompanies((prev) => [...prev, ...result.companies]);
      setContacts((prev) => [...prev, ...result.contacts]);
      setTotal(result.total);
      setLoadedPage(next);
    } catch (error) {
      if (fetchGeneration !== generation.current) return;
      toast({
        title: "Couldn't load more",
        description: (error as Error).message,
      });
    } finally {
      if (fetchGeneration === generation.current) setIsLoadingMore(false);
    }
  }, [
    hasMore,
    isLoadingMore,
    loadedPage,
    pageSize,
    view,
    search,
    typeFilter,
    tradeFilter,
    sort,
    direction,
    toast,
  ]);

  const [searchTerm, setSearchTerm] = useState(search);
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<Company | undefined>();
  const [selectedContact, setSelectedContact] = useState<Contact | undefined>();
  const [newContactCompanyId, setNewContactCompanyId] = useState<
    string | undefined
  >();
  const [detailContactId, setDetailContactId] = useState<string | undefined>();
  const [detailContactOpen, setDetailContactOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const typeOptions = useMemo(() => {
    if (view === "companies") {
      return [
        ["subcontractor", "Subcontractors"],
        ["supplier", "Suppliers"],
        ["client", "Clients"],
        ["architect", "Architects"],
        ["engineer", "Engineers"],
        ["other", "Other companies"],
      ];
    }
    if (view === "people") {
      return [
        ["internal", "Internal"],
        ["subcontractor", "Subcontractors"],
        ["client", "Clients"],
        ["vendor", "Vendors"],
        ["consultant", "Consultants"],
      ];
    }
    return [
      ["subcontractor", "Subcontractors"],
      ["supplier", "Suppliers"],
      ["client", "Clients"],
      ["architect", "Architects"],
      ["engineer", "Engineers"],
      ["consultant", "Consultants"],
      ["vendor", "Vendors"],
      ["internal", "Internal"],
      ["other", "Other"],
    ];
  }, [view]);

  const activeFilterCount = [
    typeFilter !== "all",
    tradeFilter !== "all",
  ].filter(Boolean).length;

  const updateParams = (
    updates: Record<string, string | number | undefined>,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (
        value === undefined ||
        value === "" ||
        value === "all" ||
        (key === "page" && Number(value) <= 1)
      ) {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    }
    params.delete("status");
    const suffix = params.toString();
    router.replace(suffix ? `/directory?${suffix}` : "/directory");
  };

  const openCompanyDetail = (id: string) => {
    router.push(`/companies/${id}`);
  };

  const openContactDetail = (id: string) => {
    setDetailContactId(id);
    setDetailContactOpen(true);
  };

  const openEditCompany = (company: Company) => {
    setSelectedCompany(company);
    setCompanyDialogOpen(true);
  };

  const openEditContact = (contact: Contact) => {
    setNewContactCompanyId(undefined);
    setSelectedContact(contact);
    setDetailContactOpen(false);
    setContactDialogOpen(true);
  };

  const setDirectoryView = (nextView: DirectoryView) => {
    updateParams({
      view: nextView,
      type: undefined,
      trade: undefined,
      page: undefined,
    });
  };

  const resetFilters = () => {
    updateParams({
      type: undefined,
      trade: undefined,
      page: undefined,
    });
  };

  const submitSearch = () => {
    updateParams({ q: searchTerm.trim() || undefined, page: undefined });
  };

  const openNewCompany = () => {
    setSelectedCompany(undefined);
    setCompanyDialogOpen(true);
  };

  const openNewContact = (companyId?: string) => {
    setNewContactCompanyId(companyId);
    setSelectedContact(undefined);
    setContactDialogOpen(true);
  };

  const archiveCompany = (companyId: string) => {
    startTransition(async () => {
      try {
        await archiveCompanyAction(companyId);
        setCompanies((prev) => prev.filter((c) => c.id !== companyId));
        setTotal((prev) => Math.max(0, prev - 1));
        toast({ title: "Company deleted" });
      } catch (error) {
        toast({
          title: "Unable to delete company",
          description: (error as Error).message,
        });
      }
    });
  };

  const archiveContact = (contactId: string) => {
    startTransition(async () => {
      try {
        await archiveContactAction(contactId);
        setContacts((prev) => prev.filter((c) => c.id !== contactId));
        setTotal((prev) => Math.max(0, prev - 1));
        toast({ title: "Contact deleted" });
      } catch (error) {
        toast({
          title: "Unable to delete contact",
          description: (error as Error).message,
        });
      }
    });
  };

  const contactFormKey = selectedContact?.id
    ? `edit-${selectedContact.id}`
    : `new-${newContactCompanyId ?? "none"}-${contactDialogOpen ? "open" : "closed"}`;

  const viewTabs: Array<{ key: DirectoryView; label: string }> = [
    { key: "all", label: "All" },
    { key: "companies", label: "Companies" },
    { key: "people", label: "People" },
  ];

  const filtersMenu = (
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuLabel>Type</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={typeFilter}
        onValueChange={(value) =>
          updateParams({ type: value, page: undefined })
        }
      >
        <DropdownMenuRadioItem value="all">All types</DropdownMenuRadioItem>
        {typeOptions.map(([value, label]) => (
          <DropdownMenuRadioItem key={value} value={value}>
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Trade</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={tradeFilter}
        onValueChange={(value) =>
          updateParams({ trade: value, page: undefined })
        }
      >
        <DropdownMenuRadioItem value="all">All trades</DropdownMenuRadioItem>
        {trades.map((trade) => (
          <DropdownMenuRadioItem key={trade} value={trade}>
            {trade}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>

      {activeFilterCount > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={resetFilters}>
            <X className="mr-2 h-4 w-4" />
            Clear filters
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  );

  const addMenu = canCreate ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="default" className="h-10 w-10 shrink-0">
          <Plus className="h-4 w-4" />
          <span className="sr-only">Add</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openNewCompany()}>
          <Building2 className="mr-2 h-4 w-4" />
          Add company
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openNewContact()}>
          <User className="mr-2 h-4 w-4" />
          Add contact
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setImportOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />
          Import from CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const typeLabelMap = new Map<string, string>(
    typeOptions.map(([value, label]) => [value, label]),
  );
  const activeChips: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (typeFilter !== "all") {
    activeChips.push({
      key: "type",
      label: typeLabelMap.get(typeFilter) ?? typeFilter,
      onClear: () => updateParams({ type: undefined, page: undefined }),
    });
  }
  if (tradeFilter !== "all") {
    activeChips.push({
      key: "trade",
      label: tradeFilter,
      onClear: () => updateParams({ trade: undefined, page: undefined }),
    });
  }

  return (
    <div className="flex min-h-full flex-col bg-background">
      {/* Mobile header */}
      <div className="shrink-0 border-y bg-background md:hidden">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
              onBlur={submitSearch}
              placeholder="Search directory..."
              className="h-10 pl-8 text-sm"
              inputMode="search"
            />
            {searchTerm ? (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm("");
                  updateParams({ q: undefined, page: undefined });
                }}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground active:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="relative h-10 w-10 shrink-0"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="sr-only">Filters</span>
                {activeFilterCount > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            {filtersMenu}
          </DropdownMenu>
          {addMenu}
        </div>

        {/* View tabs (segmented) */}
        <div className="px-3 pt-2.5">
          <div className="flex w-full border bg-muted/20 p-0.5">
            {viewTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setDirectoryView(tab.key)}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center px-3 text-xs font-medium transition-colors",
                  view === tab.key
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground active:bg-muted",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Active filter chips */}
        {activeChips.length > 0 ? (
          <div className="-mx-px flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary"
              >
                {chip.label}
                <X className="h-3 w-3" />
              </button>
            ))}
            <button
              type="button"
              onClick={resetFilters}
              className="shrink-0 px-2 py-1.5 text-xs font-medium text-muted-foreground active:text-foreground"
            >
              Clear all
            </button>
          </div>
        ) : (
          <div className="h-3" />
        )}
      </div>

      {/* Desktop header */}
      <div className="hidden shrink-0 border-y bg-background px-4 py-3 md:block">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1">
            <div className="flex w-full overflow-x-auto border bg-muted/20 p-1 sm:w-auto">
              {viewTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setDirectoryView(tab.key)}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-medium transition-colors",
                    view === tab.key
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
            <div className="relative w-full sm:w-96">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
                onBlur={submitSearch}
                placeholder="Search name, trade, company, email, phone..."
                className="h-10 pl-8"
              />
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="relative h-10 w-10">
                  <SlidersHorizontal className="h-4 w-4" />
                  <span className="sr-only">Filters</span>
                  {activeFilterCount > 0 ? (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              {filtersMenu}
            </DropdownMenu>

            {addMenu}
          </div>
        </div>
      </div>

      <DirectoryTable
        companies={companies}
        contacts={contacts}
        view={view}
        sort={sort}
        direction={direction}
        total={total}
        loadedCount={loadedCount}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={loadMore}
        onSortChange={(nextSort) => {
          const nextDirection =
            sort === nextSort && direction === "asc" ? "desc" : "asc";
          updateParams({
            sort: nextSort,
            direction: nextDirection,
            page: undefined,
          });
        }}
        onSelectCompany={openCompanyDetail}
        onSelectContact={openContactDetail}
        onEditCompany={canCreate ? openEditCompany : undefined}
        onEditContact={canCreate ? openEditContact : undefined}
        onArchiveCompany={canDelete && !isPending ? archiveCompany : undefined}
        onArchiveContact={canDelete && !isPending ? archiveContact : undefined}
      />

      <Sheet
        open={companyDialogOpen}
        onOpenChange={(open) => {
          setCompanyDialogOpen(open);
          if (!open) setSelectedCompany(undefined);
        }}
      >
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={
            {
              animationDuration: "150ms",
              transitionDuration: "150ms",
            } as CSSProperties
          }
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              {selectedCompany ? "Edit company" : "Create company"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Capture company details, trade, and insurance info.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <CompanyForm
              company={selectedCompany}
              onSubmitted={() => setCompanyDialogOpen(false)}
              onCancel={() => setCompanyDialogOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={contactDialogOpen}
        onOpenChange={(open) => {
          setContactDialogOpen(open);
          if (!open) {
            setSelectedContact(undefined);
            setNewContactCompanyId(undefined);
          }
        }}
      >
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={
            {
              animationDuration: "150ms",
              transitionDuration: "150ms",
            } as CSSProperties
          }
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              {selectedContact ? "Edit contact" : "Create contact"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Add a person and optionally link them to a company.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <ContactForm
              key={contactFormKey}
              contact={selectedContact}
              companies={companies}
              defaultPrimaryCompanyId={newContactCompanyId}
              onSubmitted={() => setContactDialogOpen(false)}
              onCancel={() => setContactDialogOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ContactDetailSheet
        contactId={detailContactId}
        open={detailContactOpen}
        onOpenChange={setDetailContactOpen}
        onEditContact={openEditContact}
      />

      {canCreate ? (
        <ImportContactsSheet open={importOpen} onOpenChange={setImportOpen} />
      ) : null}
    </div>
  );
}
