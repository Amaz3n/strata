"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { useRouter } from "next/navigation";

import {
  importDirectoryAction,
  type DirectoryImportMode,
  type DirectoryImportResult,
  type DirectoryImportRow,
} from "@/app/(app)/directory/actions";
import type { CompanyType, ContactType } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  User,
  Users,
  X,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

import { unwrapAction } from "@/lib/action-result"

interface ImportContactsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FieldKey = keyof DirectoryImportRow;
type FieldGroup = "company" | "contact";

interface FieldDef {
  key: FieldKey;
  label: string;
  group: FieldGroup;
  hints: string[];
}

const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  company_name: {
    key: "company_name",
    label: "Company name",
    group: "company",
    hints: ["company name", "company", "business", "vendor", "firm", "organization", "org"],
  },
  company_type: {
    key: "company_type",
    label: "Type",
    group: "company",
    hints: ["company type", "type", "kind"],
  },
  trade: {
    key: "trade",
    label: "Trade",
    group: "company",
    hints: ["trade", "specialty", "csi", "division"],
  },
  company_email: {
    key: "company_email",
    label: "Company email",
    group: "company",
    hints: ["company email", "business email", "office email", "work email"],
  },
  company_phone: {
    key: "company_phone",
    label: "Company phone",
    group: "company",
    hints: ["company phone", "business phone", "office phone", "main phone"],
  },
  website: {
    key: "website",
    label: "Website",
    group: "company",
    hints: ["website", "url", "web", "site"],
  },
  company_address: {
    key: "company_address",
    label: "Company address",
    group: "company",
    hints: ["company address", "business address", "address", "location", "street"],
  },
  full_name: {
    key: "full_name",
    label: "Full name",
    group: "contact",
    hints: ["full name", "contact name", "name", "contact", "person"],
  },
  contact_email: {
    key: "contact_email",
    label: "Email",
    group: "contact",
    hints: ["email", "e-mail", "mail"],
  },
  contact_phone: {
    key: "contact_phone",
    label: "Phone",
    group: "contact",
    hints: ["phone", "mobile", "cell", "telephone"],
  },
  role: {
    key: "role",
    label: "Role / Title",
    group: "contact",
    hints: ["role", "title", "position", "job"],
  },
  contact_type: {
    key: "contact_type",
    label: "Type",
    group: "contact",
    hints: ["contact type", "type", "kind"],
  },
  contact_address: {
    key: "contact_address",
    label: "Address",
    group: "contact",
    hints: ["address", "location", "street"],
  },
  notes: {
    key: "notes",
    label: "Notes",
    group: "contact",
    hints: ["notes", "note", "comment", "comments", "description"],
  },
};

// Which fields show (and in what order) per mode, plus the required "primary" key.
const MODE_CONFIG: Record<
  DirectoryImportMode,
  { fields: FieldKey[]; primary: FieldKey }
> = {
  contacts: {
    primary: "full_name",
    fields: [
      "full_name",
      "contact_email",
      "contact_phone",
      "role",
      "contact_type",
      "contact_address",
      "notes",
    ],
  },
  companies: {
    primary: "company_name",
    fields: [
      "company_name",
      "company_type",
      "trade",
      "company_email",
      "company_phone",
      "website",
      "company_address",
    ],
  },
  // Company columns are listed first so a bare "email"/"phone" header falls to
  // the person, while explicit "company email" lands on the business.
  both: {
    primary: "company_name",
    fields: [
      "company_name",
      "company_type",
      "trade",
      "company_email",
      "company_phone",
      "website",
      "full_name",
      "contact_email",
      "contact_phone",
      "role",
    ],
  },
};

const MODE_TABS: Array<{ key: DirectoryImportMode; label: string; hint: string }> = [
  { key: "contacts", label: "Contacts", hint: "People" },
  { key: "companies", label: "Companies", hint: "Businesses & vendors" },
  { key: "both", label: "Both", hint: "Company + its contact" },
];

const CONTACT_TYPE_OPTIONS: Array<{ value: ContactType; label: string }> = [
  { value: "subcontractor", label: "Subcontractor" },
  { value: "client", label: "Client" },
  { value: "vendor", label: "Vendor" },
  { value: "consultant", label: "Consultant" },
  { value: "internal", label: "Internal" },
];

const COMPANY_TYPE_OPTIONS: Array<{ value: CompanyType; label: string }> = [
  { value: "subcontractor", label: "Subcontractor" },
  { value: "supplier", label: "Supplier" },
  { value: "client", label: "Client" },
  { value: "architect", label: "Architect" },
  { value: "engineer", label: "Engineer" },
  { value: "other", label: "Other" },
];

const UNMAPPED = "__none__";
const SAMPLE_CSV: Record<DirectoryImportMode, string> = {
  contacts:
    "full_name,email,phone,role,type,address,notes\n" +
    "Jane Cooper,jane@acmeplumbing.com,(555) 123-4567,Owner,subcontractor,\"123 Main St, Austin TX\",Licensed master plumber\n" +
    "Marcus Lee,marcus@brightelectric.com,(555) 987-6543,Estimator,subcontractor,,Prefers email\n",
  companies:
    "company_name,type,trade,email,phone,website,address\n" +
    "Acme Plumbing,subcontractor,Plumbing,office@acmeplumbing.com,(555) 123-4567,acmeplumbing.com,\"123 Main St, Austin TX\"\n" +
    "Bright Supply Co,supplier,Electrical,sales@brightsupply.com,(555) 222-3333,brightsupply.com,\n",
  both:
    "company_name,type,trade,company_email,company_phone,website,full_name,email,phone,role\n" +
    "Acme Plumbing,subcontractor,Plumbing,office@acmeplumbing.com,(555) 123-4567,acmeplumbing.com,Jane Cooper,jane@acmeplumbing.com,(555) 123-9999,Owner\n" +
    "Bright Supply Co,supplier,Electrical,sales@brightsupply.com,(555) 222-3333,brightsupply.com,Marcus Lee,marcus@brightsupply.com,(555) 222-4444,Account Rep\n",
};

interface ParsedCsv {
  headers: string[];
  rows: string[][];
  fileName: string;
}

function parseCsv(text: string, fileName: string): ParsedCsv {
  const records: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(current.trim());
      current = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) records.push(row);
      row = [];
      current = "";
      continue;
    }
    current += char;
  }

  row.push(current.trim());
  if (row.some((cell) => cell.length > 0)) records.push(row);

  if (records.length === 0) return { headers: [], rows: [], fileName };
  const [headers, ...rows] = records;
  return { headers, rows, fileName };
}

// Mapping values are column indices (as strings) so empty/duplicate headers
// stay unambiguous and never produce an empty Select value (which Radix rejects).
function autoMap(headers: string[], fields: FieldKey[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<number>();
  for (const key of fields) {
    const def = FIELD_DEFS[key];
    const matchIndex = headers.findIndex((header, i) => {
      if (used.has(i)) return false;
      const normalized = header.trim().toLowerCase();
      return (
        def.hints.some((hint) => normalized === hint) ||
        def.hints.some((hint) => normalized.includes(hint))
      );
    });
    if (matchIndex >= 0) {
      map[key] = String(matchIndex);
      used.add(matchIndex);
    } else {
      map[key] = UNMAPPED;
    }
  }
  return map;
}

export function ImportContactsSheet({ open, onOpenChange }: ImportContactsSheetProps) {
  const router = useRouter();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<DirectoryImportMode>("contacts");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaultContactType, setDefaultContactType] =
    useState<ContactType>("subcontractor");
  const [defaultCompanyType, setDefaultCompanyType] =
    useState<CompanyType>("subcontractor");
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<DirectoryImportResult | null>(null);

  const config = MODE_CONFIG[mode];

  // Re-run column matching whenever the file or the mode changes.
  useEffect(() => {
    if (parsed) setMapping(autoMap(parsed.headers, config.fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, mode]);

  const reset = useCallback(() => {
    setParsed(null);
    setMapping({});
    setIsDragging(false);
    setIsImporting(false);
    setResult(null);
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      reset();
      setMode("contacts");
    }
    onOpenChange(next);
  };

  const ingestFile = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
        toast({
          title: "Unsupported file",
          description: "Please upload a .csv file.",
        });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? "");
        const next = parseCsv(text, file.name);
        if (next.headers.length === 0 || next.rows.length === 0) {
          toast({
            title: "Empty file",
            description: "We couldn't find any rows in that file.",
          });
          return;
        }
        setResult(null);
        setParsed(next);
      };
      reader.readAsText(file);
    },
    [toast],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) ingestFile(file);
  };

  const buildRows = useCallback((): DirectoryImportRow[] => {
    if (!parsed) return [];
    const idx: Partial<Record<FieldKey, number>> = {};
    for (const key of config.fields) {
      const value = mapping[key];
      idx[key] = value && value !== UNMAPPED ? Number(value) : -1;
    }
    return parsed.rows.map((cells) => {
      const row: DirectoryImportRow = {};
      for (const key of config.fields) {
        const i = idx[key] ?? -1;
        if (i >= 0) row[key] = (cells[i] ?? "").trim();
      }
      return row;
    });
  }, [parsed, mapping, config.fields]);

  const previewRows = useMemo(() => buildRows(), [buildRows]);
  const primaryMapped = (mapping[config.primary] ?? UNMAPPED) !== UNMAPPED;

  // A row is importable if it has the identifying value for the mode. In "both"
  // mode either a company or a contact is enough (the action handles either).
  const isRowReady = useCallback(
    (row: DirectoryImportRow) => {
      const has = (key: FieldKey) => ((row[key] as string) ?? "").trim().length > 0;
      if (mode === "both") return has("company_name") || has("full_name");
      return has(config.primary);
    },
    [mode, config.primary],
  );

  const validCount = useMemo(
    () => previewRows.filter(isRowReady).length,
    [previewRows, isRowReady],
  );

  const handleImport = async () => {
    if (!primaryMapped) {
      toast({
        title: `Map the ${FIELD_DEFS[config.primary].label.toLowerCase()} column`,
        description: "We need to know which column identifies each record.",
      });
      return;
    }
    setIsImporting(true);
    try {
      const res = unwrapAction(await importDirectoryAction({
        mode,
        rows: buildRows(),
        defaultContactType,
        defaultCompanyType,
      }));
      setResult(res);
      const made = res.contactsCreated + res.companiesCreated;
      if (made > 0) {
        toast({
          title: summarizeCreated(res),
          description:
            res.skipped > 0
              ? `${res.skipped} row${res.skipped === 1 ? "" : "s"} skipped.`
              : undefined,
        });
        router.refresh();
      } else {
        toast({
          title: res.skipped > 0 ? "No new records imported" : "Nothing imported",
          description:
            res.skipped > 0
              ? "Every ready row already matched an existing directory record."
              : "No valid rows were found to import.",
        });
      }
    } catch (error) {
      toast({
        title: "Import failed",
        description: (error as Error).message,
      });
    } finally {
      setIsImporting(false);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([SAMPLE_CSV[mode]], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${mode}-template.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const companyFields = config.fields.filter(
    (key) => FIELD_DEFS[key].group === "company",
  );
  const contactFields = config.fields.filter(
    (key) => FIELD_DEFS[key].group === "contact",
  );

  const renderFieldSelect = (key: FieldKey) => {
    const def = FIELD_DEFS[key];
    const isPrimary = key === config.primary;
    return (
      <div key={key} className="space-y-1.5">
        <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {def.label}
          {isPrimary ? <span className="text-destructive">*</span> : null}
        </Label>
        <Select
          value={mapping[key] ?? UNMAPPED}
          onValueChange={(value) =>
            setMapping((prev) => ({ ...prev, [key]: value }))
          }
        >
          <SelectTrigger
            className={cn(
              "h-9",
              isPrimary &&
                (mapping[key] ?? UNMAPPED) === UNMAPPED &&
                "border-destructive/60",
            )}
          >
            <SelectValue placeholder="Select column" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNMAPPED}>
              <span className="text-muted-foreground">Don&apos;t import</span>
            </SelectItem>
            {parsed?.headers.map((header, i) => (
              <SelectItem key={i} value={String(i)}>
                {header || `Column ${i + 1}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  const previewColumns = PREVIEW_COLUMNS[mode];

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={
          {
            animationDuration: "150ms",
            transitionDuration: "150ms",
          } as CSSProperties
        }
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            Import from CSV
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Bulk-add records from a spreadsheet. We&apos;ll match the columns for you.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {/* Result screen */}
          {result ? (
            <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
              <div
                className={cn(
                  "flex h-14 w-14 items-center justify-center rounded-full",
                  result.contactsCreated + result.companiesCreated > 0
                    ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15"
                    : "bg-amber-100 text-amber-600 dark:bg-amber-500/15",
                )}
              >
                {result.contactsCreated + result.companiesCreated > 0 ? (
                  <CheckCircle2 className="h-7 w-7" />
                ) : (
                  <AlertCircle className="h-7 w-7" />
                )}
              </div>
              <div>
                <p className="text-lg font-semibold">{summarizeCreated(result)}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {result.total} row{result.total === 1 ? "" : "s"} processed
                  {result.skipped > 0 ? ` · ${result.skipped} skipped` : ""}
                </p>
              </div>

              {result.errors.length > 0 ? (
                <div className="w-full max-w-md rounded-lg border bg-muted/30 p-3 text-left">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Skipped rows
                  </p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {result.errors.slice(0, 6).map((err) => (
                      <li key={err.row} className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-muted-foreground/70">
                          Row {err.row}
                        </span>
                        <span>{err.reason}</span>
                      </li>
                    ))}
                    {result.errors.length > 6 ? (
                      <li className="text-muted-foreground/70">
                        + {result.errors.length - 6} more
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}>
                  Import another file
                </Button>
                <Button onClick={() => handleOpenChange(false)}>Done</Button>
              </div>
            </div>
          ) : !parsed ? (
            /* Upload screen */
            <div className="space-y-5">
              {/* Mode picker */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">What are you importing?</Label>
                <div className="grid grid-cols-3 gap-2">
                  {MODE_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setMode(tab.key)}
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        mode === tab.key
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/40 hover:bg-muted/30",
                      )}
                    >
                      <span className="text-sm font-medium">{tab.label}</span>
                      <span className="text-[11px] leading-tight text-muted-foreground">
                        {tab.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50 hover:bg-muted/30",
                )}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FileSpreadsheet className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-medium">
                    Drop your CSV here, or click to browse
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Up to a few thousand rows. .csv files only.
                  </p>
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) ingestFile(file);
                  event.target.value = "";
                }}
              />

              <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-4 py-3">
                <div className="flex items-center gap-3">
                  <Download className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Need a starting point?</p>
                    <p className="text-xs text-muted-foreground">
                      Download a {mode} template with the expected columns.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={downloadTemplate}>
                  Template
                </Button>
              </div>
            </div>
          ) : (
            /* Mapping + preview screen */
            <div className="space-y-5">
              {/* File summary */}
              <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <FileSpreadsheet className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{parsed.fileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} ·{" "}
                      {parsed.headers.length} columns ·{" "}
                      {MODE_TABS.find((t) => t.key === mode)?.label}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={reset}
                  aria-label="Remove file"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Mode switch (compact) */}
              <div className="flex w-full overflow-hidden rounded-lg border bg-muted/20 p-0.5">
                {MODE_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setMode(tab.key)}
                    className={cn(
                      "flex h-8 flex-1 items-center justify-center px-2 text-xs font-medium transition-colors",
                      mode === tab.key
                        ? "bg-primary text-primary-foreground shadow-sm rounded-md"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Column mapping */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Match columns</Label>
                  <Badge variant={primaryMapped ? "secondary" : "destructive"}>
                    {validCount} ready
                  </Badge>
                </div>

                {mode === "both" ? (
                  <>
                    <FieldGroupBlock
                      icon={<Building2 className="h-3.5 w-3.5" />}
                      title="Company"
                    >
                      {companyFields.map(renderFieldSelect)}
                    </FieldGroupBlock>
                    <FieldGroupBlock
                      icon={<User className="h-3.5 w-3.5" />}
                      title="Primary contact"
                      subtitle="Linked to the company. Leave blank for company-only rows."
                    >
                      {contactFields.map(renderFieldSelect)}
                    </FieldGroupBlock>
                  </>
                ) : (
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {config.fields.map(renderFieldSelect)}
                  </div>
                )}
              </div>

              {/* Default type fallback */}
              <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    Default {mode === "contacts" ? "contact" : "company"} type
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Used when a row has no type column.
                  </p>
                </div>
                {mode === "contacts" ? (
                  <Select
                    value={defaultContactType}
                    onValueChange={(value) =>
                      setDefaultContactType(value as ContactType)
                    }
                  >
                    <SelectTrigger className="h-9 w-44 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTACT_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={defaultCompanyType}
                    onValueChange={(value) =>
                      setDefaultCompanyType(value as CompanyType)
                    }
                  >
                    <SelectTrigger className="h-9 w-44 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMPANY_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Preview */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Preview</Label>
                <div className="overflow-hidden rounded-lg border">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr>
                          {previewColumns.map((col) => (
                            <th key={col.key} className="px-3 py-2 font-medium">
                              {col.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {previewRows.slice(0, 6).map((row, i) => {
                          const invalid = !isRowReady(row);
                          return (
                            <tr key={i} className={cn(invalid && "bg-destructive/5")}>
                              {previewColumns.map((col, ci) => {
                                const value = (row[col.key] as string) ?? "";
                                const isPrimaryCol = col.key === config.primary;
                                return (
                                  <td key={col.key} className="px-3 py-2">
                                    {ci === 0 && invalid ? (
                                      <span className="inline-flex items-center gap-1 text-xs text-destructive">
                                        <AlertCircle className="h-3 w-3" /> Missing
                                      </span>
                                    ) : value ? (
                                      <span
                                        className={cn(
                                          isPrimaryCol
                                            ? "font-medium"
                                            : "text-muted-foreground",
                                        )}
                                      >
                                        {value}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {previewRows.length > 6 ? (
                    <div className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      + {previewRows.length - 6} more row
                      {previewRows.length - 6 === 1 ? "" : "s"}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {parsed && !result ? (
          <div className="flex items-center justify-between gap-3 border-t bg-background px-6 py-4">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>
                <span className="font-medium text-foreground">{validCount}</span> of{" "}
                {previewRows.length} ready
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={reset} disabled={isImporting}>
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                disabled={isImporting || validCount === 0 || !primaryMapped}
              >
                {isImporting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing…
                  </>
                ) : (
                  <>Import {validCount}</>
                )}
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

const PREVIEW_COLUMNS: Record<
  DirectoryImportMode,
  Array<{ key: FieldKey; label: string }>
> = {
  contacts: [
    { key: "full_name", label: "Name" },
    { key: "contact_email", label: "Email" },
    { key: "contact_phone", label: "Phone" },
    { key: "role", label: "Role" },
  ],
  companies: [
    { key: "company_name", label: "Company" },
    { key: "company_type", label: "Type" },
    { key: "trade", label: "Trade" },
    { key: "company_email", label: "Email" },
  ],
  both: [
    { key: "company_name", label: "Company" },
    { key: "full_name", label: "Contact" },
    { key: "contact_email", label: "Email" },
    { key: "contact_phone", label: "Phone" },
  ],
};

function summarizeCreated(result: DirectoryImportResult): string {
  const parts: string[] = [];
  if (result.companiesCreated > 0) {
    parts.push(
      `${result.companiesCreated} compan${result.companiesCreated === 1 ? "y" : "ies"}`,
    );
  }
  if (result.contactsCreated > 0) {
    parts.push(
      `${result.contactsCreated} contact${result.contactsCreated === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return "No records imported";
  return `Imported ${parts.join(" and ")}`;
}

function FieldGroupBlock({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-muted/10 p-3">
      <div className="mb-2.5 flex items-center gap-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="text-xs font-semibold">{title}</span>
        {subtitle ? (
          <span className="ml-1 truncate text-[11px] text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">{children}</div>
    </div>
  );
}
