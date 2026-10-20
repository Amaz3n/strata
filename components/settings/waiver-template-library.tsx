"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { usePageTitle } from "@/components/layout/page-title-context";
import { isTradeSurface } from "@/lib/workspace-surface";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Loader2,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  emptyWaiverTemplate,
  waiverTemplateSchema,
  type CompanyWaiverTemplate,
  type WaiverTemplateDraft,
} from "@/lib/templates/waiver-template";
import {
  documentFromBody,
  newWaiverBlock,
  documentText,
} from "@/lib/templates/waiver-document";
import {
  saveCompanyWaiverTemplate,
  archiveCompanyWaiverTemplate,
  beginCompanyWaiverImport,
  getCompanyWaiverImport,
} from "@/app/(app)/settings/templates/waiver-actions";
import {
  replaceWaiverDocument,
  waiverReviewGroups,
  waiverActivationReviewMessage,
} from "@/lib/templates/waiver-setup";
import { WaiverSetupWorkspace } from "./waiver-setup-workspace";
const Preview = dynamic(() => import("./waiver-template-live-preview"), {
  ssr: false,
});
const Original = dynamic(
  () =>
    import("@/components/invoices/waiver-pdf-preview").then(
      (m) => m.WaiverPdfPreview,
    ),
  { ssr: false },
);
const types = {
  conditional_progress: "Conditional · Progress",
  conditional_final: "Conditional · Final",
  unconditional_progress: "Unconditional · Progress",
  unconditional_final: "Unconditional · Final",
};
const selectClass = "h-10 w-full border bg-background px-3 text-sm";
const defaultRules = {
  enabled: true,
  projectIds: [] as string[],
  customerName: "",
  signerName: "",
  signerTitle: "Authorized representative",
};
export function WaiverTemplateLibrary({
  initialTemplates,
  canManage,
  projects = [],
  orgId,
}: {
  initialTemplates: CompanyWaiverTemplate[];
  canManage: boolean;
  projects?: { id: string; name: string }[];
  orgId: string;
}) {
  const trade = isTradeSurface(usePageTitle().workspaceSurface);
  const [library, setLibrary] = useState({
    source: initialTemplates,
    templates: initialTemplates,
  });
  if (library.source !== initialTemplates) {
    setLibrary({ source: initialTemplates, templates: initialTemplates });
  }
  const templates = library.source === initialTemplates
    ? library.templates
    : initialTemplates;
  const [query, setQuery] = useState("");
  const mounted = useRef(false);
  const uploading = useRef(false);
  const [draft, setDraft] = useState<WaiverTemplateDraft | null>(null),
    [stage, setStage] = useState(0),
    [source, setSource] = useState<string>();
  const [busy, setBusy] = useState<"import" | "save" | null>(null),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [original, setOriginal] = useState(false),
    [compare, setCompare] = useState(false),
    [discard, setDiscard] = useState(false);
  const finalReview = useRef<HTMLDivElement>(null);
  const [pendingImport, setPendingImport] = useState<string>();
  const [mobilePreview, setMobilePreview] = useState(false);
  const saved = useRef<CompanyWaiverTemplate | undefined>(undefined),
    savedContent = useRef(""),
    latest = useRef(draft),
    sourceRef = useRef(source),
    saving = useRef(false),
    sequence = useRef(0),
    fileInput = useRef<HTMLInputElement>(null);
  latest.current = draft;
  sourceRef.current = source;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  function start(t?: CompanyWaiverTemplate) {
    if (!mounted.current || busy || saving.current || uploading.current) return;
    sequence.current++;
    saved.current = t;
    const next = t
      ? { ...t, document: t.document ?? documentFromBody(t.body) }
      : {
          ...emptyWaiverTemplate(),
          document: documentFromBody(""),
          defaults: defaultRules,
        };
    setDraft(next);
    savedContent.current = JSON.stringify(next);
    setStage(t ? 1 : 0);
    setSource(t?.sourceFileId);
    setError("");
    setStatus(t ? "Saved" : "");
    setOriginal(false);
    setCompare(false);
  }
  function patch(v: Partial<WaiverTemplateDraft>) {
    setDraft((d) => (d ? { ...d, ...v, reviewed: false } : d));
    setStatus("Unsaved changes");
    setError("");
  }
  async function save(publish = false, report = false) {
    const current = latest.current;
    if (!current || !canManage || !mounted.current || saving.current || uploading.current) return false;
    const parsed = waiverTemplateSchema.safeParse({
      ...current,
      status: publish ? "published" : "draft",
    });
    if (!parsed.success) {
      if (publish || report) setError(parsed.error.issues[0].message);
      return false;
    }
    const generation = sequence.current,
      content = JSON.stringify(current);
    saving.current = true;
    setBusy("save");
    setError("");
    setStatus("Saving…");
    try {
      const result = await saveCompanyWaiverTemplate(
        parsed.data,
        saved.current?.id,
        sourceRef.current,
        saved.current?.editToken,
      );
      if (!mounted.current || generation !== sequence.current) return false;
      saved.current = result;
      savedContent.current = content;
      setLibrary((current) => current.source === initialTemplates ? {
        ...current,
        templates: [result, ...current.templates.filter((t) => t.familyId !== result.familyId)],
      } : current);
      setStatus(
        JSON.stringify(latest.current) === content
          ? "Saved"
          : "Unsaved changes",
      );
      if (publish) {
        setDraft(null);
        toast.success("Waiver template activated");
      }
      return true;
    } catch (e) {
      if (!mounted.current || generation !== sequence.current) return false;
      setError(e instanceof Error ? e.message : "Unable to save");
      setStatus("Not saved");
      return false;
    } finally {
      saving.current = false;
      if (mounted.current && generation === sequence.current) setBusy(null);
    }
  }
  useEffect(() => {
    if (
      !canManage ||
      !draft ||
      JSON.stringify(draft) === savedContent.current ||
      busy ||
      error
    )
      return;
    const timer = setTimeout(() => void save(), 1800);
    return () => clearTimeout(timer);
  }, [draft, source, busy, error, canManage]);
  const hasDraft = !!draft;
  useEffect(() => {
    if (!hasDraft) return;
    const leave = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(latest.current) !== savedContent.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [hasDraft]);
  async function upload(file?: File) {
    if (!file || !canManage || !mounted.current || busy || saving.current || uploading.current) return;
    if (!file.size || file.size > 15 * 1024 * 1024) {
      setError("Choose a PDF smaller than 15 MB");
      return;
    }
    const generation = sequence.current;
    const replacement = saved.current && latest.current
      ? JSON.stringify({ saved: saved.current, draft: latest.current })
      : null;
    uploading.current = true;
    setBusy("import");
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await beginCompanyWaiverImport(form);
      if (!mounted.current || generation !== sequence.current) return;
      if (replacement)
        sessionStorage.setItem(`arc-waiver-replacement:${orgId}`, replacement);
      else sessionStorage.removeItem(`arc-waiver-replacement:${orgId}`);
      sessionStorage.setItem(`arc-waiver-import:${orgId}`, result.sourceFileId);
      setPendingImport(result.sourceFileId);
    } catch (e) {
      if (mounted.current && generation === sequence.current)
        setError(e instanceof Error ? e.message : "Could not import PDF");
    } finally {
      uploading.current = false;
      if (mounted.current && generation === sequence.current) {
        setBusy(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  }
  useEffect(() => {
    const id = sessionStorage.getItem(`arc-waiver-import:${orgId}`);
    if (id && canManage) {
      setPendingImport(id);
      setBusy("import");
    }
  }, [orgId, canManage]);
  useEffect(() => {
    if (!pendingImport) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setBusy("import");
    const poll = async () => {
      try {
        const result = await getCompanyWaiverImport(pendingImport);
        if (!active) return;
        if (result.status === "failed") throw new Error(result.message);
        if (result.status === "ready") {
          sessionStorage.removeItem(`arc-waiver-import:${orgId}`);
          const replacementJson = sessionStorage.getItem(
            `arc-waiver-replacement:${orgId}`,
          );
          const replacement = replacementJson
            ? (JSON.parse(replacementJson) as {
                saved: CompanyWaiverTemplate;
                draft: WaiverTemplateDraft;
              })
            : undefined;
          saved.current = replacement?.saved;
          savedContent.current = "";
          setDraft(
            replacement
              ? replaceWaiverDocument(replacement.draft, result.draft)
              : { ...result.draft, defaults: defaultRules },
          );
          sessionStorage.removeItem(`arc-waiver-replacement:${orgId}`);
          setSource(result.sourceFileId);
          setStage(1);
          setStatus("Unsaved changes");
          setPendingImport(undefined);
          setBusy(null);
        } else timer = setTimeout(poll, 2000);
      } catch (e) {
        if (active) {
          sessionStorage.removeItem(`arc-waiver-import:${orgId}`);
          setError(e instanceof Error ? e.message : "Import failed");
          setPendingImport(undefined);
          setBusy(null);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pendingImport, orgId]);
  function close() {
    if (busy) return;
    if (JSON.stringify(draft) !== savedContent.current) setDiscard(true);
    else setDraft(null);
  }
  async function archive() {
    if (!saved.current || !canManage || !mounted.current || busy || saving.current || uploading.current) return;
    const target = saved.current;
    const generation = sequence.current;
    saving.current = true;
    setBusy("save");
    setError("");
    try {
      await archiveCompanyWaiverTemplate(target.id);
      if (!mounted.current || generation !== sequence.current) return;
      setLibrary((current) => current.source === initialTemplates ? {
        ...current,
        templates: current.templates.filter((t) => t.familyId !== target.familyId),
      } : current);
      setDraft(null);
      toast.success("Template archived. Issued waivers are preserved.");
    } catch (e) {
      if (mounted.current && generation === sequence.current)
        setError(e instanceof Error ? e.message : "Could not archive template");
    } finally {
      saving.current = false;
      if (mounted.current && generation === sequence.current) setBusy(null);
    }
  }
  const filtered = templates.filter((t) =>
    `${t.name} ${types[t.waiverType]}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  if (!draft)
    return (
      <div className="space-y-7">
        {pendingImport && (
          <p role="status" className="text-sm text-muted-foreground">
            Reading your waiver. You can return here when it is ready.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-medium tracking-tight">Waivers</h2>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              {trade
                ? "Your forms, ready for the way you work. Set up the wording and details once; Arc fills them for each job."
                : "Your forms, ready for the way you build. Set up the wording and details once; Arc fills them for each project."}
            </p>
          </div>
          <Button disabled={!canManage || !!busy} onClick={() => start()}>
            <Plus className="mr-2 size-4" />
            Add waiver
          </Button>
        </header>
        {templates.length ? (
          <>
            <div className="relative max-w-xs">
              <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label="Search waivers"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a form…"
              />
            </div>
            <div className="divide-y border-y">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  className="flex w-full items-center gap-4 py-5 text-left hover:bg-muted/30"
                  disabled={!!busy}
                  onClick={() => start(t)}
                >
                  <div className="border p-3">
                    <FileText className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {types[t.waiverType]} ·{" "}
                      {t.applicability === "incoming"
                        ? "From trades"
                        : t.applicability === "both"
                          ? "Both directions"
                          : "To customers"}
                      {t.jurisdiction ? ` · ${t.jurisdiction}` : ""}
                      {t.defaults?.projectIds.length
                        ? ` · ${t.defaults.projectIds.length} projects`
                        : ""}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t.status === "published"
                      ? t.defaults?.enabled
                        ? "Active · Default"
                        : "Active"
                      : "Draft"}
                  </span>
                  <ArrowRight className="size-4" />
                </button>
              ))}
              {!filtered.length && (
                <p className="py-10 text-sm text-muted-foreground">
                  No matching forms.
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center border border-dashed px-8 py-12 text-center">
            <FileText className="mb-5 size-8 text-muted-foreground" />
            <h3 className="text-xl font-medium tracking-tight">
              Start with the form you already use.
            </h3>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              Import a PDF. Review the fields Arc finds. Choose when to use it.
              Your next waiver starts ready.
            </p>
            <Button
              className="mt-6"
              disabled={!canManage || !!busy}
              onClick={() => start()}
            >
              <Upload className="mr-2 size-4" />
              Import your first waiver
            </Button>
          </div>
        )}
      </div>
    );
  const doc = draft.document ?? documentFromBody(draft.body),
    rules = draft.defaults ?? defaultRules;
  return (
    <div data-waiver-workspace className="flex min-h-[70vh] flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b bg-background py-4">
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Back to waivers"
            onClick={close}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <p className="text-sm font-medium">{draft.name || "New waiver"}</p>
            <p className="mt-1 text-xs text-muted-foreground" role="status">
              {busy === "import"
                ? "Reading your document…"
                : status || "Company template"}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {saved.current && (
            <Button
              variant="ghost"
              disabled={!!busy || !canManage}
              onClick={() => void archive()}
            >
              Archive
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => void save(false, true)}
            disabled={!!busy || !canManage}
          >
            Save draft
          </Button>
          {stage < 2 ? (
            <Button
              disabled={
                !!busy || (stage === 0 && !draft.body && !doc.blocks.length)
              }
              onClick={() => setStage((s) => s + 1)}
            >
              Continue
              <ArrowRight className="ml-2 size-4" />
            </Button>
          ) : (
            <Button
              disabled={!!busy || !canManage}
              aria-describedby="waiver-activation-status"
              onClick={() => {
                const message = waiverActivationReviewMessage(draft);
                if (message) {
                  setError(message);
                  finalReview.current?.scrollIntoView({ block: "center" });
                  finalReview.current?.focus();
                } else void save(true);
              }}
            >
              {busy === "save" ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Check className="mr-2 size-4" />
              )}
              Save and use automatically
            </Button>
          )}
        </div>
      </header>
      {stage === 2 && (
        <div
          id="waiver-activation-status"
          className="flex items-center justify-between gap-3 border-b py-3 text-xs text-muted-foreground"
        >
          <span>
            {waiverActivationReviewMessage(draft) ??
              "Review complete. Ready to save and use automatically."}
          </span>
          {waiverActivationReviewMessage(draft) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                finalReview.current?.scrollIntoView({ block: "center" });
                finalReview.current?.focus();
              }}
            >
              Review now
            </Button>
          )}
        </div>
      )}
      <nav aria-label="Waiver setup steps" className="flex gap-6 border-b py-4">
        {["Bring your form", "Connect your information", "When to use it"].map(
          (label, i) => (
            <button
              key={label}
              className={`flex items-center gap-2 text-xs ${stage === i ? "font-medium text-foreground" : "text-muted-foreground"}`}
              aria-current={stage === i ? "step" : undefined}
              disabled={!!busy || (i > 0 && stage === 0 && !doc.blocks.length)}
              onClick={() => setStage(i)}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full border ${stage === i ? "border-foreground" : ""}`}
              >
                {i + 1}
              </span>
              {label}
            </button>
          ),
        )}
      </nav>
      {error && (
        <p
          role="alert"
          className="my-3 border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {stage === 0 ? (
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center py-16">
          <h3 className="text-2xl font-medium tracking-tight">
            Make your waiver work in Arc.
          </h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Arc reads the wording and identifies the information that changes.
            You’ll review the result before it becomes available to your team.
          </p>
          <button
            disabled={!!busy || !canManage}
            className="mt-8 flex min-h-48 flex-col items-center justify-center gap-3 border border-dashed bg-muted/15 transition-colors hover:bg-muted/30"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy && canManage) void upload(e.dataTransfer.files[0]);
            }}
          >
            {busy === "import" ? (
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="size-7 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">
              {busy === "import"
                ? "Reading wording, layout, and fields…"
                : "Drop a PDF here, or choose a file"}
            </span>
            <span className="text-xs text-muted-foreground">
              PDF · Up to 15 MB · Original kept for comparison
            </span>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <Button
            variant="link"
            className="mt-4 self-start px-0 text-muted-foreground"
            disabled={!!busy || !canManage}
            onClick={() => {
              patch({
                document: {
                  ...documentFromBody(""),
                  blocks: [newWaiverBlock("paragraph")],
                },
              });
              setStage(1);
            }}
          >
            Start with a blank document
          </Button>
        </div>
      ) : stage === 1 ? (
        <WaiverSetupWorkspace
          projects={projects}
          onReplace={source ? () => setStage(0) : undefined}
          draft={{ ...draft, document: doc }}
          source={source}
          disabled={!canManage || !!busy}
          onChange={(next) => patch(next)}
        />
      ) : (
        <>
          <div className="flex gap-2 py-3 lg:hidden">
            <Button
              size="sm"
              variant={!mobilePreview ? "secondary" : "ghost"}
              onClick={() => setMobilePreview(false)}
            >
              Details
            </Button>
            <Button
              size="sm"
              variant={mobilePreview ? "secondary" : "ghost"}
              onClick={() => setMobilePreview(true)}
            >
              Document
            </Button>
          </div>
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            <fieldset
              disabled={!canManage || busy === "import"}
              className={`${mobilePreview ? "hidden lg:block" : ""} min-w-0 space-y-6 py-7 lg:order-2 lg:pl-6`}
            >
              <>
                <div>
                  <h3 className="text-lg font-medium">
                    When should Arc use this form?
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Choose where this form applies. Arc will fill project and
                    payment details each time.
                  </p>
                </div>
                <label className="block space-y-2 text-xs font-medium">
                  Who provides this waiver?
                  <select
                    className={selectClass}
                    value={draft.applicability ?? "outgoing"}
                    onChange={(e) =>
                      patch({
                        applicability: e.target.value as
                          | "incoming"
                          | "outgoing"
                          | "both",
                      })
                    }
                  >
                    <option value="outgoing">
                      {trade ? "Our company → customer" : "Our company → customer / owner"}
                    </option>
                    <option value="incoming">
                      {trade ? "Supplier / sub → our company" : "Trade / supplier → our company"}
                    </option>
                    <option value="both">Both directions</option>
                  </select>
                </label>
                <label className="block space-y-2 text-xs font-medium">
                  Payment stage
                  <select
                    className={selectClass}
                    value={draft.waiverType}
                    onChange={(e) =>
                      patch({
                        waiverType: e.target.value as typeof draft.waiverType,
                      })
                    }
                  >
                    {Object.entries(types).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <p className="font-normal leading-5 text-muted-foreground">
                    Conditional forms depend on payment. Unconditional forms
                    require confirmation of received funds. Final forms close
                    the stated scope.
                  </p>
                </label>
                <label className="block space-y-2 text-xs font-medium">
                  Property state
                  <Input
                    maxLength={2}
                    placeholder="State code, e.g. FL"
                    value={draft.jurisdiction ?? ""}
                    onChange={(e) =>
                      patch({ jurisdiction: e.target.value.toUpperCase() })
                    }
                  />
                  <p className="font-normal text-muted-foreground">
                    Leave blank only if your reviewed form applies across
                    states.
                  </p>
                </label>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={rules.enabled}
                    onChange={(e) =>
                      patch({
                        defaults: { ...rules, enabled: e.target.checked },
                      })
                    }
                  />
                  Prefer this form when its requirements match
                </label>
                <details>
                  <summary className="cursor-pointer text-sm">
                    Project or customer requirements
                  </summary>
                  <div className="mt-4 space-y-4">
                    <label className="block space-y-2 text-xs">
                      Customer / contracting party name
                      <Input
                        value={rules.customerName}
                        placeholder="Any customer"
                        onChange={(e) =>
                          patch({
                            defaults: {
                              ...rules,
                              customerName: e.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {trade ? "Jobs (none selected means all jobs)" : "Projects (none selected means all projects)"}
                    </p>
                    {projects.map((p) => (
                      <label className="flex gap-2 text-xs" key={p.id}>
                        <input
                          type="checkbox"
                          checked={rules.projectIds.includes(p.id)}
                          onChange={(e) =>
                            patch({
                              defaults: {
                                ...rules,
                                projectIds: e.target.checked
                                  ? [...rules.projectIds, p.id]
                                  : rules.projectIds.filter(
                                      (id) => id !== p.id,
                                    ),
                              },
                            })
                          }
                        />
                        {p.name}
                      </label>
                    ))}
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer text-sm">
                    Signer defaults
                  </summary>
                  <div className="mt-4 space-y-3">
                    <Input
                      aria-label="Default signer name"
                      placeholder="Signer name"
                      value={rules.signerName}
                      onChange={(e) =>
                        patch({
                          defaults: { ...rules, signerName: e.target.value },
                        })
                      }
                    />
                    <Input
                      aria-label="Default signer title"
                      placeholder="Signer title"
                      value={rules.signerTitle}
                      onChange={(e) =>
                        patch({
                          defaults: { ...rules, signerTitle: e.target.value },
                        })
                      }
                    />
                  </div>
                </details>
                <div className="bg-muted/40 p-4 text-sm leading-6">
                  Arc will use this {types[draft.waiverType].toLowerCase()} form{" "}
                  {draft.applicability === "incoming"
                    ? "when requesting trade waivers"
                    : "when preparing customer waivers"}
                  {draft.jurisdiction
                    ? ` for properties in ${draft.jurisdiction}`
                    : ""}
                  . Project details fill automatically. Missing required fields
                  will be requested before a PDF is issued.
                </div>
                <div
                  ref={finalReview}
                  tabIndex={-1}
                  className="space-y-4 border-t pt-5 focus:outline-none"
                  aria-label="Final review"
                >
                  <h3 className="text-sm font-medium">Final review</h3>
                  {waiverReviewGroups(draft).map((group) => (
                    <div key={group.key} className="space-y-2">
                      <details open={group.issues.some((i) => !i.resolved)}>
                        <summary className="cursor-pointer text-xs font-medium">
                          {group.label}
                        </summary>
                        <ul className="mt-2 list-disc space-y-2 pl-4 text-xs leading-5 text-muted-foreground">
                          {group.issues.map((i) => (
                            <li key={i.id}>{i.message}</li>
                          ))}
                        </ul>
                      </details>
                      <label className="flex items-start gap-2 text-xs leading-5">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={group.issues.every((i) => i.resolved)}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setDraft((current) =>
                              current?.document
                                ? {
                                    ...current,
                                    document: {
                                      ...current.document,
                                      issues: current.document.issues.map(
                                        (i) =>
                                          group.issues.some(
                                            (item) => item.id === i.id,
                                          )
                                            ? { ...i, resolved: checked }
                                            : i,
                                      ),
                                    },
                                  }
                                : current,
                            );
                            setError("");
                            setStatus("Unsaved changes");
                          }}
                        />
                        <span>I reviewed {group.label.toLowerCase()}.</span>
                      </label>
                    </div>
                  ))}
                  <label className="flex items-start gap-3 border-t pt-5 text-xs leading-6">
                    <input
                      className="mt-1.5"
                      type="checkbox"
                      checked={draft.reviewed}
                      onChange={(e) => {
                        setDraft({ ...draft, reviewed: e.target.checked });
                        setError("");
                        setStatus("Unsaved changes");
                      }}
                    />
                    <span>
                      I reviewed the wording, data fields, payment stage, and
                      applicable requirements
                      {source ? " against the original PDF" : ""}. This form is
                      ready for our team.
                    </span>
                  </label>
                </div>
              </>
            </fieldset>
            <aside
              className={`${mobilePreview ? "" : "hidden lg:flex"} min-w-0 flex-col border-r bg-muted/20 lg:order-1 lg:sticky lg:top-20 lg:h-[76vh]`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={!original ? "secondary" : "ghost"}
                    onClick={() => setOriginal(false)}
                  >
                    Arc document
                  </Button>
                  {source && (
                    <Button
                      size="sm"
                      variant={original ? "secondary" : "ghost"}
                      onClick={() => setOriginal(true)}
                    >
                      Original
                    </Button>
                  )}
                </div>
                {source && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCompare(true)}
                  >
                    Compare
                  </Button>
                )}
              </div>
              <div className="flex min-h-[420px] flex-1 flex-col">
                {original && source ? (
                  <Original url={`/api/settings/templates/${source}`} />
                ) : (
                  <>
                    <Preview draft={draft} sample sourceFileId={source} />
                  </>
                )}
              </div>
            </aside>
          </div>
        </>
      )}
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogTitle>Leave this draft?</DialogTitle>
          <DialogDescription>
            Your last saved version is kept. The latest unsaved changes will be
            discarded.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button
              onClick={() => {
                sequence.current++;
                setDiscard(false);
                setDraft(null);
              }}
            >
              Leave
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={compare} onOpenChange={setCompare}>
        <DialogContent className="flex h-[90dvh] flex-col sm:max-w-[95vw]">
          <DialogTitle>Compare your form</DialogTitle>
          <DialogDescription>
            Original on the left. Arc’s generated sample on the right. Confirm
            every clause, field, and signing area.
          </DialogDescription>
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
            {source && <Original url={`/api/settings/templates/${source}`} />}
            <Preview draft={draft} sample sourceFileId={source} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
