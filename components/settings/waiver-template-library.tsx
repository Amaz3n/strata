"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  FileText,
  Plus,
  Search,
  Upload,
  Loader2,
  Check,
  Braces,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  emptyWaiverTemplate,
  waiverTemplateSchema,
  templateFields,
  type CompanyWaiverTemplate,
  type WaiverTemplateDraft,
} from "@/lib/templates/waiver-template";
import {
  saveCompanyWaiverTemplate,
  importCompanyWaiverTemplate,
} from "@/app/(app)/settings/templates/waiver-actions";
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
export function WaiverTemplateLibrary({
  initialTemplates,
  canManage,
}: {
  initialTemplates: CompanyWaiverTemplate[];
  canManage: boolean;
}) {
  const [templates, setTemplates] = useState(initialTemplates),
    [query, setQuery] = useState("");
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<WaiverTemplateDraft>(emptyWaiverTemplate),
    [editing, setEditing] = useState<CompanyWaiverTemplate>(),
    [source, setSource] = useState<string>(),
    [original, setOriginal] = useState(false),
    [sample, setSample] = useState(true),
    [busy, setBusy] = useState<"import" | "save" | null>(null),
    [warnings, setWarnings] = useState<string[]>([]),
    [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [replacement, setReplacement] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null),
    bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open || !dirty) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [open, dirty]);
  function start(t?: CompanyWaiverTemplate) {
    setEditing(t);
    setDraft(
      t
        ? {
            name: t.name,
            title: t.title,
            waiverType: t.waiverType,
            body: t.body,
            status: t.status,
            reviewed: t.reviewed,
            warnings: t.warnings,
            applicability: t.applicability,
            jurisdiction: t.jurisdiction,
          }
        : emptyWaiverTemplate(),
    );
    setSource(t?.sourceFileId);
    setWarnings(t?.warnings ?? []);
    setOriginal(false);
    setDirty(false);
    setOpen(true);
  }
  function patch(v: Partial<WaiverTemplateDraft>) {
    setDraft((d) => ({ ...d, ...v, reviewed: false }));
    setDirty(true);
  }
  function close() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else setOpen(false);
  }
  async function upload(file?: File, confirmed = false) {
    if (!file) return;
    if (!file.size || file.size > 15 * 1024 * 1024) {
      toast.error("Choose a PDF smaller than 15 MB");
      return;
    }
    if (dirty && !confirmed) {
      setReplacement(file);
      return;
    }
    setBusy("import");
    try {
      const form = new FormData();
      form.append("file", file);
      const result = await importCompanyWaiverTemplate(form);
      setDraft(result.draft);
      setSource(result.sourceFileId);
      setWarnings(result.warnings);
      setDirty(true);
      toast.success(
        "Draft ready. Compare it with the original before publishing.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to read PDF");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function save(status: "draft" | "published") {
    const validation = waiverTemplateSchema.safeParse({ ...draft, status });
    if (!validation.success) {
      toast.error(
        validation.error.issues[0]?.message ?? "Check the template details",
      );
      return;
    }
    setBusy("save");
    try {
      const saved = await saveCompanyWaiverTemplate(
        { ...draft, status },
        editing?.id,
        source,
      );
      setTemplates((ts) => [
        saved,
        ...ts.filter((t) => t.familyId !== saved.familyId),
      ]);
      setDirty(false);
      setOpen(false);
      toast.success(
        status === "published" ? "Template published" : "Draft saved",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save template");
    } finally {
      setBusy(null);
    }
  }
  function insert(key: string) {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? draft.body.length,
      end = el?.selectionEnd ?? start;
    const token = `{{${key}}}`;
    patch({ body: draft.body.slice(0, start) + token + draft.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }
  const filtered = templates.filter((t) =>
    `${t.name} ${types[t.waiverType]}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="flex items-center justify-between gap-6 pb-6">
        <div>
          <h2 className="text-lg font-medium tracking-tight">Waivers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your wording. Ready for every project.
          </p>
        </div>
        <Button disabled={!canManage} onClick={() => start()}>
          <Plus className="mr-2 size-4" />
          New template
        </Button>
      </div>
      {templates.length > 0 && (
        <div className="relative mb-5 max-w-xs">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Search waiver templates"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a template…"
          />
        </div>
      )}
      {templates.length === 0 ? (
        <div className="grid min-h-[390px] grid-cols-[1.1fr_1fr] overflow-hidden border bg-muted/10">
          <div className="flex flex-col items-start justify-center p-12">
            <span className="mb-5 text-[10px] font-medium uppercase tracking-[.2em] text-muted-foreground">
              A little setup. A lot less repetition.
            </span>
            <h3 className="max-w-xs text-3xl font-medium leading-tight tracking-tight">
              Make your next waiver
              <br />
              the easy one.
            </h3>
            <p className="mt-4 max-w-sm text-sm leading-6 text-muted-foreground">
              Bring the document your company already uses. Turn it into an
              editable template with project details that fill themselves in.
            </p>
            <Button
              variant="outline"
              className="mt-7"
              disabled={!canManage}
              onClick={() => start()}
            >
              Create your first template
              <ArrowUpRight className="ml-3 size-4" />
            </Button>
          </div>
          <div
            aria-hidden="true"
            className="flex items-center justify-center overflow-hidden bg-muted/40 p-10"
          >
            <div className="w-64 rotate-[-4deg] border bg-background p-7 shadow-lg transition-transform duration-300 hover:rotate-0 motion-reduce:transform-none">
              <FileText className="mb-7 size-5 text-muted-foreground" />
              <div className="text-lg font-medium">Waiver & release</div>
              <div className="mt-5 inline-block rounded bg-primary/10 px-2 py-1 text-xs text-primary">
                Project name
              </div>
              <div className="mt-5 space-y-2">
                {[100, 95, 100, 70, 90, 100, 65].map((w, i) => (
                  <div
                    key={i}
                    className="h-1 bg-muted"
                    style={{ width: `${w}%` }}
                  />
                ))}
              </div>
              <div className="mt-10 border-t pt-2 text-[9px] text-muted-foreground">
                Authorized signature
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t">
          {filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => start(t)}
              className="group flex w-full items-center gap-5 border-b px-3 py-5 text-left transition-colors hover:bg-muted/35"
            >
              <div className="flex size-11 items-center justify-center border bg-muted/20">
                <FileText className="size-5 text-muted-foreground" />
              </div>
              <div className="flex-1">
                <p className="font-medium">{t.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {types[t.waiverType]}
                </p>
              </div>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {t.status === "published" && <Check className="size-3.5" />}
                {t.status === "published" ? "Published" : "Draft"}
              </span>
              <span className="w-24 text-right text-xs text-muted-foreground">
                {new Date(t.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none" />
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="py-14 text-center text-sm text-muted-foreground">
              No templates match “{query}”.
            </p>
          )}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) close();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[94dvh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[1440px]"
        >
          <header className="flex h-17 shrink-0 items-center justify-between border-b px-6 py-4">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back to templates"
                onClick={close}
                disabled={!!busy}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <div>
                <DialogTitle className="text-sm font-medium">
                  {editing ? "Edit waiver template" : "New waiver template"}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {dirty ? "Unsaved changes" : "Company template"}
                </DialogDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                disabled={
                  !!busy ||
                  !canManage ||
                  !draft.name.trim() ||
                  !draft.body.trim()
                }
                onClick={() => save("draft")}
              >
                Save draft
              </Button>
              <Button
                disabled={
                  !!busy ||
                  !canManage ||
                  !draft.reviewed ||
                  !draft.name.trim() ||
                  !draft.body.trim()
                }
                onClick={() => save("published")}
              >
                {busy === "save" ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Check className="mr-2 size-4" />
                )}
                Publish template
              </Button>
            </div>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(420px,.9fr)_minmax(480px,1.1fr)]">
            <div className="overflow-y-auto border-r">
              <fieldset
                disabled={!!busy || !canManage}
                className="space-y-7 p-8 disabled:opacity-60"
              >
                {!editing && (
                  <div className="border border-dashed p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          Start with your PDF
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          Arc reads the wording and prepares editable fields.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fileInput.current?.click()}
                      >
                        {busy === "import" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Upload className="mr-2 size-4" />
                        )}
                        {busy === "import" ? "Reading…" : "Import PDF"}
                      </Button>
                    </div>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => void upload(e.target.files?.[0])}
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-2 text-xs font-medium">Used for
                    <select className="h-9 w-full border bg-background px-2" value={draft.applicability ?? "outgoing"} onChange={e => patch({applicability: e.target.value as "incoming" | "outgoing" | "both"})}>
                      <option value="outgoing">Builder to owner</option><option value="incoming">Trade to builder</option><option value="both">Both directions</option>
                    </select>
                  </label>
                  <label className="space-y-2 text-xs font-medium">Property state (blank for any)
                    <Input maxLength={2} value={draft.jurisdiction ?? ""} onChange={e => patch({jurisdiction:e.target.value.toUpperCase()})} placeholder="FL" />
                  </label>
                </div>
                <div className="space-y-2">
                  <label htmlFor="waiver-name" className="text-xs font-medium">
                    Template name
                  </label>
                  <Input
                    id="waiver-name"
                    maxLength={120}
                    placeholder="e.g. Company progress waiver"
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="waiver-type" className="text-xs font-medium">
                    Waiver type
                  </label>
                  <select
                    id="waiver-type"
                    className="h-10 w-full border bg-background px-3 text-sm"
                    value={draft.waiverType}
                    onChange={(e) =>
                      patch({
                        waiverType: e.target
                          .value as WaiverTemplateDraft["waiverType"],
                      })
                    }
                  >
                    {Object.entries(types).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label htmlFor="waiver-title" className="text-xs font-medium">
                    Document heading
                  </label>
                  <Input
                    id="waiver-title"
                    maxLength={200}
                    value={draft.title}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </div>
                <div className="space-y-3">
                  <label htmlFor="waiver-body" className="text-xs font-medium">
                    Document wording
                  </label>
                  <Textarea
                    ref={bodyRef}
                    id="waiver-body"
                    maxLength={30000}
                    className="min-h-[280px] resize-y text-sm leading-7"
                    placeholder="Paste your waiver wording, or import a PDF above…"
                    value={draft.body}
                    onChange={(e) => patch({ body: e.target.value })}
                  />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Braces className="size-3.5" />
                    Insert a field at your cursor
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(templateFields).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => insert(key)}
                        className="rounded border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {warnings.length > 0 && (
                  <div className="border-l-2 border-warning pl-4 text-xs leading-6">
                    <p className="font-medium">Check these details</p>
                    {warnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </div>
                )}
                <label className="flex cursor-pointer items-start gap-3 border-t pt-5 text-xs leading-5 text-muted-foreground">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={draft.reviewed}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, reviewed: e.target.checked }));
                      setDirty(true);
                    }}
                  />
                  <span>
                    I reviewed the wording, fields, and waiver type
                    {source ? " against the original document" : ""}. This
                    template is ready for company use.
                  </span>
                </label>
              </fieldset>
            </div>
            <div className="flex min-h-0 flex-col bg-muted/30">
              <div className="flex h-12 shrink-0 items-center justify-between border-b px-5">
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={!original ? "secondary" : "ghost"}
                    onClick={() => setOriginal(false)}
                  >
                    Live preview
                  </Button>
                  {source && (
                    <Button
                      size="sm"
                      variant={original ? "secondary" : "ghost"}
                      onClick={() => setOriginal(true)}
                    >
                      Original PDF
                    </Button>
                  )}
                </div>
                {!original && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={sample}
                      onChange={(e) => setSample(e.target.checked)}
                    />
                    Example project
                  </label>
                )}
              </div>
              {original && source ? (
                <Original url={`/api/settings/templates/${source}`} />
              ) : (
                <Preview draft={draft} sample={sample} />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!replacement}
        onOpenChange={(v) => {
          if (!v) setReplacement(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Replace this draft’s content?</DialogTitle>
          <DialogDescription>
            Importing another PDF will replace the wording and fields you have
            entered.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReplacement(undefined)}>
              Keep editing
            </Button>
            <Button
              onClick={() => {
                const file = replacement;
                setReplacement(undefined);
                void upload(file, true);
              }}
            >
              Import and replace
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Your saved template will remain available.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button
              onClick={() => {
                setDiscard(false);
                setOpen(false);
                setDirty(false);
              }}
            >
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
