"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  Search,
  SlidersHorizontal,
  Settings2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import dynamic from "next/dynamic";
import type { FileWithDetails } from "@/components/files/types";
import { cn } from "@/lib/utils";
import { BankingPicker } from "./banking-picker";
import { BankingReceiptCell } from "./banking-receipt-cell";
import { BankingBulkIsland } from "./banking-bulk-island";
import { BankingAccountCard } from "./banking-account-card";
import { BankingSyncControl, latestBankSync } from "./banking-sync-control";
import { BankingRules } from "./banking-rules";
import {
  CapturedExpenseBand,
  RecordCostTwiceConfirm,
  UnstatementedExpenses,
  capturedExpenseLabel,
} from "./banking-captured-expenses";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { bankingOptimisticCounts, bankingPaginationItems, formatBankDate } from "./banking-ui";
import {
  capturedExpenseMatch,
  codingForTransactionTotal,
  codingProblem,
  type BankCoding,
} from "@/lib/services/books/banking-model";
import type { BankingTransaction } from "@/lib/services/books/banking-workspace";
import {
  loadBankingTransactionsAction,
  loadBankingOptionsAction,
  mutateBankingTransactionAction,
  loadBankingDetailAction,
  createBankingVendorAction,
  linkBankingReceiptAction,
} from "@/app/(app)/books/banking-actions";
import { loadBankReviewTrayAction } from "@/app/(app)/books/actions";
import type { BankReviewTray } from "@/lib/services/books/bank-reconciliation";

const FileViewer = dynamic(
  () => import("@/components/files/file-viewer").then((module) => module.FileViewer),
  { ssr: false },
);

const BANKING_TABLE_HEADER_HEIGHT = "h-11";
const BANKING_TRANSACTION_ROW_HEIGHT = "h-14";
const BANKING_INSPECTOR_HEADER_HEIGHT = "h-[100px]";
const BANKING_FOOTER_HEIGHT = "h-16";

type Workspace = Awaited<
  ReturnType<typeof import("@/lib/services/books/workspace").getBooksWorkspace>
>;
type Options = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/banking-workspace").loadBankingOptions
  >
>;
type Detail = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/banking-workspace").loadBankingDetail
  >
>;
type Mutation = Parameters<typeof mutateBankingTransactionAction>[0];
const emptyOptions: Options = {
  vendors: [],
  projects: [],
  costCodes: [],
  counts: {},
};
const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
const date = formatBankDate;
const relation = <T,>(value: T | T[]) =>
  Array.isArray(value) ? value[0] : value;

const initials = (value: string) =>
  value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const normalizedIdentity = (value: string | null | undefined) =>
  (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();

function VendorMark({
  name,
  logoUrl,
}: {
  name: string;
  logoUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoUrl]);
  const showLogo = Boolean(logoUrl && !failed);
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/50 text-[10px] font-semibold tracking-wide text-muted-foreground"
    >
      {showLogo ? (
        // Plaid supplies the merchant asset URL; the initials remain when it fails.
        <img
          src={logoUrl!}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name) || "?"
      )}
    </span>
  );
}

export function BankingWorkspace({
  workspace,
  management,
  reconciliationAccountId,
}: {
  workspace: Workspace;
  management: ReactNode;
  reconciliationAccountId?: string;
}) {
  const canEdit = workspace.capabilities.reconcile;
  const [rows, setRows] = useState<BankingTransaction[]>([]);
  const loadedStatus = useRef<Record<string, string>>({});
  const [count, setCount] = useState(0);
  const [options, setOptions] = useState<Options>(emptyOptions);
  const [suggestions, setSuggestions] = useState<BankReviewTray["rows"]>([]);
  const [accountId, setAccountId] = useState<string | null>(
    reconciliationAccountId ?? null,
  );
  const [status, setStatus] = useState<
    "review" | "posted" | "excluded" | "pending" | "all"
  >("review");
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [direction, setDirection] = useState<"inflow" | "outflow" | "">("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<"date" | "description" | "amount">("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filtersReady, setFiltersReady] = useState(false);
  const preferenceKey = `arc:banking:view:${workspace.settings?.org_id ?? "workspace"}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
      if (saved && typeof saved === "object") {
        if (
          saved.accountId === null ||
          workspace.bankAccounts.some(
            (account) => account.id === saved.accountId,
          )
        )
          setAccountId(saved.accountId);
        if (
          ["review", "posted", "excluded", "pending", "all"].includes(
            saved.status,
          )
        )
          setStatus(saved.status);
      }
    } catch {
      /* Preferences never block account access. */
    }
    if (reconciliationAccountId) setAccountId(reconciliationAccountId);
    setFiltersReady(true);
    // Restore once per organization; new accounts should not reset the current view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferenceKey]);
  useEffect(() => {
    if (filtersReady) {
      try {
        localStorage.setItem(
          preferenceKey,
          JSON.stringify({ accountId, status }),
        );
      } catch {
        /* Storage can be disabled. */
      }
    }
  }, [accountId, status, preferenceKey, filtersReady]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const activeIdRef = useRef(activeId);
  const viewKey = JSON.stringify({ accountId, status, query, start, end, direction, sort, sortDir, page });
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<"coding" | "matches" | "history">(
    "coding",
  );
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [toolsOpen, setToolsOpen] = useState(Boolean(reconciliationAccountId));
  const [filterOpen, setFilterOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, BankCoding>>({});
  const draftsRef = useRef<Record<string, BankCoding>>({});
  const versions = useRef<Record<string, number>>({});
  const queues = useRef<Record<string, Promise<unknown>>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKinds, setErrorKinds] = useState<
    Record<string, "save" | "post">
  >({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmDoubleCost, setConfirmDoubleCost] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bulkCategory, setBulkCategory] = useState<string | null>(null);
  const [bulkProject, setBulkProject] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const [matchAmounts, setMatchAmounts] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef<string | null>(null);
  const active = rows.find((row) => row.id === activeId);
  const accounts = workspace.accounts.filter((a) => a.active);
  const categories = accounts.map((a) => ({
    id: a.id,
    name: `${a.code} · ${a.name}`,
  }));
  const coding = active ? drafts[active.id] : null;
  const capturedMatch =
    active && detail && active.review_status === "review" && active.matched_cents === 0
      ? capturedExpenseMatch(
          {
            date: active.transaction_date,
            amountCents: active.amount_cents,
            direction: active.direction,
            counterparty: active.merchant_name ?? active.description,
          },
          detail.candidates.map((candidate) => ({
            id: candidate.id,
            availableCents: candidate.availableCents,
            entryDate: candidate.entryDate,
            expense: candidate.expense,
          })),
        )
      : null;
  const capturedExpense = capturedMatch?.expense ?? null;
  const requestPost = (row: BankingTransaction) => {
    if (capturedMatch) setConfirmDoubleCost(true);
    else void post(row, true).catch(() => {});
  };
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const suggestionFor = (transactionId: string) =>
    rows.find((row) => row.id === transactionId)?.reviewSuggestion ??
    suggestions.find((suggestion) => suggestion.transactionId === transactionId);
  const aiSuggestionFor = (transactionId: string) => {
    const row = rows.find((candidate) => candidate.id === transactionId);
    return row ? row.aiSuggestion : suggestionFor(transactionId)?.aiSuggestion;
  };
  const vendorSuggestionFor = (transactionId: string) => {
    const suggestion = suggestionFor(transactionId);
    const ruleVendorId = suggestion?.ruleSuggestion?.vendorId;
    if (ruleVendorId)
      return {
        option: options.vendors.find((vendor) => vendor.id === ruleVendorId) ?? null,
        source: suggestion?.ruleSuggestion?.source ?? "learned_pattern",
      };
    const aiVendorId = suggestion?.best
      ? null
      : aiSuggestionFor(transactionId)?.vendorId;
    return {
      option: options.vendors.find((vendor) => vendor.id === aiVendorId) ?? null,
      source: "ai" as const,
    };
  };
  const categorySuggestionFor = (transactionId: string) => {
    const suggestion = suggestionFor(transactionId);
    if (suggestion?.ruleSuggestion)
      return {
        option: {
          id: suggestion.ruleSuggestion.glAccountId,
          name: `${suggestion.ruleSuggestion.accountCode} · ${suggestion.ruleSuggestion.accountName}`,
        },
        source: suggestion.ruleSuggestion.source,
      };
    const aiAccountId = suggestion?.best
      ? null
      : aiSuggestionFor(transactionId)?.accountId;
    return {
      option: categories.find((category) => category.id === aiAccountId) ?? null,
      source: "ai" as const,
    };
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(0);
    }, 180);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let alive = true;
    loadBankingOptionsAction()
      .then((result) => {
        if (alive && result.success) setOptions(result.data);
        else if (alive && !result.success)
          setError(result.error ?? "Could not load coding options");
      })
      .catch(() => {
        if (alive) setError("Could not load coding options");
      });
    if (canEdit)
      loadBankReviewTrayAction({ bankAccountId: accountId })
        .then((result) => {
          if (alive && result.success) setSuggestions(result.data.rows);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [accountId, canEdit, refreshKey]);
  useEffect(() => {
    if (!filtersReady) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setActiveId(null);
    setInspectorOpen(false);
    Promise.allSettled(Object.values(queues.current))
      .then(() =>
        loadBankingTransactionsAction({
          accountId,
          status,
          search: query,
          start: start || undefined,
          end: end || undefined,
          direction: direction || undefined,
          sort,
          sortDir,
          page,
        }),
      )
      .then((result) => {
        if (!alive) return;
        if (!result.success) {
          setError(result.error ?? "Could not load transactions");
          return;
        }
        setRows(result.data.rows);
        setCount(result.data.count);
        const next: Record<string, BankCoding> = {};
        for (const row of result.data.rows) {
          versions.current[row.id] = row.version;
          loadedStatus.current[row.id] = row.review_status;
          next[row.id] =
            draftsRef.current[row.id] && errors[row.id]
              ? draftsRef.current[row.id]
              : (row.draft ?? {
                  vendorId: null,
                  memo: "",
                  receiptStatus: "missing",
                  learn: false,
                  lines: [
                    {
                      id: crypto.randomUUID(),
                      accountId: null,
                      projectId: null,
                      costCodeId: null,
                      amountCents: row.amount_cents,
                    },
                  ],
                });
        }
        draftsRef.current = { ...draftsRef.current, ...next };
        setDrafts(draftsRef.current);
      })
      .catch(() => {
        if (alive) setError("Connection interrupted. Try again.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Errors deliberately do not refetch the list and overwrite in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accountId,
    status,
    query,
    start,
    end,
    direction,
    sort,
    sortDir,
    page,
    refreshKey,
    filtersReady,
  ]);
  const toggleSort = (next: typeof sort) => {
    setSortDir((current) => (sort === next ? (current === "asc" ? "desc" : "asc") : next === "date" ? "desc" : "asc"));
    setSort(next);
    setPage(0);
  };
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError(null);
    setMatchAmounts({});
    if (!activeId) return;
    setDetailLoading(true);
    loadBankingDetailAction(activeId)
      .then((result) => {
        if (!alive) return;
        if (result.success) setDetail(result.data);
        else setDetailError(result.error ?? "Could not load transaction");
      })
      .catch(() => {
        if (alive) setDetailError("Could not load transaction");
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeId, refreshKey]);

  const enqueue = (id: string, operation: () => Promise<void>) => {
    const task = (queues.current[id] ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    queues.current[id] = task;
    return task;
  };
  const mutate = (
    row: BankingTransaction,
    action: Mutation["action"],
    draft?: BankCoding,
    matches?: Mutation["matches"],
    quiet = false,
    confirmDoubleCost = false,
  ) => {
    const matchedAmount = (matches ?? []).reduce((sum, match) => sum + match.amountCents, 0);
    const optimisticPost = row.review_status === "review" && (
      action === "post" || (action === "match" && row.matched_cents + matchedAmount >= row.amount_cents)
    );
    const rowIndex = rows.findIndex((item) => item.id === row.id);
    const operationViewKey = viewKeyRef.current;
    if (optimisticPost) {
      if (status === "review") {
        setRows((current) => current.filter((item) => item.id !== row.id));
        setCount((current) => Math.max(0, current - 1));
      } else {
        setRows((current) => current.map((item) => item.id === row.id
          ? { ...item, review_status: "posted" as const, matched_cents: row.amount_cents }
          : item));
      }
      setSelected((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      if (activeIdRef.current === row.id) closeInspector();
      setOptions((current) => ({
        ...current,
        counts: bankingOptimisticCounts(current.counts, row.bank_account_id, "post"),
      }));
    }
    return enqueue(row.id, async () => {
      setBusy((current) => new Set(current).add(row.id));
      try {
        const currentDraft = draft ?? draftsRef.current[row.id];
        const coding = currentDraft
          ? codingForTransactionTotal(currentDraft, row.amount_cents)
          : undefined;
        if (coding && (draft !== undefined || coding !== currentDraft)) {
          draftsRef.current = { ...draftsRef.current, [row.id]: coding };
          setDrafts(draftsRef.current);
        }
        const result = await mutateBankingTransactionAction({
          transactionId: row.id,
          version: versions.current[row.id] ?? row.version,
          action,
          coding,
          matches,
          confirmDoubleCost,
        });
        if (!result.success)
          throw new Error(result.error ?? "Could not save transaction");
        versions.current[row.id] = result.data.version;
        setErrors((current) => {
          const next = { ...current };
          delete next[row.id];
          return next;
        });
        setErrorKinds((current) => {
          const next = { ...current };
          delete next[row.id];
          return next;
        });
        setRows((current) =>
          current.map((item) =>
            item.id !== row.id
              ? item
              : {
                  ...item,
                  version: result.data.version,
                  entry_id: result.data.entryId,
                  draft: draftsRef.current[row.id],
                  ...(action === "post"
                    ? {
                        review_status: "posted" as const,
                        matched_cents: row.amount_cents,
                      }
                    : action === "match"
                      ? {
                          review_status:
                            item.matched_cents +
                              (matches ?? []).reduce(
                                (sum, m) => sum + m.amountCents,
                                0,
                              ) >=
                            row.amount_cents
                              ? ("posted" as const)
                              : ("review" as const),
                          matched_cents:
                            item.matched_cents +
                            (matches ?? []).reduce(
                              (sum, m) => sum + m.amountCents,
                              0,
                            ),
                        }
                      : action === "exclude"
                        ? { review_status: "excluded" as const, excluded: true }
                        : action === "undo"
                          ? {
                              review_status: "review" as const,
                              matched_cents: 0,
                              excluded: false,
                            }
                          : {}),
                },
          ),
        );
        if (action !== "save" && !quiet) {
          toast.success(
            action === "undo"
              ? "Returned to review"
              : action === "exclude"
                ? "Transaction excluded"
                : action === "match"
                  ? "Transaction matched"
                  : "Transaction posted",
            action !== "undo"
              ? {
                  action: {
                    label: "Undo",
                    onClick: () => {
                      void mutate(
                        { ...row, version: result.data.version },
                        "undo",
                      ).catch(() => {});
                    },
                  },
                }
              : undefined,
          );
        }
      } catch (error) {
        if (optimisticPost) {
          setOptions((current) => ({
            ...current,
            counts: bankingOptimisticCounts(current.counts, row.bank_account_id, "rollback"),
          }));
          if (viewKeyRef.current === operationViewKey) {
            if (statusRef.current === "review") {
              setRows((current) => {
                if (current.some((item) => item.id === row.id)) return current;
                const next = [...current];
                next.splice(Math.max(0, rowIndex), 0, row);
                return next;
              });
              setCount((current) => current + 1);
            } else {
              setRows((current) => {
                if (statusRef.current === "posted") return current.filter((item) => item.id !== row.id);
                if (current.some((item) => item.id === row.id)) return current.map((item) => item.id === row.id ? row : item);
                return statusRef.current === "all" ? [row, ...current] : current;
              });
            }
          }
        }
        const message =
          error instanceof Error ? error.message : "Could not save";
        setErrors((current) => ({ ...current, [row.id]: message }));
        setErrorKinds((current) => ({
          ...current,
          [row.id]: action === "save" ? "save" : "post",
        }));
        throw error;
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(row.id);
          return next;
        });
      }
    });
  };
  const edit = (row: BankingTransaction, draft: BankCoding) => {
    const normalized = codingForTransactionTotal(draft, row.amount_cents);
    draftsRef.current = { ...draftsRef.current, [row.id]: normalized };
    setDrafts(draftsRef.current);
    void mutate(row, "save", normalized).catch(() => {});
  };
  const editLine = (
    row: BankingTransaction,
    index: number,
    changes: Partial<BankCoding["lines"][number]>,
  ) => {
    const current = draftsRef.current[row.id];
    if (current)
      edit(row, {
        ...current,
        lines: current.lines.map((line, i) =>
          i === index ? { ...line, ...changes } : line,
        ),
      });
  };
  const visible = rows;
  const pageCount = Math.max(1, Math.ceil(count / 50));
  const advance = () => {
    const index = visible.findIndex((row) => row.id === activeId);
    const next = visible
      .slice(index + 1)
      .find((row) => row.review_status === "review")?.id;
    if (next) {
      setActiveId(next);
      setInspectorOpen(true);
    }
    else closeInspector();
  };
  const post = async (
    row: BankingTransaction,
    advanceAfter = false,
    quiet = false,
    confirmDoubleCost = false,
  ) => {
    const postViewKey = viewKeyRef.current;
    const currentDraft = draftsRef.current[row.id];
    const suggestion = suggestionFor(row.id);
    const learned = suggestion?.ruleSuggestion;
    // An existing ledger match is safer and must remain the posting path. AI
    // coding is only a fallback for transactions with no match candidate.
    const ai = suggestion?.best ? null : aiSuggestionFor(row.id);
    // A clean, single-line categorization is enough evidence to reinforce the
    // merchant rule. The service still guards missing merchants and splits.
    const draft = {
      ...currentDraft,
      vendorId: currentDraft.vendorId ?? learned?.vendorId ?? ai?.vendorId ?? null,
      learn: Boolean(
        row.merchant_name &&
        currentDraft.lines.length === 1 &&
        learned?.source !== "manual_rule",
      ),
      lines: currentDraft.lines.map((line, index) =>
        index === 0 && currentDraft.lines.length === 1 && !line.accountId && (learned || ai?.accountId)
          ? {
              ...line,
              accountId: learned?.glAccountId ?? ai?.accountId ?? null,
              projectId: learned?.projectId ?? line.projectId,
              costCodeId: learned?.costCodeId ?? line.costCodeId,
            }
          : line,
      ),
    };
    if (!draft.lines[0]?.accountId && suggestion?.best) {
      if (suggestion.alternatives.length || suggestion.best.confidence < 0.95) {
        setActiveId(row.id);
        setInspectorOpen(true);
        setDetailTab("matches");
        throw new Error("Choose the matching ledger record before posting.");
      }
      await mutate(
        row,
        "match",
        undefined,
        [
          {
            journalLineId: suggestion.best.journalLineId,
            amountCents: row.amount_cents - row.matched_cents,
          },
        ],
        quiet,
      );
    } else {
      const problem = codingProblem(draft, row.amount_cents, accounts);
      if (problem) {
        setErrors((current) => ({ ...current, [row.id]: problem }));
        setErrorKinds((current) => ({ ...current, [row.id]: "post" }));
        setActiveId(row.id);
        setInspectorOpen(true);
        throw new Error(problem);
      }
      await mutate(row, "post", draft, undefined, quiet, confirmDoubleCost);
    }
    if (advanceAfter && viewKeyRef.current === postViewKey) advance();
  };
  const upload = async (
    files: FileList | File[],
    transactionId: string | null,
  ) => {
    if (!canEdit) return;
    setUploading(true);
    let successful = 0;
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.set("file", file);
      if (transactionId) form.set("transactionId", transactionId);
      try {
        const response = await fetch("/api/books/receipts", {
          method: "POST",
          body: form,
        });
        const result = (await response.json()) as {
          success: boolean;
          data?: { fileId?: string };
          error?: string;
        };
        if (!result.success || !result.data?.fileId)
          throw new Error(result.error ?? "Upload failed");
        successful++;
        if (transactionId)
          setRows((current) =>
            current.map((row) =>
              row.id === transactionId
                ? {
                    ...row,
                    receipt_count: row.receipt_count + 1,
                    receipt_file_id: result.data!.fileId!,
                    receipt_file_name: file.name,
                    receipt_mime_type: file.type,
                  }
                : row,
            ),
          );
      } catch (error) {
        toast.error(
          `${file.name}: ${error instanceof Error ? error.message : "Upload failed"}`,
        );
      }
    }
    setUploading(false);
    if (successful)
      toast.success(
        `${successful} receipt${successful === 1 ? "" : "s"} saved`,
      );
    if (transactionId && activeIdRef.current === transactionId) {
      const result = await loadBankingDetailAction(transactionId);
      if (result.success && activeIdRef.current === transactionId)
        setDetail(result.data);
    }
  };
  const chooseFiles = (id: string | null) => {
    uploadTarget.current = id;
    fileInput.current?.click();
  };
  const selectRow = (id: string, checked: boolean, shift = false) => {
    setSelected((current) => {
      const next = new Set(current);
      const anchor = visible.findIndex(
        (row) => row.id === selectionAnchor.current,
      );
      const index = visible.findIndex((row) => row.id === id);
      const targets =
        shift && anchor >= 0
          ? visible
              .slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
              .map((row) => row.id)
          : [id];
      for (const target of targets)
        if (checked) next.add(target);
        else next.delete(target);
      return next;
    });
    selectionAnchor.current = id;
  };
  const bulk = async (action: "post" | "exclude" | "code") => {
    let failed = 0;
    for (const row of visible.filter(
      (row) => selected.has(row.id) && row.review_status === "review",
    )) {
      try {
        if (action === "post") await post(row, false, true);
        else if (action === "exclude")
          await mutate(row, "exclude", undefined, undefined, true);
        else if (bulkCategory) {
          const draft = {
            ...draftsRef.current[row.id],
            lines: [
              {
                id: crypto.randomUUID(),
                accountId: bulkCategory,
                projectId: bulkProject,
                costCodeId: null,
                amountCents: row.amount_cents,
              },
            ],
          };
          draftsRef.current[row.id] = draft;
          setDrafts({ ...draftsRef.current });
          await mutate(row, "save", draft);
        }
      } catch {
        failed++;
      }
    }
    if (failed)
      toast.error(
        `${failed} transactions need another look. Your edits are preserved.`,
      );
    if (!failed) {
      setSelected(new Set());
      toast.success(
        action === "code"
          ? "Coding applied to selected transactions"
          : action === "post"
            ? "Selected transactions posted or matched"
            : "Selected transactions excluded",
      );
    }
  };
  const openRow = (id: string) => {
    setActiveId(id);
    setInspectorOpen(true);
    setDetailTab("coding");
  };
  const closeInspector = () => {
    setInspectorOpen(false);
  };
  const createVendor = async (name: string, row: BankingTransaction) => {
    const result = await createBankingVendorAction(name);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    setOptions((current) => ({
      ...current,
      vendors: [
        ...current.vendors,
        { id: result.data.id, name: result.data.name },
      ],
    }));
    edit(row, { ...draftsRef.current[row.id], vendorId: result.data.id });
  };
  const countFor = (id: string | null) =>
    Math.max(
      0,
      Object.entries(options.counts)
        .filter(
          ([key]) =>
            key.endsWith(":review") && (!id || key.startsWith(`${id}:`)),
        )
        .reduce((sum, [, n]) => sum + n, 0) +
        rows
          .filter((row) => !id || row.bank_account_id === id)
          .reduce(
            (sum, row) =>
              sum +
              Number(row.review_status === "review") -
              Number(loadedStatus.current[row.id] === "review"),
            0,
          ),
    );

  const inspector =
    active && coding ? (
      <div
        className="flex h-full min-h-0 flex-col"
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            canEdit &&
            active.review_status === "review"
          ) {
            event.preventDefault();
            requestPost(active);
          }
        }}
      >
        <div className={cn("shrink-0 border-b px-5", BANKING_INSPECTOR_HEADER_HEIGHT)}>
          <div className="flex h-full items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold tracking-tight">
                  {options.vendors.find((v) => v.id === coding.vendorId)?.name ||
                    "Vendor not selected"}
              </h2>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {date(active.transaction_date)} · {workspace.bankAccounts.find((a) => a.id === active.bank_account_id)?.name}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <p className="font-mono text-base font-semibold tabular-nums">
                {active.direction === "outflow" ? "−" : "+"}
                {money(active.amount_cents, active.currency)}
              </p>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close inspector"
              onClick={closeInspector}
            >
              <X className="size-4" />
            </Button>
            </div>
          </div>
          <span className="sr-only" aria-live="polite">
              {busy.has(active.id)
                ? "Saving…"
                : errors[active.id]
                  ? "Changes need attention"
                  : "Saved"}
          </span>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="space-y-5 p-6">
            {errors[active.id] && (
              <div
                role="alert"
                className="border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {errors[active.id]}
                {errorKinds[active.id] === "save" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void mutate(active, "save").catch(() => {});
                    }}
                  >
                    Retry save
                  </Button>
                )}
              </div>
            )}
            {capturedMatch && capturedExpense && canEdit && (
              <CapturedExpenseBand
                vendorName={capturedExpense.vendorName}
                entryDate={capturedMatch.entryDate}
                homeLabel={capturedExpense.homeLabel}
                receiptFileId={capturedExpense.receiptFileId}
                busy={busy.has(active.id)}
                onMatch={() => {
                  void mutate(active, "match", undefined, [
                    {
                      journalLineId: capturedMatch.id,
                      amountCents: active.amount_cents,
                    },
                  ])
                    .then(() => advance())
                    .catch(() => {});
                }}
              />
            )}
            {(
              <>
                <div>
                  <BankingPicker
                    value={coding.vendorId}
                    options={options.vendors}
                    placeholder={vendorSuggestionFor(active.id).option?.name ?? "Vendor"}
                    suggestedOption={vendorSuggestionFor(active.id).option}
                    suggestionSource={vendorSuggestionFor(active.id).source}
                    disabled={!canEdit || active.review_status !== "review"}
                    onChange={(vendorId) =>
                      edit(active, { ...coding, vendorId })
                    }
                    onCreate={
                      canEdit ? (name) => createVendor(name, active) : undefined
                    }
                    className="border"
                  />
                </div>
                {active.review_status === "review" && categorySuggestionFor(active.id).option && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const suggested = categorySuggestionFor(active.id).option;
                        if (suggested)
                          editLine(active, 0, { accountId: suggested.id });
                      }}
                    >
                      Use suggested category:{" "}
                      {categorySuggestionFor(active.id).option?.name}
                    </Button>
                  )}
                {coding.lines.map((line, index) => (
                  <div key={line.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      {coding.lines.length > 1 ? <span className="text-xs font-medium text-muted-foreground">Split {index + 1}</span> : <span />}
                      {coding.lines.length > 1 &&
                        active.review_status === "review" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove split ${index + 1}`}
                            onClick={() =>
                              edit(active, {
                                ...coding,
                                lines: coding.lines.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                          >
                            <X className="size-3" />
                          </Button>
                        )}
                    </div>
                    <div>
                      <BankingPicker
                        disabled={!canEdit || active.review_status !== "review"}
                        value={line.accountId}
                        options={categories.filter(
                          (a) =>
                            a.id !==
                            workspace.bankAccounts.find(
                              (b) => b.id === active.bank_account_id,
                            )?.gl_account_id,
                        )}
                        placeholder="Choose category"
                        suggestedOption={index === 0 ? categorySuggestionFor(active.id).option : null}
                        suggestionSource={categorySuggestionFor(active.id).source}
                        onChange={(accountId) =>
                          editLine(active, index, { accountId })
                        }
                      />
                    </div>
                    <div>
                      <BankingPicker
                        disabled={!canEdit || active.review_status !== "review"}
                        value={line.projectId}
                        options={options.projects}
                        placeholder="No project"
                        clearLabel="No project"
                        onChange={(projectId) =>
                          editLine(active, index, {
                            projectId,
                            costCodeId: null,
                          })
                        }
                      />
                    </div>
                    <div>
                      <BankingPicker
                        disabled={
                          !canEdit ||
                          active.review_status !== "review" ||
                          !line.projectId
                        }
                        value={line.costCodeId}
                        options={options.costCodes.map((c) => ({
                          id: c.id,
                          name: `${c.code} · ${c.name}`,
                        }))}
                        placeholder="Cost code"
                        onChange={(costCodeId) =>
                          editLine(active, index, { costCodeId })
                        }
                      />
                    </div>
                    {coding.lines.length > 1 && (
                      <div className="grid grid-cols-[1fr_100px] gap-2">
                        <label className="text-xs text-muted-foreground">
                          Amount
                          <Input
                            key={`${line.id}-${line.amountCents}`}
                            aria-label={`Split ${index + 1} amount`}
                            type="number"
                            step="0.01"
                            min="0"
                            disabled={
                              !canEdit || active.review_status !== "review"
                            }
                            defaultValue={(line.amountCents / 100).toFixed(2)}
                            onBlur={(event) => {
                              const amount = Number(event.target.value);
                              if (Number.isFinite(amount))
                                editLine(active, index, {
                                  amountCents: Math.max(
                                    0,
                                    Math.round(amount * 100),
                                  ),
                                });
                            }}
                          />
                        </label>
                        <label className="text-xs text-muted-foreground">
                          Percent
                          <Input
                            key={`${line.id}-percent-${line.amountCents}`}
                            aria-label={`Split ${index + 1} percent`}
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            disabled={
                              !canEdit || active.review_status !== "review"
                            }
                            defaultValue={(
                              (line.amountCents / active.amount_cents) *
                              100
                            ).toFixed(2)}
                            onBlur={(event) => {
                              const percent = Number(event.target.value);
                              if (
                                Number.isFinite(percent) &&
                                percent >= 0 &&
                                percent <= 100
                              )
                                editLine(active, index, {
                                  amountCents: Math.round(
                                    (active.amount_cents * percent) / 100,
                                  ),
                                });
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                ))}
                {canEdit && active.review_status === "review" && coding.lines.length > 1 && (
                  <div className="flex items-center justify-between">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const allocated = coding.lines.reduce(
                          (sum, line) => sum + line.amountCents,
                          0,
                        );
                        const firstSplit = coding.lines.length === 1;
                        const firstAmount = firstSplit
                          ? Math.ceil(active.amount_cents / 2)
                          : coding.lines[0]?.amountCents;
                        const nextLines = firstSplit
                          ? [
                              { ...coding.lines[0], amountCents: firstAmount },
                              {
                                id: crypto.randomUUID(),
                                accountId: null,
                                projectId: null,
                                costCodeId: null,
                                amountCents: active.amount_cents - firstAmount,
                              },
                            ]
                          : [
                              ...coding.lines,
                              {
                                id: crypto.randomUUID(),
                                accountId: null,
                                projectId: null,
                                costCodeId: null,
                                amountCents: Math.max(
                                  0,
                                  active.amount_cents - allocated,
                                ),
                              },
                            ];
                        edit(active, {
                          ...coding,
                          lines: nextLines,
                        });
                      }}
                    >
                      <Plus className="mr-1 size-3" />
                      Split transaction
                    </Button>
                  </div>
                )}
                {coding.lines.length > 1 && (
                  <div className="relative grid grid-cols-3 border bg-muted/30 px-3 py-2 text-xs tabular-nums">
                    <span>
                      <span className="block text-muted-foreground">Total</span>
                      {money(active.amount_cents, active.currency)}
                    </span>
                    <span className="text-center">
                      <span className="block text-muted-foreground">Allocated</span>
                      {money(coding.lines.reduce((sum, line) => sum + line.amountCents, 0), active.currency)}
                    </span>
                    <span className={cn(
                      "text-right",
                      coding.lines.reduce((sum, line) => sum + line.amountCents, 0) !== active.amount_cents && "text-warning",
                    )}>
                      <span className="block text-muted-foreground">Remaining</span>
                      {money(active.amount_cents - coding.lines.reduce((sum, line) => sum + line.amountCents, 0), active.currency)}
                    </span>
                    {canEdit &&
                      active.review_status === "review" &&
                      active.amount_cents >
                        coding.lines.reduce(
                          (sum, line) => sum + line.amountCents,
                          0,
                        ) && (
                        <Button
                          variant="link"
                          size="sm"
                          className="col-span-3 mt-1 h-auto justify-end p-0 text-xs"
                          onClick={() => {
                            const remaining =
                              active.amount_cents -
                              coding.lines.reduce(
                                (sum, line) => sum + line.amountCents,
                                0,
                              );
                            editLine(active, coding.lines.length - 1, {
                              amountCents: Math.max(
                                0,
                                coding.lines[coding.lines.length - 1]
                                  .amountCents + remaining,
                              ),
                            });
                          }}
                        >
                          Apply remainder to last split
                        </Button>
                      )}
                  </div>
                )}
                <div>
                  <label
                    htmlFor="bank-memo"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Memo
                  </label>
                  <Input
                    id="bank-memo"
                    key={active.id}
                    className="mt-1"
                    maxLength={200}
                    defaultValue={coding.memo}
                    disabled={!canEdit || active.review_status !== "review"}
                    placeholder="Add context for your team"
                    onBlur={(e) => {
                      if (e.target.value !== coding.memo)
                        edit(active, {
                          ...draftsRef.current[active.id],
                          memo: e.target.value,
                        });
                    }}
                  />
                </div>
                {canEdit && active.review_status === "review" && coding.lines.length === 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const firstAmount = Math.ceil(active.amount_cents / 2);
                      edit(active, {
                        ...coding,
                        lines: [
                          { ...coding.lines[0], amountCents: firstAmount },
                          {
                            id: crypto.randomUUID(),
                            accountId: null,
                            projectId: null,
                            costCodeId: null,
                            amountCents: active.amount_cents - firstAmount,
                          },
                        ],
                      });
                    }}
                  >
                    <Plus className="mr-1 size-3" />
                    Split transaction
                  </Button>
                )}
                <div className="bg-muted/40 p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Original bank description
                  </p>
                  <p className="mt-1 break-words text-sm">
                    {active.description}
                  </p>
                </div>
                {active.entry_id && (
                  <Link
                    className="text-sm text-primary hover:underline"
                    href={`/books/ledger?entry=${active.entry_id}`}
                  >
                    View posted journal →
                  </Link>
                )}
              </>
            )}
            <div className="grid grid-cols-2 gap-2 border-t pt-4">
              <Button
                variant={detailTab === "matches" ? "secondary" : "ghost"}
                size="sm"
                onClick={() =>
                  setDetailTab(detailTab === "matches" ? "coding" : "matches")
                }
              >
                Matching
              </Button>
              <Button
                variant={detailTab === "history" ? "secondary" : "ghost"}
                size="sm"
                onClick={() =>
                  setDetailTab(detailTab === "history" ? "coding" : "history")
                }
              >
                Activity
              </Button>
            </div>
            {detailLoading && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading details…
              </p>
            )}
            {detailError && (
              <p role="alert" className="text-sm text-destructive">
                {detailError}
              </p>
            )}
            {detailTab === "matches" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Link existing ledger activity. Select several records for a
                  grouped deposit, or enter a partial amount.
                </p>
                {detail?.candidatesTruncated && (
                  <p className="text-xs text-warning">
                    Showing 500 candidate lines. Use the ledger to locate older
                    activity.
                  </p>
                )}
                {detail?.candidates.map((candidate) => {
                  const entry = relation(candidate.entry);
                  return (
                    <div key={candidate.id} className="border p-3">
                      <div className="flex justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">
                            {candidate.description ||
                              entry?.memo ||
                              "Ledger entry"}
                          </p>
                          {candidate.expense && (
                            <p className="mt-1 text-xs font-medium text-primary">
                              {capturedExpenseLabel(candidate.expense)}
                              {candidate.expense.hasReceipt ? "" : " · no receipt"}
                            </p>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {entry?.entry_date}
                          </p>
                        </div>
                        <span className="font-mono text-sm">
                          {money(candidate.availableCents, active.currency)}
                        </span>
                      </div>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        max={candidate.availableCents / 100}
                        className="mt-2"
                        aria-label={`Match amount for ${candidate.description || candidate.id}`}
                        placeholder="Amount to match"
                        value={matchAmounts[candidate.id] ?? ""}
                        onChange={(e) =>
                          setMatchAmounts((current) => ({
                            ...current,
                            [candidate.id]: e.target.value,
                          }))
                        }
                        disabled={!canEdit || active.review_status !== "review"}
                      />
                    </div>
                  );
                })}
                {detail && !detail.candidates.length && (
                  <p className="text-sm text-muted-foreground">
                    No available ledger lines for this account.
                  </p>
                )}
                {canEdit && active.review_status === "review" && (
                  <Button
                    disabled={
                      !Object.values(matchAmounts).some((v) => Number(v) > 0) ||
                      busy.has(active.id)
                    }
                    onClick={() => {
                      const matches = Object.entries(matchAmounts)
                        .filter(([, v]) => Number(v) > 0)
                        .map(([journalLineId, v]) => ({
                          journalLineId,
                          amountCents: Math.round(Number(v) * 100),
                        }));
                      void mutate(active, "match", undefined, matches)
                        .then(() => advance())
                        .catch(() => {});
                    }}
                  >
                    Match{" "}
                    {money(
                      Object.values(matchAmounts).reduce(
                        (sum, v) => sum + Math.round(Number(v) * 100),
                        0,
                      ),
                      active.currency,
                    )}
                  </Button>
                )}
              </>
            )}
            {detailTab === "history" && (
              <>
                {detail?.history.map((item) => (
                  <div key={item.id} className="border-l-2 pl-4">
                    <p className="text-sm font-medium">
                      {String(item.after?.action ?? item.action)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.source}
                    </p>
                  </div>
                ))}
                {detail && !detail.history.length && (
                  <p className="text-sm text-muted-foreground">
                    No review activity yet.
                  </p>
                )}
              </>
            )}
          </div>
          {(
            <div
              className="space-y-3 border-t p-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Receipts</h3>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={uploading}
                    onClick={() => chooseFiles(active.id)}
                  >
                    <Plus className="mr-1 size-3" />
                    Add receipt
                  </Button>
                )}
              </div>
              {!active.receipt_count && (
                <Attachment
                  state={uploading ? "uploading" : "idle"}
                  className="w-full cursor-pointer p-3"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void upload(e.dataTransfer.files, active.id);
                  }}
                  onClick={() => canEdit && chooseFiles(active.id)}
                >
                  <AttachmentMedia variant="icon">
                    {uploading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Paperclip className="size-4" />
                    )}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>
                      {uploading ? "Uploading receipt…" : "Drop or attach a receipt"}
                    </AttachmentTitle>
                    <AttachmentDescription>PDF or image · up to 20 MB</AttachmentDescription>
                  </AttachmentContent>
                </Attachment>
              )}
              {detail?.receipts.map((receipt) => {
                const file = relation(receipt.files);
                const previewFile: FileWithDetails | null = file
                  ? {
                      ...file,
                      download_url: `/api/files/${file.id}/raw`,
                      thumbnail_url: `/api/files/${file.id}/preview`,
                    }
                  : null;
                return (
                <Attachment
                  key={receipt.id}
                  role="button"
                  tabIndex={previewFile ? 0 : -1}
                  aria-label={`Preview ${file?.file_name || "receipt"}`}
                  className="group w-full cursor-pointer rounded-none pr-2 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    if (!previewFile) return;
                    setViewerFile(previewFile);
                    setViewerOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      previewFile &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      setViewerFile(previewFile);
                      setViewerOpen(true);
                    }
                  }}
                >
                  <AttachmentMedia variant="icon">
                    <FileText className="size-4" />
                  </AttachmentMedia>
                  <AttachmentContent className="min-w-0 flex-1 overflow-hidden pr-3">
                    <AttachmentTitle className="block max-w-full truncate">
                      {file?.file_name || "Receipt"}
                    </AttachmentTitle>
                  </AttachmentContent>
                  <AttachmentActions>
                    {canEdit && (
                      <AttachmentAction
                        aria-label="Detach receipt"
                        onClick={async (event) => {
                          event.stopPropagation();
                          const result = await linkBankingReceiptAction({
                            receiptId: receipt.id,
                            transactionId: null,
                          });
                          if (!result.success) {
                            toast.error(result.error);
                            return;
                          }
                          setDetail((current) =>
                            current
                              ? {
                                  ...current,
                                  receipts: current.receipts.filter(
                                    (r) => r.id !== receipt.id,
                                  ),
                                }
                              : null,
                          );
                          setRows((current) =>
                            current.map((row) =>
                              row.id === active.id
                                ? {
                                    ...row,
                                    receipt_count: Math.max(
                                      0,
                                      row.receipt_count - 1,
                                    ),
                                    ...(row.receipt_file_id === receipt.file_id
                                      ? {
                                          receipt_file_id: null,
                                          receipt_file_name: null,
                                          receipt_mime_type: null,
                                        }
                                      : {}),
                                  }
                                : row,
                            ),
                          );
                        }}
                      >
                        <X className="size-3" />
                      </AttachmentAction>
                    )}
                  </AttachmentActions>
                </Attachment>
              );})}
              {!active.receipt_count && (
                <BankingPicker
                  disabled={!canEdit}
                  value={coding.receiptStatus}
                  options={[
                    { id: "missing", name: "Missing receipt" },
                    { id: "requested", name: "Requested outside Arc" },
                    { id: "not_required", name: "Receipt not required" },
                  ]}
                  placeholder="Receipt status"
                  onChange={(value) =>
                    edit(active, {
                      ...coding,
                      receiptStatus: (value ||
                        "missing") as BankCoding["receiptStatus"],
                    })
                  }
                />
              )}
            </div>
          )}
        </div>
        {canEdit && (
          <div className={cn("flex shrink-0 items-center justify-between gap-3 border-t bg-background px-6", BANKING_FOOTER_HEIGHT)}>
            {active.review_status === "review" ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void mutate(active, "exclude")
                      .then(advance)
                      .catch(() => {});
                  }}
                >
                  Exclude
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={advance}>
                    Skip
                  </Button>
                  <Button
                    disabled={busy.has(active.id)}
                    onClick={() => {
                      requestPost(active);
                    }}
                  >
                    {busy.has(active.id) ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : null}
                    {!coding.lines[0]?.accountId &&
                    suggestions.find((s) => s.transactionId === active.id)?.best
                      ? "Match"
                      : "Post"}{" "}
                    & next <span className="ml-3 text-xs opacity-60">⌘↵</span>
                  </Button>
                </div>
              </>
            ) : active.review_status !== "pending" ? (
              <Button
                variant="outline"
                disabled={busy.has(active.id)}
                onClick={() => {
                  void mutate(active, "undo").catch(() => {});
                }}
              >
                Return to review
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Waiting for the bank to settle this transaction.
              </p>
            )}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      onDragOver={(e) => {
        if (inspectorOpen && activeId && e.dataTransfer.types.includes("Files"))
          e.preventDefault();
      }}
      onDrop={(e) => {
        if (!inspectorOpen || !activeId) return;
        e.preventDefault();
        if (canEdit) void upload(e.dataTransfer.files, activeId);
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length && canEdit && inspectorOpen && activeId) {
          e.preventDefault();
          void upload(files, activeId);
        }
      }}
      onKeyDown={(e) => {
        if (
          e.key === "/" &&
          !(e.target instanceof HTMLInputElement) &&
          !(e.target instanceof HTMLTextAreaElement)
        ) {
          e.preventDefault();
          e.stopPropagation();
          searchInput.current?.focus();
        }
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files, uploadTarget.current);
          e.target.value = "";
        }}
      />
      <div className="flex shrink-0 flex-col gap-3 px-6 pb-6 pt-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div
            className="-mx-1 flex gap-3 overflow-x-auto px-1 py-1.5"
            role="group"
            aria-label="Bank accounts"
          >
            {workspace.bankAccounts.map((account) => {
              const connection = relation(account.connection);
              const institution = connection?.institution_name;
              return (
                <BankingAccountCard
                  key={account.id}
                  account={account}
                  institution={institution}
                  connectionStatus={connection?.status}
                  connectionError={connection?.last_error}
                  reviewCount={countFor(account.id)}
                  selected={accountId === account.id}
                  onSelect={() => {
                    setAccountId((current) =>
                      current === account.id ? null : account.id,
                    );
                    setPage(0);
                  }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <BankingSyncControl
            key={workspace.settings?.org_id}
            initialLastSyncedAt={workspace.bankAccounts.reduce<string | null>(
              (latest, account) => {
                const refreshedAt = relation(account.connection)?.last_refresh_at;
                return latestBankSync(latest, refreshedAt ?? null);
              },
              null,
            )}
            canEdit={canEdit}
            onRefresh={refresh}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Manage banking"
            onClick={() => setToolsOpen(true)}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </div>
      <UnstatementedExpenses refreshKey={refreshKey} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-y px-6">
        <div
          className="flex"
          role="tablist"
          aria-label="Bank transaction status"
        >
          {(
            [
              { id: "all", label: "All" },
              { id: "review", label: "For review" },
              { id: "posted", label: "Posted" },
              { id: "excluded", label: "Excluded" },
              { id: "pending", label: "Bank pending" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={status === tab.id}
              onClick={() => {
                setStatus(tab.id);
                setPage(0);
              }}
              className={cn(
                "relative px-3 py-3 text-sm",
                status === tab.id
                  ? "font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {status === tab.id ? (
                <motion.span
                  layoutId="banking-status-underline"
                  className="absolute inset-x-2 bottom-0 h-0.5 bg-primary"
                  transition={reducedMotion ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.24 }}
                />
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 py-1.5">
          <div className="relative w-60 max-w-[45vw]">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              ref={searchInput}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search transactions"
              className="h-9 bg-muted/25 pl-8 text-sm"
              aria-label="Search transactions"
            />
          </div>
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Filter transactions"
                className={cn(
                  "size-9",
                  (start || end || direction) && "bg-primary/10 text-primary",
                )}
              >
                <SlidersHorizontal className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-3 p-4">
              <p className="text-sm font-medium">Filter transactions</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-muted-foreground">
                  From
                  <Input
                    type="date"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Through
                  <Input
                    type="date"
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
              </div>
              <div className="w-40">
                <BankingPicker
                  value={direction || null}
                  options={[
                    { id: "inflow", name: "Money in" },
                    { id: "outflow", name: "Money out" },
                  ]}
                  placeholder="All directions"
                  onChange={(value) => {
                    setDirection((value || "") as typeof direction);
                    setPage(0);
                  }}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="px-0"
                onClick={() => {
                  setStart("");
                  setEnd("");
                  setDirection("");
                  setPage(0);
                }}
              >
                Reset filters
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-auto pb-40 sm:pb-24">
            {error ? (
              <div role="alert" className="p-12 text-center">
                <p className="text-sm text-destructive">{error}</p>
                <Button className="mt-3" variant="outline" onClick={refresh}>
                  Try again
                </Button>
              </div>
            ) : (
              <table className="w-full min-w-[960px] shrink-0 text-sm">
                <thead className="sticky top-0 z-20 border-b bg-muted text-xs text-muted-foreground [&_th]:bg-muted">
                  <tr className={BANKING_TABLE_HEADER_HEIGHT}>
                    <th className="w-10 px-4 py-3">
                      {canEdit && (
                        <Checkbox
                          aria-label="Select transactions on this page"
                          className="rounded-none"
                          checked={
                            visible.some(
                              (row) => row.review_status === "review",
                            ) &&
                            visible
                              .filter((r) => r.review_status === "review")
                              .every((r) => selected.has(r.id))
                          }
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked
                                ? new Set(
                                    visible
                                      .filter(
                                        (r) => r.review_status === "review",
                                      )
                                      .map((r) => r.id),
                                  )
                                : new Set(),
                            )
                          }
                        />
                      )}
                    </th>
                    <th aria-sort={sort === "date" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="px-2 py-3 text-left font-medium">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("date")}>Date {sort === "date" ? (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}</button>
                    </th>
                    <th aria-sort={sort === "description" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="w-[18%] px-2 py-3 text-left font-medium">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("description")}>Description {sort === "description" ? (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}</button>
                    </th>
                    <th aria-sort={sort === "amount" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="px-3 py-3 text-right font-medium">
                      <button type="button" aria-label="Sort by amount size" title="Sort by amount size" className="ml-auto inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("amount")}>Amount {sort === "amount" ? (sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}</button>
                    </th>
                    <th className="w-[18%] px-2 py-3 text-left font-medium">
                      Vendor
                    </th>
                    <th className="w-[20%] px-2 py-3 text-left font-medium">
                      Category or match
                    </th>
                    <th className="w-[14%] px-2 py-3 text-left font-medium">
                      Project
                    </th>
                    <th className="px-2 py-3 text-left font-medium">
                      Attachments
                    </th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {loading
                    ? Array.from({ length: 7 }, (_, i) => (
                        <tr key={i} className={BANKING_TRANSACTION_ROW_HEIGHT}>
                          <td colSpan={9} className="px-6 py-4">
                            <div className="skeleton-shimmer relative h-7 overflow-hidden bg-muted/60 motion-reduce:after:animate-none" />
                          </td>
                        </tr>
                      ))
                    : visible.map((row) => {
                        const draft = drafts[row.id];
                        const suggestion = suggestions.find(
                          (s) => s.transactionId === row.id,
                        );
                        const editable =
                          canEdit && row.review_status === "review";
                        return (
                          <tr
                            key={row.id}
                            tabIndex={0}
                            aria-label={`Open transaction: ${row.description}`}
                            onClick={(event) => {
                              const target = event.target as HTMLElement;
                              if (
                                target.closest(
                                  "button, a, input, [role='button'], [role='checkbox'], [role='combobox'], [data-radix-popper-content-wrapper]",
                                )
                              )
                                return;
                              openRow(row.id);
                            }}
                            onKeyDown={(event) => {
                              if (
                                event.currentTarget === event.target &&
                                (event.key === "Enter" || event.key === " ")
                              ) {
                                event.preventDefault();
                                openRow(row.id);
                              }
                            }}
                            className={cn(
                              BANKING_TRANSACTION_ROW_HEIGHT,
                              "group cursor-pointer transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                              inspectorOpen && activeId === row.id && "bg-primary/5",
                              selected.has(row.id) && "bg-primary/5",
                            )}
                          >
                            <td className="px-4">
                              {editable ? (
                                <Checkbox
                                  aria-label={`Select ${row.merchant_name || row.description}`}
                                  checked={selected.has(row.id)}
                                  className="rounded-none"
                                  onClick={(e) => {
                                    if (e.shiftKey) {
                                      e.preventDefault();
                                      selectRow(row.id, !selected.has(row.id), true);
                                      return;
                                    }
                                    selectionAnchor.current = e.shiftKey
                                      ? selectionAnchor.current
                                      : row.id;
                                  }}
                                  onCheckedChange={(checked) =>
                                    selectRow(
                                      row.id,
                                      Boolean(checked),
                                      false,
                                    )
                                  }
                                />
                              ) : (
                                <Check
                                  className={cn(
                                    "size-3.5 text-muted-foreground",
                                    row.review_status === "posted" &&
                                      "text-success",
                                  )}
                                />
                              )}
                            </td>
                            <td className="whitespace-nowrap px-2 py-4 text-sm text-muted-foreground">
                              {date(row.transaction_date)}
                            </td>
                            <td className="max-w-64 px-2 py-3">
                              <div className="min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => openRow(row.id)}
                                    className="block w-full truncate text-left text-sm hover:text-foreground focus-visible:outline-ring"
                                    aria-label={`Open transaction: ${row.description}`}
                                  >
                                    {row.description}
                                  </button>
                              </div>
                              {errors[row.id] && (
                                <button
                                  className="mt-1 text-left text-xs text-destructive"
                                  onClick={() => openRow(row.id)}
                                >
                                  Changes need attention
                                </button>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 text-right font-mono tabular-nums">
                              <span
                                className={cn(
                                  row.direction === "inflow" && "text-success",
                                )}
                              >
                                {row.direction === "outflow" ? "−" : "+"}
                                {money(row.amount_cents, row.currency)}
                              </span>
                            </td>
                            <td className="max-w-56 px-1">
                              <div className="flex items-center gap-2">
                                {draft?.vendorId ? (
                                  <VendorMark
                                    name={
                                      options.vendors.find(
                                        (v) => v.id === draft.vendorId,
                                      )?.name || "Vendor"
                                    }
                                    logoUrl={
                                      normalizedIdentity(options.vendors.find((v) => v.id === draft.vendorId)?.name) === normalizedIdentity(row.merchant_name)
                                        ? row.merchant_logo_url
                                        : null
                                    }
                                  />
                                ) : <VendorMark name="?" />}
                                <BankingPicker
                                  disabled={!editable}
                                  value={draft?.vendorId ?? null}
                                  options={options.vendors}
                                  placeholder={vendorSuggestionFor(row.id).option?.name ?? "Choose vendor"}
                                  suggestedOption={vendorSuggestionFor(row.id).option}
                                  suggestionSource={vendorSuggestionFor(row.id).source}
                                  clearLabel="No vendor"
                                  onChange={(vendorId) =>
                                    draft && edit(row, { ...draft, vendorId })
                                  }
                                  onCreate={
                                    editable
                                      ? (name) => createVendor(name, row)
                                      : undefined
                                  }
                                  className="min-h-8 px-1"
                                />
                              </div>
                            </td>
                            <td className="px-1">
                              {draft?.lines.length > 1 ? (
                                <button
                                  className="px-2 text-sm text-primary"
                                  onClick={() => openRow(row.id)}
                                >
                                  Split · {draft.lines.length} categories
                                </button>
                              ) : suggestion?.best &&
                                !draft?.lines[0]?.accountId &&
                                row.review_status === "review" ? (
                                <button
                                  className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-muted"
                                  onClick={() => {
                                    openRow(row.id);
                                    setDetailTab("matches");
                                  }}
                                >
                                  <span className="flex size-6 items-center justify-center rounded-full bg-success/10">
                                    <Check className="size-3 text-success" />
                                  </span>
                                  <span>
                                    <span className="block text-xs font-medium">
                                      {suggestion.alternatives.length
                                        ? "Possible matches"
                                        : "Match found"}
                                    </span>
                                    <span className="block max-w-44 truncate text-[11px] text-muted-foreground">
                                      {suggestion.best.journalDescription ||
                                        "Same amount and account"}
                                    </span>
                                  </span>
                                </button>
                              ) : (
                                <BankingPicker
                                  disabled={!editable}
                                  value={draft?.lines[0]?.accountId ?? null}
                                  options={categories.filter(
                                    (a) =>
                                      a.id !==
                                      workspace.bankAccounts.find(
                                        (b) => b.id === row.bank_account_id,
                                      )?.gl_account_id,
                                  )}
                                  placeholder={
                                    categorySuggestionFor(row.id).option
                                      ? categorySuggestionFor(row.id).option?.name
                                      : row.review_status === "posted"
                                        ? "Matched to ledger"
                                        : "Choose category"
                                  }
                                  suggestedOption={categorySuggestionFor(row.id).option}
                                  suggestionSource={categorySuggestionFor(row.id).source}
                                  onChange={(accountId) =>
                                    editLine(row, 0, { accountId })
                                  }
                                />
                              )}
                            </td>
                            <td className="px-1">
                              <BankingPicker
                                disabled={
                                  !editable || !draft || draft.lines.length > 1
                                }
                                value={draft?.lines[0]?.projectId ?? null}
                                options={options.projects}
                                placeholder="No project"
                                clearLabel="No project"
                                onChange={(projectId) =>
                                  editLine(row, 0, {
                                    projectId,
                                    costCodeId: null,
                                  })
                                }
                              />
                            </td>
                            <td className="px-2">
                              <BankingReceiptCell
                                transactionId={row.id}
                                receiptCount={row.receipt_count}
                                receiptFileId={row.receipt_file_id}
                                receiptFileName={row.receipt_file_name}
                                receiptMimeType={row.receipt_mime_type}
                                receiptStatus={draft?.receiptStatus}
                                canEdit={canEdit}
                                canEditMemo={editable}
                                memo={draft?.memo ?? ""}
                                onMemoChange={(memo) =>
                                  draft && edit(row, { ...draft, memo })
                                }
                                onOpen={() => openRow(row.id)}
                                onReceiptUploaded={(receipt) => {
                                  setRows((current) =>
                                    current.map((item) =>
                                      item.id === row.id
                                        ? {
                                            ...item,
                                            receipt_count:
                                              item.receipt_count + 1,
                                            receipt_file_id: receipt.fileId,
                                            receipt_file_name: receipt.fileName,
                                            receipt_mime_type: receipt.mimeType,
                                          }
                                        : item,
                                    ),
                                  );
                                  if (activeIdRef.current === row.id) {
                                    void loadBankingDetailAction(row.id).then(
                                      (result) => {
                                        if (
                                          result.success &&
                                          activeIdRef.current === row.id
                                        )
                                          setDetail(result.data);
                                      },
                                    );
                                  }
                                }}
                              />
                            </td>
                            <td className="px-4">
                              {editable ? (
                                <div className="inline-flex">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-r-none border-r-0"
                                    disabled={busy.has(row.id)}
                                    onClick={() =>
                                      void post(row).catch(() => {})
                                    }
                                  >
                                    {busy.has(row.id) ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : suggestion?.best &&
                                      !draft?.lines[0]?.accountId ? (
                                      "Match"
                                    ) : (
                                      "Post"
                                    )}
                                  </Button>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="rounded-l-none px-2"
                                        disabled={busy.has(row.id)}
                                        aria-label="More posting actions"
                                      >
                                        <ChevronDown className="size-3" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onSelect={() => openRow(row.id)}
                                      >
                                        Review details
                                      </DropdownMenuItem>
                                      {suggestion?.best ? (
                                        <DropdownMenuItem
                                          onSelect={() => {
                                            openRow(row.id);
                                            setDetailTab("matches");
                                          }}
                                        >
                                          Review matches
                                        </DropdownMenuItem>
                                      ) : null}
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          void mutate(row, "exclude").catch(
                                            () => {},
                                          )
                                        }
                                      >
                                        Exclude transaction
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              ) : (
                                <button
                                  className="text-xs capitalize text-muted-foreground"
                                  onClick={() => openRow(row.id)}
                                >
                                  {row.review_status}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            )}
            {!loading && !error && !visible.length && (
              <div className="flex flex-1 items-center justify-center px-6 py-10 text-center">
                <div>
                  <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
                    <Check className="size-5 text-muted-foreground" />
                  </div>
                  <h2 className="mt-4 text-base font-semibold">
                    {status === "review" && !query
                      ? "You’re all caught up"
                      : "No transactions in this view"}
                  </h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                    {workspace.bankAccounts.length
                      ? "Change your filters or choose another account."
                      : "Connect your company’s bank accounts and cards, or import a statement to get started."}
                  </p>
                  {!workspace.bankAccounts.length && canEdit && (
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={() => setToolsOpen(true)}
                    >
                      Import a statement
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          {canEdit ? (
            <BankingBulkIsland
              count={selected.size}
              category={bulkCategory}
              project={bulkProject}
              categories={workspace.accounts
                .filter((account) => account.active && account.account_type !== "cogs")
                .map((account) => ({ id: account.id, name: `${account.code} · ${account.name}` }))}
              projects={options.projects}
              busy={busy.size > 0}
              onCategoryChange={setBulkCategory}
              onProjectChange={setBulkProject}
              onApply={() => void bulk("code")}
              onPost={() => void bulk("post")}
              onExclude={() => void bulk("exclude")}
              onClear={() => setSelected(new Set())}
            />
          ) : null}
          <footer className={cn("flex shrink-0 items-center justify-end border-t px-6 text-xs text-muted-foreground", BANKING_FOOTER_HEIGHT)}>
            <nav
              className="flex items-center gap-1"
              aria-label="Transaction pages"
            >
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous page"
                disabled={!page || loading || busy.size > 0}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              {bankingPaginationItems(page, pageCount).map((item, index) =>
                item === "ellipsis" ? (
                  <span
                    key={`ellipsis-${index}`}
                    className="w-7 text-center"
                    aria-hidden="true"
                  >
                    …
                  </span>
                ) : (
                  <Button
                    key={item}
                    variant={item === page ? "secondary" : "ghost"}
                    size="icon"
                    className="size-8 text-xs tabular-nums"
                    aria-label={`Page ${item + 1}`}
                    aria-current={item === page ? "page" : undefined}
                    disabled={loading || busy.size > 0}
                    onClick={() => setPage(item)}
                  >
                    {item + 1}
                  </Button>
                ),
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next page"
                disabled={(page + 1) * 50 >= count || loading || busy.size > 0}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </nav>
          </footer>
        </div>
        <AnimatePresence initial={false}>
          {active && inspectorOpen && wide && (
            <motion.aside
              key="banking-inspector"
              aria-label="Transaction inspector"
              initial={reducedMotion ? false : { width: 0, opacity: 0, x: 24 }}
              animate={{ width: 440, opacity: 1, x: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { width: 0, opacity: 0, x: 24 }}
              transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="hidden h-full min-h-0 shrink-0 self-stretch overflow-hidden border-l xl:block"
            >
              <div className="h-full w-[440px]">{inspector}</div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      {active && !wide && (
        <div className="xl:hidden">
          <Sheet
            open={inspectorOpen}
            onOpenChange={(open) => {
              if (!open) closeInspector();
            }}
          >
            <SheetContent
              aria-describedby={undefined}
              className="w-full p-0 sm:max-w-xl xl:hidden [&>button]:hidden"
            >
              <SheetTitle className="sr-only">Transaction inspector</SheetTitle>
              {inspector}
            </SheetContent>
          </Sheet>
        </div>
      )}
      <RecordCostTwiceConfirm
        open={confirmDoubleCost}
        onOpenChange={setConfirmDoubleCost}
        onConfirm={() => {
          if (active) void post(active, true, false, true).catch(() => {});
        }}
      />
      <FileViewer
        file={viewerFile}
        files={viewerFile ? [viewerFile] : []}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
      />
      <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
        <SheetContent
          aria-describedby={undefined}
          className="flex w-full flex-col overflow-hidden border-l bg-background p-0 sm:max-w-[600px]"
        >
          <div className="shrink-0 border-b px-5 py-4">
            <SheetTitle className="text-base tracking-tight">Manage banking</SheetTitle>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            {management}
            <BankingRules
              active={toolsOpen}
              canEdit={canEdit}
              categories={categories.filter((category) => workspace.accounts.find((account) => account.id === category.id)?.account_type !== "cogs")}
              vendors={options.vendors}
              bankAccounts={workspace.bankAccounts.map(({ id, name }) => ({ id, name }))}
              onChanged={refresh}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
