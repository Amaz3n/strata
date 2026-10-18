"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DocumentEditorLayout,
  DocumentEditorFields,
} from "@/components/document-editor/document-editor-layout";
import {
  EstimateLivePreview,
  type EstimatePreviewBranding,
} from "./estimate-live-preview";
import { format } from "date-fns";
import {
  draftMoneyLine,
  estimateDraftTotals,
} from "@/lib/financials/estimate-draft";
import { estimateLineAmountCents } from "@/lib/financials/estimate-totals";

import type { Contact, CostCode } from "@/lib/types";
import {
  estimateInputSchema,
  estimateCommercialSchema,
  type EstimateInput,
} from "@/lib/validation/estimates";
import { z } from "zod";
import {
  useEstimateDraftAutosave,
  type SavedEstimateDraft,
} from "@/lib/hooks/use-estimate-draft-autosave";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CalendarDays,
  Trash2,
  Plus,
  LayoutGrid,
  ImageIcon,
  X,
  GripVertical,
  Loader2,
} from "@/components/icons";
import { TakeoffLineBadge } from "@/components/takeoff/takeoff-line-badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { uploadEstimatePhotoAction } from "@/app/(app)/estimates/actions";
import { listProspectBidQuotesAction } from "@/app/(app)/bids/actions";
import type { ProspectBidQuote } from "@/lib/services/bids";
import type { PricingDisplayMode } from "@/lib/validation/estimates";

import { EstimateCommercialFields } from "@/components/estimates/estimate-commercial-fields";
import {
  DEFAULT_ESTIMATE_COMMERCIAL,
  type EstimateCommercial,
} from "@/lib/financials/estimate-commercial";

import { unwrapAction } from "@/lib/action-result";

type LineDraft = {
  editorId: string;
  item_type: "line" | "group";
  description: string;
  quantity: number | string;
  unit?: string;
  unit_cost: number | string;
  /** Percent over cost for this line. "" = use the estimate's default markup. */
  markup_pct: number | string;
  cost_code_id: string | undefined;
  is_optional: boolean;
  is_allowance: boolean;
  /** Optionals sharing a group label are pick-one alternates in the portal. */
  option_group: string;
  source_bid_submission_id?: string;
  /**
   * Provenance from other surfaces (today: `takeoff`). Carried verbatim so
   * editing an estimate never severs a synced line from the measurement it
   * came from — a severed line would resync as a duplicate.
   */
  metadata?: Record<string, any>;
};

type PhotoDraft = { path: string; url: string; caption: string };

const estimateRecoverySchema = z.object({
  recipientId: z.string(),
  prospectChoice: z.object({ name: z.string(), email: z.string().nullable() }),
  projectId: z.string(),
  title: z.string(),
  scope: z.string(),
  precon: estimateCommercialSchema,
  terms: z.string(),
  intro: z.string(),
  pricingDisplay: z.enum(["itemized", "subtotals", "lump_sum"]),
  photos: z.array(
    z.object({ path: z.string(), url: z.string(), caption: z.string() }),
  ),
  validUntil: z.string().datetime().optional(),
  lines: z
    .array(
      z.object({
        editorId: z.string(),
        item_type: z.enum(["line", "group"]),
        description: z.string(),
        quantity: z.union([z.number(), z.string()]),
        unit: z.string().optional(),
        unit_cost: z.union([z.number(), z.string()]),
        markup_pct: z.union([z.number(), z.string()]),
        cost_code_id: z.string().optional(),
        is_optional: z.boolean(),
        is_allowance: z.boolean(),
        option_group: z.string(),
        source_bid_submission_id: z.string().optional(),
        metadata: z.record(z.any()).optional(),
      }),
    )
    .min(1),
  defaultMarkupPct: z.union([z.number(), z.string()]),
  contingencyPct: z.union([z.number(), z.string()]),
  taxRate: z.number(),
  inclusions: z.string(),
  exclusions: z.string(),
});

const NEW_LINE: LineDraft = {
  editorId: "",
  item_type: "line",
  description: "",
  quantity: 1,
  unit_cost: "",
  markup_pct: "",
  cost_code_id: undefined,
  is_optional: false,
  is_allowance: false,
  option_group: "",
};
const newLine = (): LineDraft => ({
  ...NEW_LINE,
  editorId: crypto.randomUUID(),
});
const newSection = (): LineDraft => ({
  editorId: crypto.randomUUID(),
  item_type: "group",
  description: "",
  quantity: 1,
  unit_cost: "",
  markup_pct: "",
  cost_code_id: undefined,
  is_optional: false,
  is_allowance: false,
  option_group: "",
});

export type EstimateTemplateOption = {
  id: string;
  name: string;
  description?: string | null;
  lines: Array<{
    item_type?: "line" | "group" | null;
    description?: string | null;
    quantity?: number | null;
    unit_cost_cents?: number | null;
    cost_code_id?: string | null;
    is_optional?: boolean | null;
    is_allowance?: boolean | null;
    metadata?: Record<string, any> | null;
  }>;
};

const PRICING_DISPLAY_OPTIONS: Array<{
  value: PricingDisplayMode;
  label: string;
  hint: string;
}> = [
  {
    value: "itemized",
    label: "Itemized",
    hint: "Show quantity, unit cost, and amount per line",
  },
  {
    value: "subtotals",
    label: "Amounts only",
    hint: "Hide unit costs — show line amounts and total",
  },
  {
    value: "lump_sum",
    label: "Lump sum",
    hint: "Hide all line pricing — show only the total",
  },
];

export type EstimateSheetInitial = {
  id?: string;
  status?: string;
  updated_at?: string;
  source_budget_estimate_id?: string;
  precon?: EstimateCommercial;
  title?: string | null;
  summary?: string | null;
  terms?: string | null;
  intro?: string | null;
  pricing_display?: PricingDisplayMode | null;
  valid_until?: string | null;
  version?: number | null;
  recipient_contact_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
  tax_rate?: number | null;
  markup_percent?: number | null;
  contingency_percent?: number | null;
  inclusions?: string | null;
  exclusions?: string | null;
  photos?: Array<{
    path: string;
    url?: string | null;
    caption?: string | null;
  }>;
  lines?: Array<{
    id?: string;
    source_bid_submission_id?: string | null;
    item_type?: "line" | "group" | null;
    description?: string | null;
    quantity?: number | null;
    unit?: string | null;
    unit_cost_cents?: number | null;
    markup_pct?: number | null;
    cost_code_id?: string | null;
    is_optional?: boolean | null;
    is_allowance?: boolean | null;
    option_group?: string | null;
    metadata?: Record<string, any> | null;
  }>;
};

interface EstimateEditorProps {
  branding?: EstimatePreviewBranding;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: Contact[];
  costCodes: CostCode[];
  defaultTerms?: string;
  defaultIntro?: string;
  templates?: EstimateTemplateOption[];
  defaultRecipientId?: string;
  defaultProjectId?: string;
  defaultProspectId?: string;
  /**
   * When creating from a prospect, the recipient is the prospect's primary contact
   * (which is not in the Directory yet). Defaults the Client picker to this person.
   */
  prospectRecipient?: { name: string; email?: string | null };
  /** Other contacts on the prospect, selectable as the estimate recipient. */
  prospectContacts?: Array<{ name: string; email?: string | null }>;
  onCreate: (
    input: EstimateInput,
    savedDraft?: SavedEstimateDraft,
  ) => Promise<void> | void;
  onAutosave?: (
    input: EstimateInput,
    savedDraft?: SavedEstimateDraft,
  ) => Promise<SavedEstimateDraft>;
  recoveryKey?: string;
  loading?: boolean;
  /**
   * "revise" seeds the form from {@link initialEstimate} and saves a new version.
   * Mount the sheet with a `key` (e.g. the estimate id) so the seeded state is fresh.
   */
  mode?: "create" | "revise";
  initialEstimate?: EstimateSheetInitial;
  /** Client's requested changes, shown as a reference panel while revising. */
  requestedChanges?: string | null;
}

function centsToInput(cents?: number | null): number | string {
  if (cents === null || cents === undefined) return "";
  return cents / 100;
}

function parseLocalDate(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const money = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD" });

const noSpinner =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0";

function SortableEstimateLine({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative", isDragging && "z-20 bg-background shadow-md")}
    >
      {children(
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${label}`}
          className="flex h-9 w-6 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>,
      )}
    </div>
  );
}

export function EstimateEditor({
  branding,
  open,
  onOpenChange,
  contacts,
  costCodes,
  defaultTerms,
  defaultIntro,
  templates,
  defaultRecipientId,
  defaultProjectId,
  defaultProspectId,
  prospectRecipient,
  onCreate,
  onAutosave,
  recoveryKey,
  loading,
  mode = "create",
  initialEstimate,
  requestedChanges,
}: EstimateEditorProps) {
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const focusLine = useRef<number | null>(null);
  const isRevise = mode === "revise";
  const seededLines: LineDraft[] =
    initialEstimate?.lines && initialEstimate.lines.length > 0
      ? initialEstimate.lines.map((line, index) => ({
          editorId:
            typeof line.metadata?.editor_line_id === "string"
              ? line.metadata.editor_line_id
              : (line.id ?? `initial-${index}`),
          item_type:
            line.item_type === "group" ? ("group" as const) : ("line" as const),
          description: line.description ?? "",
          quantity: line.quantity ?? 1,
          unit: line.unit ?? undefined,
          unit_cost: centsToInput(line.unit_cost_cents),
          markup_pct: line.markup_pct ?? "",
          source_bid_submission_id:
            line.source_bid_submission_id ??
            line.metadata?.source_bid_submission_id,
          cost_code_id: line.cost_code_id ?? undefined,
          is_optional: line.is_optional ?? false,
          is_allowance: line.is_allowance ?? false,
          option_group: line.option_group ?? "",
          metadata: line.metadata ?? undefined,
        }))
      : [newLine()];

  const [recipientId, setRecipientId] = useState<string>(
    initialEstimate?.recipient_contact_id ?? defaultRecipientId ?? "",
  );
  // Prospect mode: recipient is an ad-hoc name/email (not a Directory contact).
  const [prospectChoice, setProspectChoice] = useState<{
    name: string;
    email: string | null;
  }>(() => {
    if (initialEstimate?.recipient_name || initialEstimate?.recipient_email) {
      return {
        name: initialEstimate.recipient_name ?? "",
        email: initialEstimate.recipient_email ?? null,
      };
    }
    return prospectRecipient
      ? { name: prospectRecipient.name, email: prospectRecipient.email ?? null }
      : { name: "", email: null };
  });
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const [taxRate, setTaxRate] = useState(initialEstimate?.tax_rate ?? 0);
  const [title, setTitle] = useState(initialEstimate?.title ?? "");
  const [scope, setScope] = useState(initialEstimate?.summary ?? "");
  const [precon, setPrecon] = useState<EstimateCommercial>(
    initialEstimate?.precon ?? {
      ...DEFAULT_ESTIMATE_COMMERCIAL,
      purpose: "budget",
      maturity: "conceptual",
    },
  );
  const initialTerms = initialEstimate?.terms?.trim()
    ? initialEstimate.terms
    : (initialEstimate?.precon?.purpose ?? "budget") === "budget"
      ? ""
      : (defaultTerms ?? "");
  const [terms, setTerms] = useState(initialTerms);
  const [termsEdited, setTermsEdited] = useState(
    Boolean(initialEstimate?.terms?.trim()),
  );
  function changeCommercial(next: EstimateCommercial) {
    if (!termsEdited && precon.purpose !== next.purpose) {
      if (next.purpose === "budget" && terms === (defaultTerms ?? ""))
        setTerms("");
      if (next.purpose !== "budget" && !terms.trim())
        setTerms(defaultTerms ?? "");
    }
    setPrecon(next);
  }
  const [intro, setIntro] = useState(
    initialEstimate?.intro ?? defaultIntro ?? "",
  );
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayMode>(
    initialEstimate?.pricing_display ?? "itemized",
  );
  const [photos, setPhotos] = useState<PhotoDraft[]>(
    (initialEstimate?.photos ?? []).map((p) => ({
      path: p.path,
      url: p.url ?? "",
      caption: p.caption ?? "",
    })),
  );
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [validUntil, setValidUntil] = useState<Date | undefined>(
    parseLocalDate(initialEstimate?.valid_until),
  );
  const [validUntilOpen, setValidUntilOpen] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>(seededLines);
  const [showErrors, setShowErrors] = useState(false);
  // Percent over cost applied to lines without their own markup.
  const [defaultMarkupPct, setDefaultMarkupPct] = useState<number | string>(
    initialEstimate?.markup_percent ? initialEstimate.markup_percent : "",
  );
  const [contingencyPct, setContingencyPct] = useState<number | string>(
    initialEstimate?.contingency_percent
      ? initialEstimate.contingency_percent
      : "",
  );
  const [inclusions, setInclusions] = useState(
    initialEstimate?.inclusions ?? "",
  );
  const [exclusions, setExclusions] = useState(
    initialEstimate?.exclusions ?? "",
  );
  // Sub quotes from the prospect's bid packages, usable as a line's cost basis.
  const [bidQuotes, setBidQuotes] = useState<ProspectBidQuote[]>([]);

  const effectiveMarkupPct = (line: LineDraft) =>
    draftMoneyLine(line, defaultMarkupPct, precon).markup_pct;
  const lineSell = (line: LineDraft) =>
    (estimateLineAmountCents(draftMoneyLine(line, defaultMarkupPct, precon)) ??
      0) / 100;
  const { total, grandTotal, contingencyTotal, costTotal, optionalTotal } =
    useMemo(
      () =>
        estimateDraftTotals(
          lines,
          defaultMarkupPct,
          contingencyPct,
          precon,
          taxRate,
        ),
      [lines, defaultMarkupPct, contingencyPct, precon, taxRate],
    );

  useEffect(() => {
    if (isRevise) return;
    if (defaultRecipientId) setRecipientId(defaultRecipientId);
  }, [defaultRecipientId, isRevise]);

  useEffect(() => {
    if (isRevise) return;
    if (prospectRecipient)
      setProspectChoice({
        name: prospectRecipient.name,
        email: prospectRecipient.email ?? null,
      });
  }, [prospectRecipient, isRevise]);

  useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId);
  }, [defaultProjectId]);

  useEffect(() => {
    if (!open || !defaultProspectId) return;
    let cancelled = false;
    listProspectBidQuotesAction(defaultProspectId)
      .then((quotes) => {
        if (!cancelled)
          setBidQuotes(
            [...quotes].sort(
              (a, b) =>
                Number(b.selected_for_pricing) - Number(a.selected_for_pricing),
            ),
          );
      })
      .catch(() => {
        // Quotes are a convenience; the builder can always price lines by hand.
      });
    return () => {
      cancelled = true;
    };
  }, [open, defaultProspectId]);

  const applyBidQuote = (idx: number, quote: ProspectBidQuote) => {
    setLines((prev) =>
      prev.map((line, i) =>
        i === idx
          ? {
              ...line,
              description: line.description.trim()
                ? line.description
                : `${quote.package_title}${quote.company_name ? ` — ${quote.company_name}` : ""}`,
              quantity: 1,
              unit_cost: quote.normalized_total_cents / 100,
              source_bid_submission_id: quote.submission_id,
              metadata: {
                ...line.metadata,
                bid_pricing_basis: {
                  pricing_decision_id: quote.pricing_decision_id,
                  submission_version: quote.submission_version,
                  vendor_total_cents: quote.total_cents,
                  normalized_total_cents: quote.normalized_total_cents,
                  scope_revision: quote.scope_revision,
                  accepted_alternate_ids: quote.accepted_alternate_ids,
                  gaps: quote.gaps,
                },
              },
            }
          : line,
      ),
    );
  };

  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((prev) =>
      prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)),
    );

  const addLine = () => {
    focusLine.current = lines.length;
    setLines((prev) => [...prev, newLine()]);
  };
  useEffect(() => {
    if (focusLine.current === null) return;
    document.getElementById(`estimate-line-${focusLine.current}`)?.focus();
    focusLine.current = null;
  }, [lines.length]);
  const addSection = () => setLines((prev) => [...prev, newSection()]);
  const removeLine = (idx: number) =>
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((_, i) => i !== idx),
    );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const reorderLines = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setLines((previous) => {
      const from = previous.findIndex((line) => line.editorId === active.id);
      const to = previous.findIndex((line) => line.editorId === over.id);
      return from < 0 || to < 0 ? previous : arrayMove(previous, from, to);
    });
  };

  function applyTemplate(template: EstimateTemplateOption) {
    if (!template.lines || template.lines.length === 0) return;
    setLines(
      template.lines.map((line) => ({
        editorId: crypto.randomUUID(),
        item_type:
          line.item_type === "group" ? ("group" as const) : ("line" as const),
        description: line.description ?? "",
        quantity: line.quantity ?? 1,
        unit_cost: centsToInput(line.unit_cost_cents),
        markup_pct: "",
        cost_code_id: line.cost_code_id ?? undefined,
        is_optional: line.is_optional ?? false,
        is_allowance: line.is_allowance ?? false,
        option_group: "",
      })),
    );
    if (!title.trim()) setTitle(template.name);
    toast.success(`Loaded “${template.name}”`);
  }

  async function handlePhotoFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setUploadingPhotos(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("photo", file);
        const result = unwrapAction(await uploadEstimatePhotoAction(formData));
        if ("error" in result && result.error) {
          toast.error(result.error);
          continue;
        }
        if ("path" in result && result.path) {
          setPhotos((prev) => [
            ...prev,
            { path: result.path, url: result.url ?? "", caption: "" },
          ]);
        }
      }
    } finally {
      setUploadingPhotos(false);
    }
  }

  const updatePhotoCaption = (idx: number, caption: string) =>
    setPhotos((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, caption } : p)),
    );
  const removePhoto = (idx: number) =>
    setPhotos((prev) => prev.filter((_, i) => i !== idx));

  const resetForm = () => {
    setPrecon(
      initialEstimate?.precon ?? {
        ...DEFAULT_ESTIMATE_COMMERCIAL,
        purpose: "budget",
        maturity: "conceptual",
      },
    );
    setRecipientId(defaultRecipientId ?? "");
    setProspectChoice(
      prospectRecipient
        ? {
            name: prospectRecipient.name,
            email: prospectRecipient.email ?? null,
          }
        : { name: "", email: null },
    );
    setProjectId(defaultProjectId ?? "");
    setTitle("");
    setScope("");
    setTerms(initialTerms);
    setTermsEdited(Boolean(initialEstimate?.terms?.trim()));
    setIntro(defaultIntro ?? "");
    setPricingDisplay("itemized");
    setPhotos([]);
    setValidUntil(undefined);
    setValidUntilOpen(false);
    setLines([newLine()]);
    setDefaultMarkupPct("");
    setContingencyPct("");
    setInclusions("");
    setExclusions("");
    setShowErrors(false);
  };

  const draftFingerprint = JSON.stringify({
    recipientId,
    prospectChoice,
    projectId,
    title,
    scope,
    precon,
    terms,
    intro,
    pricingDisplay,
    photos,
    validUntil,
    lines,
    defaultMarkupPct,
    contingencyPct,
    taxRate,
    inclusions,
    exclusions,
  });
  const [initialFingerprint] = useState(draftFingerprint);
  function requestClose() {
    if (saving || loading || uploadingPhotos) return;
    setConfirmClose(true);
  }

  const buildInput = (pricedLines: LineDraft[]): EstimateInput => ({
    title: title.trim(),
    project_id: projectId || undefined,
    prospect_id: defaultProspectId || undefined,
    // Prospect mode uses an ad-hoc name/email recipient; otherwise a Directory contact.
    recipient_contact_id: defaultProspectId
      ? undefined
      : recipientId || undefined,
    recipient_name: defaultProspectId
      ? prospectChoice.name || undefined
      : undefined,
    recipient_email: defaultProspectId
      ? prospectChoice.email || undefined
      : undefined,
    summary: scope || undefined,
    precon,
    source_budget_estimate_id: initialEstimate?.source_budget_estimate_id,
    terms: terms || undefined,
    intro: intro || undefined,
    pricing_display: pricingDisplay,
    photos: photos.map((p) => ({
      path: p.path,
      caption: p.caption.trim() || null,
    })),
    valid_until: validUntil ? format(validUntil, "yyyy-MM-dd") : undefined,
    tax_rate: taxRate,
    markup_percent: Number(defaultMarkupPct) || 0,
    contingency_percent: Number(contingencyPct) || 0,
    inclusions: inclusions.trim() || undefined,
    exclusions: exclusions.trim() || undefined,
    lines: pricedLines.map((line) => ({
      cost_code_id: line.item_type === "group" ? undefined : line.cost_code_id,
      description: line.description.trim(),
      quantity: line.quantity === "" ? 1 : Number(line.quantity),
      unit: line.unit,
      unit_cost_cents:
        line.item_type === "group"
          ? 0
          : Math.round((Number(line.unit_cost) || 0) * 100),
      markup_pct: line.item_type === "group" ? 0 : effectiveMarkupPct(line),
      item_type: line.item_type,
      is_optional: line.item_type === "group" ? undefined : line.is_optional,
      is_allowance: line.item_type === "group" ? undefined : line.is_allowance,
      option_group:
        line.item_type !== "group" &&
        line.is_optional &&
        line.option_group.trim()
          ? line.option_group.trim()
          : undefined,
      source_bid_submission_id:
        line.item_type === "group" ? undefined : line.source_bid_submission_id,
      metadata: { ...line.metadata, editor_line_id: line.editorId },
      notes:
        typeof line.metadata?.notes === "string"
          ? line.metadata.notes
          : undefined,
    })),
  });
  const previewInput = buildInput(
    lines.filter((line) => line.description.trim()),
  );
  previewInput.title ||= "Untitled document";
  previewInput.recipient_name = prospectRecipient
    ? prospectChoice.name || undefined
    : contacts.find((contact) => contact.id === recipientId)?.full_name;
  previewInput.recipient_email = prospectRecipient
    ? prospectChoice.email || undefined
    : contacts.find((contact) => contact.id === recipientId)?.email ||
      undefined;
  if (!previewInput.lines.length)
    previewInput.lines = [
      {
        description: "Scope of work",
        item_type: "line",
        quantity: 1,
        unit_cost_cents: 0,
      },
    ];

  const pricedLines = lines.filter(
    (line) =>
      !(
        line.item_type === "line" &&
        !line.description.trim() &&
        line.unit_cost === "" &&
        Number(line.quantity) === 1 &&
        line.markup_pct === "" &&
        !line.is_optional &&
        !line.is_allowance &&
        !line.cost_code_id &&
        !line.metadata &&
        !line.source_bid_submission_id
      ),
  );

  const candidate = estimateInputSchema.safeParse(buildInput(pricedLines));
  const autosave = useEstimateDraftAutosave({
    input:
      candidate.success &&
      pricedLines.some(
        (line) => line.item_type === "line" && line.description.trim(),
      )
        ? candidate.data
        : null,
    snapshot: draftFingerprint,
    recoveryKey,
    save: onAutosave,
    initial:
      initialEstimate?.status === "draft" &&
      initialEstimate.id &&
      initialEstimate.updated_at
        ? { id: initialEstimate.id, updated_at: initialEstimate.updated_at }
        : undefined,
    restore: (snapshot) => {
      const parsed = estimateRecoverySchema.safeParse(JSON.parse(snapshot));
      if (!parsed.success) return false;
      const value = parsed.data;
      setRecipientId(value.recipientId);
      setProspectChoice(value.prospectChoice);
      setProjectId(value.projectId);
      setTitle(value.title);
      setScope(value.scope);
      setPrecon(value.precon);
      setTerms(value.terms);
      setTermsEdited(true);
      setIntro(value.intro);
      setPricingDisplay(value.pricingDisplay);
      setPhotos(value.photos);
      setValidUntil(value.validUntil ? new Date(value.validUntil) : undefined);
      setLines(
        value.lines.map((line) => ({
          ...line,
          cost_code_id: line.cost_code_id,
        })),
      );
      setDefaultMarkupPct(value.defaultMarkupPct);
      setContingencyPct(value.contingencyPct);
      setTaxRate(value.taxRate);
      setInclusions(value.inclusions);
      setExclusions(value.exclusions);
      return true;
    },
  });
  useEffect(() => {
    if (
      !open ||
      draftFingerprint === initialFingerprint ||
      (onAutosave && autosave.state === "saved")
    )
      return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [open, draftFingerprint, initialFingerprint, onAutosave, autosave.state]);

  const confirmExit = async () => {
    setSaving(true);
    try {
      if (onAutosave) await autosave.flush();
      else resetForm();
      setConfirmClose(false);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save draft",
      );
    } finally {
      setSaving(false);
    }
  };
  const handleCreate = async () => {
    if (saving || loading || uploadingPhotos) return;
    const hasEmptyDescription = pricedLines.some((l) => !l.description.trim());
    const hasLineItem = pricedLines.some(
      (l) => l.item_type !== "group" && l.description.trim(),
    );

    if (!title.trim() || hasEmptyDescription || !hasLineItem) {
      setShowErrors(true);
      toast.error("Please fill out all required fields", {
        description: !title.trim()
          ? "The document title is required."
          : !hasLineItem
            ? "Add at least one line item (not just a section heading)."
            : "Every section and line item needs a description.",
      });
      return;
    }

    const payload = buildInput(pricedLines);

    setSaving(true);
    try {
      const savedDraft = onAutosave ? await autosave.flush(payload) : undefined;
      await onCreate(payload, savedDraft);
      autosave.complete();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save document",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document
            .getElementById(title.trim() ? "estimate-line-0" : "est-title")
            ?.focus();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        className="inset-0 left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 border-0 p-0 sm:max-w-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close document editor"
              onClick={requestClose}
              disabled={saving || loading || uploadingPhotos}
            >
              <X className="h-5 w-5" />
            </Button>
            <div>
              <DialogTitle className="text-base tracking-tight">
                {isRevise
                  ? `${initialEstimate?.status === "draft" ? "Edit" : "Revise"} ${precon.purpose === "budget" ? "proposal" : "agreement"}${initialEstimate?.version ? ` · v${initialEstimate.version + (initialEstimate.status === "draft" ? 0 : 1)}` : ""}`
                  : precon.purpose === "budget"
                    ? "New proposal"
                    : "New agreement"}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                {prospectChoice.name ||
                  contacts.find((contact) => contact.id === recipientId)
                    ?.full_name ||
                  "Price the work, then refine the details."}
              </DialogDescription>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            {saving || loading || autosave.state === "saving"
              ? "Saving…"
              : autosave.state === "saved"
                ? "Saved"
                : autosave.state === "error"
                  ? "Couldn’t save"
                  : onAutosave && autosave.recoverySaved
                    ? "Saved in this tab"
                    : "Unsaved draft"}
          </span>
        </header>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Close this draft?</AlertDialogTitle>
              <AlertDialogDescription>
                {onAutosave
                  ? "Your draft will be kept so you can finish it later. Incomplete fields are kept in this browser tab."
                  : "Any unsaved changes will be discarded."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>
                Keep editing
              </AlertDialogCancel>
              <Button
                type="button"
                onClick={() => void confirmExit()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Close draft"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <fieldset
            disabled={saving || loading || uploadingPhotos}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DocumentEditorLayout>
              <DocumentEditorFields>
                <div className="mx-auto max-w-[960px]">
                  <main className="min-w-0 space-y-7 p-5 sm:p-8 lg:p-10">
                    {!defaultProspectId && (
                      <div className="space-y-1.5">
                        <Label>Client</Label>
                        <Select
                          value={recipientId}
                          onValueChange={setRecipientId}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select client" />
                          </SelectTrigger>
                          <SelectContent>
                            {contacts.map((contact) => (
                              <SelectItem key={contact.id} value={contact.id}>
                                {contact.full_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {isRevise && requestedChanges?.trim() ? (
                      <div className="rounded-lg border border-warning/30 bg-warning/5 p-3.5">
                        <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                          Client requested changes
                        </p>
                        <p className="mt-1.5 whitespace-pre-line text-sm text-foreground">
                          {requestedChanges.trim()}
                        </p>
                      </div>
                    ) : null}

                    {/* Basics */}
                    <div className="space-y-4">
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="est-title"
                          className={cn(
                            showErrors && !title.trim() && "text-destructive",
                          )}
                        >
                          Title
                        </Label>
                        <Input
                          id="est-title"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="e.g. Kitchen remodel"
                          className={cn(
                            "h-11",
                            showErrors &&
                              !title.trim() &&
                              "border-destructive focus-visible:ring-destructive",
                          )}
                        />
                        {showErrors && !title.trim() && (
                          <p className="text-xs text-destructive font-medium">
                            Title is required
                          </p>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="est-scope">Scope</Label>
                        <Textarea
                          id="est-scope"
                          value={scope}
                          onChange={(e) => setScope(e.target.value)}
                          rows={3}
                          placeholder="Describe what this estimate covers…"
                        />
                      </div>
                    </div>

                    <div>
                      {!isRevise &&
                      lines.every(
                        (line) => !line.description.trim() && !line.unit_cost,
                      ) &&
                      templates &&
                      templates.length > 0 ? (
                        <div className="space-y-1.5">
                          <Label>Start from template</Label>
                          <Select
                            onValueChange={(id) => {
                              const template = templates.find(
                                (t) => t.id === id,
                              );
                              if (template) applyTemplate(template);
                            }}
                          >
                            <SelectTrigger className="h-10">
                              <SelectValue placeholder="Choose a template…" />
                            </SelectTrigger>
                            <SelectContent>
                              {templates.map((template) => (
                                <SelectItem
                                  key={template.id}
                                  value={template.id}
                                >
                                  {template.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            Seeds sections and line items — edit everything
                            after.
                          </p>
                        </div>
                      ) : null}
                    </div>
                    {/* Line items */}
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold tracking-tight">
                            Price the work
                          </h2>
                          <p className="text-xs text-muted-foreground">
                            Start with a lump sum or build up quantities. Add
                            detail as you need it.
                          </p>
                        </div>
                        <div className="flex items-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addSection}
                          >
                            <LayoutGrid className="mr-1.5 h-4 w-4" />
                            Section
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={addLine}
                          >
                            <Plus className="mr-1.5 h-4 w-4" />
                            Item
                          </Button>
                        </div>
                      </div>

                      <DndContext
                        id="estimate-lines"
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={reorderLines}
                      >
                        <SortableContext
                          items={lines.map((line) => line.editorId)}
                          strategy={verticalListSortingStrategy}
                        >
                          <div className="divide-y border-y">
                            {lines.map((line, idx) => {
                              const lineTotal = lineSell(line);

                              if (line.item_type === "group") {
                                return (
                                  <SortableEstimateLine
                                    key={line.editorId}
                                    id={line.editorId}
                                    label={line.description || "Section"}
                                  >
                                    {(handle) => (
                                      <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 p-2.5">
                                        {handle}
                                        <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        <Input
                                          value={line.description}
                                          onChange={(e) =>
                                            updateLine(idx, {
                                              description: e.target.value,
                                            })
                                          }
                                          placeholder="Section heading (e.g. Demolition)"
                                          className={cn(
                                            "h-9 flex-1 font-semibold uppercase tracking-wide",
                                            showErrors &&
                                              !line.description.trim() &&
                                              "border-destructive focus-visible:ring-destructive",
                                          )}
                                        />
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon"
                                          className="h-9 w-9 shrink-0 text-muted-foreground"
                                          aria-label={`Remove item ${idx + 1}`}
                                          onClick={() => removeLine(idx)}
                                          disabled={lines.length === 1}
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </Button>
                                      </div>
                                    )}
                                  </SortableEstimateLine>
                                );
                              }

                              return (
                                <SortableEstimateLine
                                  key={line.editorId}
                                  id={line.editorId}
                                  label={line.description || `Item ${idx + 1}`}
                                >
                                  {(handle) => (
                                    <Accordion type="single" collapsible>
                                      <AccordionItem
                                        value="details"
                                        className={cn(
                                          "py-4 space-y-3",
                                          line.is_optional && "bg-muted/30",
                                        )}
                                      >
                                        <TakeoffLineBadge
                                          metadata={line.metadata}
                                          liveQuantity={line.quantity}
                                          prospectId={defaultProspectId}
                                          projectId={projectId}
                                        />
                                        {/* Row 1: reorder · description · qty · unit cost */}
                                        <div className="flex flex-wrap items-end gap-2">
                                          {handle}
                                          <div className="min-w-[160px] flex-1 space-y-1">
                                            <Label
                                              htmlFor={`estimate-line-${idx}`}
                                              className={cn(
                                                "text-[10px] uppercase tracking-wide text-muted-foreground",
                                                showErrors &&
                                                  !line.description.trim() &&
                                                  "text-destructive",
                                              )}
                                            >
                                              Description
                                            </Label>
                                            <div className="relative">
                                              <div className="absolute left-0 top-0 z-10 flex h-9 w-9 items-center justify-center">
                                                <AccordionTrigger
                                                  className="h-9 w-9 flex-none items-center justify-center gap-0 rounded-none border-r p-0 hover:bg-muted/50 hover:no-underline [&>svg]:translate-y-0 [&>svg]:-rotate-90 [&[data-state=open]>svg]:rotate-0"
                                                  aria-label={`Details for ${line.description || `item ${idx + 1}`}`}
                                                />
                                              </div>
                                              <Input
                                                id={`estimate-line-${idx}`}
                                                value={line.description}
                                                onChange={(e) =>
                                                  updateLine(idx, {
                                                    description: e.target.value,
                                                  })
                                                }
                                                placeholder="Work item"
                                                className={cn(
                                                  "h-9 pl-11",
                                                  showErrors &&
                                                    !line.description.trim() &&
                                                    "border-destructive focus-visible:ring-destructive",
                                                )}
                                              />
                                            </div>
                                          </div>
                                          <div className="w-16 space-y-1">
                                            <Label
                                              htmlFor={`estimate-qty-${idx}`}
                                              className="text-[10px] uppercase tracking-wide text-muted-foreground"
                                            >
                                              Qty
                                            </Label>
                                            <Input
                                              type="number"
                                              min={0}
                                              step={0.01}
                                              id={`estimate-qty-${idx}`}
                                              value={line.quantity}
                                              onChange={(e) =>
                                                updateLine(idx, {
                                                  quantity: e.target.value,
                                                })
                                              }
                                              className={cn(
                                                "h-9 tabular-nums",
                                                noSpinner,
                                              )}
                                            />
                                          </div>
                                          <div className="w-28 space-y-1">
                                            <Label
                                              htmlFor={`estimate-cost-${idx}`}
                                              className="text-[10px] uppercase tracking-wide text-muted-foreground"
                                            >
                                              Unit cost
                                            </Label>
                                            <div className="relative">
                                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none pointer-events-none">
                                                $
                                              </span>
                                              <Input
                                                type="number"
                                                min={
                                                  line.is_optional &&
                                                  [
                                                    "deduct",
                                                    "replacement",
                                                  ].includes(
                                                    line.metadata
                                                      ?.alternate_kind,
                                                  )
                                                    ? undefined
                                                    : 0
                                                }
                                                step={0.01}
                                                id={`estimate-cost-${idx}`}
                                                onKeyDown={(event) => {
                                                  if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    if (
                                                      idx ===
                                                      lines.length - 1
                                                    )
                                                      addLine();
                                                    else
                                                      document
                                                        .getElementById(
                                                          `estimate-line-${idx + 1}`,
                                                        )
                                                        ?.focus();
                                                  }
                                                }}
                                                value={line.unit_cost}
                                                onChange={(e) =>
                                                  updateLine(idx, {
                                                    unit_cost: e.target.value,
                                                  })
                                                }
                                                placeholder="0.00"
                                                className={cn(
                                                  "h-9 pl-7 pr-3 tabular-nums",
                                                  noSpinner,
                                                )}
                                              />
                                            </div>
                                          </div>
                                          <div className="ml-auto min-w-24 text-right">
                                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                              Amount
                                            </span>
                                            <p className="flex h-9 items-center justify-end text-sm font-medium tabular-nums">
                                              {money(lineTotal)}
                                            </p>
                                          </div>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-9 w-9 shrink-0 text-muted-foreground"
                                            aria-label={`Remove item ${idx + 1}`}
                                            onClick={() => removeLine(idx)}
                                            disabled={lines.length === 1}
                                          >
                                            <Trash2 className="h-4 w-4" />
                                          </Button>
                                        </div>
                                        <AccordionContent>
                                          <div className="space-y-3 bg-muted/20 p-3 mt-3">
                                            {/* Detailed line settings */}
                                            <div className="flex flex-wrap items-end gap-3">
                                              <div className="w-20 space-y-1">
                                                <Label
                                                  htmlFor={`estimate-markup-${idx}`}
                                                  className="text-[10px] uppercase tracking-wide text-muted-foreground"
                                                >
                                                  Markup override
                                                </Label>
                                                <div className="relative">
                                                  <Input
                                                    type="number"
                                                    min={0}
                                                    step={0.1}
                                                    id={`estimate-markup-${idx}`}
                                                    value={
                                                      precon.billing_model ===
                                                      "cost_plus_fixed_fee"
                                                        ? 0
                                                        : line.markup_pct
                                                    }
                                                    disabled={
                                                      precon.billing_model ===
                                                      "cost_plus_fixed_fee"
                                                    }
                                                    onChange={(e) =>
                                                      updateLine(idx, {
                                                        markup_pct:
                                                          e.target.value,
                                                      })
                                                    }
                                                    placeholder={
                                                      defaultMarkupPct !== ""
                                                        ? String(
                                                            defaultMarkupPct,
                                                          )
                                                        : "0"
                                                    }
                                                    className={cn(
                                                      "h-9 pr-6 tabular-nums",
                                                      noSpinner,
                                                    )}
                                                  />
                                                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none pointer-events-none">
                                                    %
                                                  </span>
                                                </div>
                                              </div>

                                              <div className="flex-1 space-y-1">
                                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                  Cost code
                                                </Label>
                                                <Select
                                                  value={
                                                    line.cost_code_id ?? "none"
                                                  }
                                                  onValueChange={(v) =>
                                                    updateLine(idx, {
                                                      cost_code_id:
                                                        v === "none"
                                                          ? undefined
                                                          : v,
                                                    })
                                                  }
                                                >
                                                  <SelectTrigger className="h-9">
                                                    <SelectValue placeholder="No cost code" />
                                                  </SelectTrigger>
                                                  <SelectContent>
                                                    <SelectItem value="none">
                                                      No cost code
                                                    </SelectItem>
                                                    {(costCodes ?? []).map(
                                                      (code) => (
                                                        <SelectItem
                                                          key={code.id}
                                                          value={code.id}
                                                        >
                                                          {code.code} ·{" "}
                                                          {code.name}
                                                        </SelectItem>
                                                      ),
                                                    )}
                                                  </SelectContent>
                                                </Select>
                                              </div>
                                              {bidQuotes.length > 0 ? (
                                                <div className="flex-1 space-y-1">
                                                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                    Use bid
                                                  </Label>
                                                  <Select
                                                    value={
                                                      line.source_bid_submission_id ??
                                                      "none"
                                                    }
                                                    onValueChange={(v) => {
                                                      if (v === "none") {
                                                        updateLine(idx, {
                                                          source_bid_submission_id:
                                                            undefined,
                                                        });
                                                        return;
                                                      }
                                                      const quote =
                                                        bidQuotes.find(
                                                          (q) =>
                                                            q.submission_id ===
                                                            v,
                                                        );
                                                      if (quote)
                                                        applyBidQuote(
                                                          idx,
                                                          quote,
                                                        );
                                                    }}
                                                  >
                                                    <SelectTrigger className="h-9">
                                                      <SelectValue placeholder="No bid" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                      <SelectItem value="none">
                                                        No bid
                                                      </SelectItem>
                                                      {bidQuotes.map(
                                                        (quote) => (
                                                          <SelectItem
                                                            key={
                                                              quote.submission_id
                                                            }
                                                            value={
                                                              quote.submission_id
                                                            }
                                                          >
                                                            {
                                                              quote.package_title
                                                            }
                                                            {quote.company_name
                                                              ? ` · ${quote.company_name}`
                                                              : ""}{" "}
                                                            ·{" "}
                                                            {money(
                                                              quote.normalized_total_cents /
                                                                100,
                                                            )}
                                                            {quote.selected_for_pricing
                                                              ? " · Selected basis"
                                                              : ""}
                                                            {quote.gaps.length
                                                              ? ` · ${quote.gaps.length} scope gaps`
                                                              : ""}
                                                          </SelectItem>
                                                        ),
                                                      )}
                                                    </SelectContent>
                                                  </Select>
                                                </div>
                                              ) : null}
                                              <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                                                <Checkbox
                                                  checked={line.is_optional}
                                                  onCheckedChange={(c) =>
                                                    updateLine(idx, {
                                                      is_optional: c === true,
                                                      metadata: {
                                                        ...line.metadata,
                                                        alternate_kind:
                                                          c === true
                                                            ? line.metadata
                                                                ?.alternate_kind
                                                            : undefined,
                                                        replacement_scope:
                                                          c === true
                                                            ? line.metadata
                                                                ?.replacement_scope
                                                            : undefined,
                                                      },
                                                    })
                                                  }
                                                />
                                                Optional add-on
                                              </label>
                                              <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                                                <Checkbox
                                                  checked={line.is_allowance}
                                                  onCheckedChange={(c) =>
                                                    updateLine(idx, {
                                                      is_allowance: c === true,
                                                    })
                                                  }
                                                />
                                                Allowance
                                              </label>
                                              <div className="space-y-1 text-right">
                                                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                  Line total
                                                </Label>
                                                <div className="flex h-9 items-center justify-end px-2 text-sm font-semibold tabular-nums">
                                                  {money(lineTotal)}
                                                </div>
                                              </div>
                                            </div>
                                            {line.is_optional && (
                                              <div className="grid gap-3 sm:grid-cols-2">
                                                <div className="space-y-1">
                                                  <Label>
                                                    Alternate treatment
                                                  </Label>
                                                  <Select
                                                    value={
                                                      line.metadata
                                                        ?.alternate_kind ??
                                                      "add"
                                                    }
                                                    onValueChange={(value) =>
                                                      updateLine(idx, {
                                                        metadata: {
                                                          ...line.metadata,
                                                          alternate_kind: value,
                                                        },
                                                      })
                                                    }
                                                  >
                                                    <SelectTrigger>
                                                      <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                      <SelectItem value="add">
                                                        Add scope
                                                      </SelectItem>
                                                      <SelectItem value="deduct">
                                                        Deduct scope (negative
                                                        delta)
                                                      </SelectItem>
                                                      <SelectItem value="replacement">
                                                        Replace base scope (net
                                                        delta)
                                                      </SelectItem>
                                                    </SelectContent>
                                                  </Select>
                                                </div>
                                                {line.metadata
                                                  ?.alternate_kind ===
                                                  "replacement" && (
                                                  <div className="space-y-1">
                                                    <Label>
                                                      Base scope being replaced
                                                    </Label>
                                                    <Input
                                                      value={
                                                        line.metadata
                                                          ?.replacement_scope ??
                                                        ""
                                                      }
                                                      onChange={(e) =>
                                                        updateLine(idx, {
                                                          metadata: {
                                                            ...line.metadata,
                                                            replacement_scope:
                                                              e.target.value,
                                                          },
                                                        })
                                                      }
                                                      placeholder="Identify the included item or scope"
                                                    />
                                                  </div>
                                                )}
                                                {line.metadata
                                                  ?.alternate_kind &&
                                                  line.metadata
                                                    .alternate_kind !==
                                                    "add" && (
                                                    <p className="text-xs text-muted-foreground sm:col-span-2">
                                                      Enter the net cost change
                                                      from included scope. A
                                                      negative amount credits
                                                      the base price; a
                                                      replacement does not add
                                                      its full cost twice.
                                                    </p>
                                                  )}
                                              </div>
                                            )}
                                            {line.is_optional ? (
                                              <div className="flex items-end gap-2">
                                                <div className="w-56 space-y-1">
                                                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                    Alternate group
                                                  </Label>
                                                  <Input
                                                    value={line.option_group}
                                                    onChange={(e) =>
                                                      updateLine(idx, {
                                                        option_group:
                                                          e.target.value,
                                                      })
                                                    }
                                                    placeholder="e.g. Countertops"
                                                    className="h-9"
                                                  />
                                                </div>
                                                <p className="pb-2 text-xs text-muted-foreground">
                                                  Options with the same group
                                                  are “choose one” in the
                                                  portal. Leave blank for an
                                                  independent add-on.
                                                </p>
                                              </div>
                                            ) : null}
                                          </div>
                                        </AccordionContent>
                                      </AccordionItem>
                                    </Accordion>
                                  )}
                                </SortableEstimateLine>
                              );
                            })}
                          </div>
                        </SortableContext>
                      </DndContext>

                      <Button
                        type="button"
                        variant="ghost"
                        onClick={addLine}
                        className="w-full justify-start border-b py-6 text-muted-foreground"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add work item
                        <span className="ml-auto hidden text-xs sm:inline">
                          Enter on the last cost to add another
                        </span>
                      </Button>
                    </div>
                    <section
                      aria-label="Estimate summary"
                      className="border-t pt-5"
                    >
                      <h3 className="text-sm font-medium">Pricing</h3>
                      <div className="mt-4 grid grid-cols-3 gap-3">
                        {" "}
                        <div className="min-w-0 space-y-2">
                          <Label
                            htmlFor="estimate-default-markup"
                            className="text-xs text-muted-foreground"
                          >
                            Markup on cost
                          </Label>
                          <div className="relative">
                            <Input
                              type="number"
                              min={0}
                              step={0.1}
                              id="estimate-default-markup"
                              value={defaultMarkupPct}
                              disabled={
                                precon.billing_model === "cost_plus_fixed_fee"
                              }
                              onChange={(e) =>
                                setDefaultMarkupPct(e.target.value)
                              }
                              placeholder="0"
                              className={cn("h-8 pr-6 tabular-nums", noSpinner)}
                            />
                            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none pointer-events-none">
                              %
                            </span>
                          </div>
                        </div>
                        <div className="min-w-0 space-y-2">
                          <Label
                            htmlFor="estimate-contingency"
                            className="text-xs text-muted-foreground"
                          >
                            Contingency
                          </Label>
                          <div className="relative">
                            <Input
                              type="number"
                              min={0}
                              step={0.1}
                              id="estimate-contingency"
                              value={contingencyPct}
                              onChange={(e) =>
                                setContingencyPct(e.target.value)
                              }
                              placeholder="0"
                              className={cn("h-8 pr-6 tabular-nums", noSpinner)}
                            />
                            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none pointer-events-none">
                              %
                            </span>
                          </div>
                        </div>
                        <div className="min-w-0 space-y-2">
                          <Label
                            htmlFor="estimate-tax"
                            className="text-xs text-muted-foreground"
                          >
                            Tax
                          </Label>
                          <div className="relative">
                            <Input
                              id="estimate-tax"
                              type="number"
                              min={0}
                              max={100}
                              step={0.1}
                              value={taxRate}
                              onChange={(event) =>
                                setTaxRate(Number(event.target.value))
                              }
                              className={cn("h-8 pr-6 tabular-nums", noSpinner)}
                            />
                            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                              %
                            </span>
                          </div>
                        </div>
                      </div>
                      <dl className="mt-5 space-y-2.5 text-sm">
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">Direct cost</dt>
                          <dd className="tabular-nums">{money(costTotal)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">
                            {precon.billing_model === "cost_plus_fixed_fee"
                              ? "Builder fee"
                              : "Markup"}
                          </dt>
                          <dd className="tabular-nums">
                            {money(total - costTotal)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">Contingency</dt>
                          <dd className="tabular-nums">
                            {money(contingencyTotal)}
                          </dd>
                        </div>
                        {Number(taxRate) > 0 && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">Tax</dt>
                            <dd className="tabular-nums">
                              {money(grandTotal - total - contingencyTotal)}
                            </dd>
                          </div>
                        )}
                        <div className="flex justify-between gap-3 border-t pt-3 font-medium">
                          <dt>Total</dt>
                          <dd className="tabular-nums" aria-live="polite">
                            {money(grandTotal)}
                          </dd>
                        </div>
                        {optionalTotal !== 0 && (
                          <div className="flex justify-between gap-3 border-t pt-4">
                            <dt className="text-muted-foreground">
                              Options · not in base
                            </dt>
                            <dd className="tabular-nums">
                              {money(optionalTotal)}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {precon.purpose === "budget" && (
                        <Accordion
                          type="single"
                          collapsible
                          className="mt-6 overflow-hidden rounded-none border"
                        >
                          <AccordionItem value="settings" className="border-0">
                            <AccordionTrigger className="min-h-14 items-center rounded-none px-4 py-4 hover:bg-muted/40 hover:no-underline [&>svg]:translate-y-0">
                              Pricing assumptions
                            </AccordionTrigger>
                            <AccordionContent className="border-t px-4 pb-4 pt-4">
                              <div>
                                <EstimateCommercialFields
                                  purposeLocked={Boolean(defaultProspectId)}
                                  value={precon}
                                  onChange={changeCommercial}
                                  pricingOnly
                                />
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      )}
                    </section>
                    <Accordion
                      type="single"
                      collapsible
                      className="overflow-hidden rounded-none border"
                    >
                      <AccordionItem value="settings" className="border-0">
                        <AccordionTrigger className="min-h-14 items-center rounded-none px-4 py-4 hover:bg-muted/40 hover:no-underline [&>svg]:translate-y-0">
                          Document settings
                        </AccordionTrigger>
                        <AccordionContent className="border-t px-4 pb-4 pt-4">
                          <div className="space-y-6">
                            <div className="grid grid-cols-2 items-start gap-4">
                              {" "}
                              <div className="space-y-1.5">
                                <Label>Valid until</Label>
                                <Popover
                                  open={validUntilOpen}
                                  onOpenChange={setValidUntilOpen}
                                >
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      className={cn(
                                        "w-full justify-start text-left font-normal",
                                        !validUntil && "text-muted-foreground",
                                      )}
                                    >
                                      <CalendarDays className="mr-2 h-4 w-4" />
                                      {validUntil
                                        ? format(validUntil, "LLL dd, y")
                                        : "Optional"}
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    className="w-auto p-0"
                                    align="start"
                                  >
                                    <Calendar
                                      mode="single"
                                      selected={validUntil}
                                      onSelect={(date) => {
                                        setValidUntil(date);
                                        setValidUntilOpen(false);
                                      }}
                                      initialFocus
                                    />
                                  </PopoverContent>
                                </Popover>
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-sm">
                                  Pricing display
                                </Label>
                                <Select
                                  value={pricingDisplay}
                                  onValueChange={(v) =>
                                    setPricingDisplay(v as PricingDisplayMode)
                                  }
                                >
                                  <SelectTrigger className="h-9">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {PRICING_DISPLAY_OPTIONS.map((opt) => (
                                      <SelectItem
                                        key={opt.value}
                                        value={opt.value}
                                      >
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                  {
                                    PRICING_DISPLAY_OPTIONS.find(
                                      (o) => o.value === pricingDisplay,
                                    )?.hint
                                  }
                                </p>
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="est-intro">Cover note</Label>
                              <Textarea
                                id="est-intro"
                                value={intro}
                                onChange={(e) => setIntro(e.target.value)}
                                rows={3}
                                placeholder="A short, friendly intro shown above the line items…"
                              />
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div className="space-y-1.5">
                                <Label htmlFor="est-inclusions">
                                  Included in this price
                                </Label>
                                <Textarea
                                  id="est-inclusions"
                                  value={inclusions}
                                  onChange={(e) =>
                                    setInclusions(e.target.value)
                                  }
                                  rows={3}
                                  placeholder="One item per line — permits, dumpsters, cleanup…"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="est-exclusions">
                                  Not included
                                </Label>
                                <Textarea
                                  id="est-exclusions"
                                  value={exclusions}
                                  onChange={(e) =>
                                    setExclusions(e.target.value)
                                  }
                                  rows={3}
                                  placeholder="One item per line — landscaping, appliances, utility fees…"
                                />
                              </div>
                            </div>
                            <Accordion
                              type="single"
                              collapsible
                              className="border-t"
                            >
                              <AccordionItem
                                value="photos"
                                className="border-0"
                              >
                                <AccordionTrigger className="text-sm hover:no-underline">
                                  Photos
                                  {photos.length ? ` (${photos.length})` : ""}
                                </AccordionTrigger>
                                <AccordionContent className="space-y-3">
                                  {photos.length > 0 ? (
                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                                      {photos.map((photo, idx) => (
                                        <div
                                          key={photo.path}
                                          className="space-y-1.5"
                                        >
                                          <div className="relative aspect-[4/3] overflow-hidden rounded-md border bg-muted">
                                            {photo.url ? (
                                              <img
                                                src={photo.url}
                                                alt={
                                                  photo.caption ||
                                                  "Estimate photo"
                                                }
                                                className="h-full w-full object-cover"
                                              />
                                            ) : (
                                              <div className="flex h-full items-center justify-center">
                                                <ImageIcon className="h-6 w-6 text-muted-foreground" />
                                              </div>
                                            )}
                                            <button
                                              type="button"
                                              onClick={() => removePhoto(idx)}
                                              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow hover:text-destructive"
                                              aria-label="Remove photo"
                                            >
                                              <X className="h-3.5 w-3.5" />
                                            </button>
                                          </div>
                                          <Input
                                            value={photo.caption}
                                            onChange={(e) =>
                                              updatePhotoCaption(
                                                idx,
                                                e.target.value,
                                              )
                                            }
                                            placeholder="Caption (optional)"
                                            className="h-8 text-xs"
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
                                  <label
                                    className={cn(
                                      "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed p-5 text-center transition-colors hover:border-primary/50 hover:bg-muted/30",
                                      uploadingPhotos &&
                                        "pointer-events-none opacity-60",
                                    )}
                                  >
                                    {uploadingPhotos ? (
                                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                    ) : (
                                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                                    )}
                                    <span className="text-sm font-medium">
                                      {uploadingPhotos
                                        ? "Uploading…"
                                        : "Add photos"}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      PNG, JPG, WEBP or GIF · up to 15MB each
                                    </span>
                                    <input
                                      type="file"
                                      accept="image/png,image/jpeg,image/webp,image/gif"
                                      multiple
                                      className="hidden"
                                      disabled={uploadingPhotos}
                                      onChange={(e) => {
                                        void handlePhotoFiles(e.target.files);
                                        e.target.value = "";
                                      }}
                                    />
                                  </label>
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>

                            {precon.purpose === "budget" && (
                              <div className="space-y-2">
                                <Label htmlFor="estimate-qualifications">
                                  Qualifications
                                </Label>
                                <Textarea
                                  id="estimate-qualifications"
                                  value={terms}
                                  onChange={(event) => {
                                    setTermsEdited(true);
                                    setTerms(event.target.value);
                                  }}
                                  rows={3}
                                  placeholder="Validity, limitations, or conditions on this proposal…"
                                />
                              </div>
                            )}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                    {precon.purpose !== "budget" && (
                      <Accordion
                        type="single"
                        collapsible
                        className="border-t pt-5"
                      >
                        <AccordionItem value="settings" className="border-0">
                          <AccordionTrigger className="py-0 hover:no-underline">
                            Agreement terms
                          </AccordionTrigger>
                          <AccordionContent>
                            <div className="mt-5 space-y-6">
                              <EstimateCommercialFields
                                purposeLocked={Boolean(defaultProspectId)}
                                value={precon}
                                onChange={changeCommercial}
                              />
                              {/* Terms */}
                              <div className="space-y-1.5">
                                <Label htmlFor="est-terms">Terms</Label>
                                <Textarea
                                  id="est-terms"
                                  value={terms}
                                  onChange={(e) => {
                                    setTermsEdited(true);
                                    setTerms(e.target.value);
                                  }}
                                  rows={4}
                                  placeholder="Payment terms, validity, exclusions…"
                                />
                                <p className="text-xs text-muted-foreground">
                                  {precon.purpose ===
                                  "preconstruction_agreement"
                                    ? "Define the terms for these preconstruction services."
                                    : "Review and confirm the terms for this construction agreement."}
                                </p>
                              </div>
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </main>
                </div>
              </DocumentEditorFields>
              <EstimateLivePreview input={previewInput} branding={branding} />
            </DocumentEditorLayout>
            <footer className="flex shrink-0 items-center justify-between gap-3 border-t bg-background px-5 py-4 sm:px-8">
              {autosave.error && (
                <p role="alert" className="text-xs text-destructive">
                  {autosave.error}
                </p>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={requestClose}
                  disabled={loading || saving || uploadingPhotos}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={loading || saving || uploadingPhotos}
                >
                  {loading || saving
                    ? "Saving…"
                    : isRevise && initialEstimate?.status !== "draft"
                      ? "Save new version"
                      : "Save draft"}
                </Button>
              </div>
            </footer>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
