"use client";
import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resolveWaiverValues } from "@/lib/templates/waiver-engine";
import {
  templateFields,
  type WaiverTemplateDraft,
} from "@/lib/templates/waiver-template";
import { documentText } from "@/lib/templates/waiver-document";
import {
  waiverSetupFields,
  waiverConnectionDescription,
  connectWaiverField,
  waiverNotaryFieldKeys,
  waiverReviewGroups,
} from "@/lib/templates/waiver-setup";
import {
  WaiverExamplePicker,
  type WaiverExample,
} from "./waiver-example-picker";
const Advanced = dynamic(() =>
  import("./waiver-document-editor").then((m) => m.WaiverDocumentEditor),
);
const Mapper = dynamic(() => import("./waiver-original-mapper"), {
  ssr: false,
});
const Preview = dynamic(() => import("./waiver-template-live-preview"), {
  ssr: false,
});
// pdf.js needs the browser (DOMMatrix); it is never rendered on the server.
const PdfDocumentPreview = dynamic(
  () => import("@/components/invoices/waiver-pdf-preview").then((m) => m.PdfDocumentPreview),
  { ssr: false },
);
const selectClass = "h-10 w-full border bg-background px-3 text-sm";

export function WaiverSetupWorkspace({
  draft,
  source,
  disabled,
  onChange,
  projects = [],
  onReplace,
}: {
  onReplace?: () => void;
  projects?: { id: string; name: string }[];
  draft: WaiverTemplateDraft;
  source?: string;
  disabled?: boolean;
  onChange: (draft: WaiverTemplateDraft) => void;
}) {
  const doc = draft.document!;
  const fields = waiverSetupFields(draft);
  const [example, setExample] = useState<WaiverExample>();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<
    "form" | "original" | "example" | "wording" | "advanced"
  >("form");
  const [mobilePanel, setMobilePanel] = useState(false);
  const [pageCount, setPageCount] = useState<number>();
  const hasMappedOriginal =
    !!source &&
    doc.placements.some(
      (p) =>
        p.kind === "text" &&
        (pageCount === undefined || p.page < pageCount) &&
        fields.some((f) => f.key === p.key),
    );
  const chosen = fields.find((f) => f.key === selected);
  const notaryKeys = waiverNotaryFieldKeys(draft);
  const notary = fields.filter(
    (f) => f.source === "manual" && notaryKeys.has(f.key),
  );
  const manual = fields.filter(
    (f) => f.source === "manual" && !notaryKeys.has(f.key),
  );
  const reviewGroups = waiverReviewGroups(draft);
  const connected = fields.filter((f) => f.source !== "manual");
  const select = (key: string) => {
    setSelected(key);
    setMobilePanel(true);
  };
  const patchDocument = (document: typeof doc) =>
    onChange({
      ...draft,
      document,
      body: documentText(draft.body, document).slice(0, 30000),
    });
  const fieldText = (text: string): ReactNode =>
    text.split(/(\{\{[^{}]+\}\})/g).map((part, i) => {
      const match = part.match(/^\{\{([^{}]+)\}\}$/);
      if (!match) return part;
      const field = fields.find((f) => f.key === match[1]);
      if (!field)
        return (
          <span key={i} className="border-b border-dashed">
            {templateFields[match[1] as keyof typeof templateFields] ??
              match[1]}
          </span>
        );
      return (
        <button
          key={i}
          type="button"
          onClick={() => select(field.key)}
          aria-pressed={selected === field.key}
          className={`mx-0.5 border-b px-1 text-left font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selected === field.key ? "border-primary bg-primary/10 text-primary" : "border-primary/40 text-primary hover:bg-primary/5"}`}
        >
          {field.source === "constant" && field.custom?.value
            ? field.custom.value
            : field.label}
        </button>
      );
    });
  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section
        className={`${mobilePanel ? "hidden lg:flex" : "flex"} min-w-0 flex-col bg-muted/20 lg:sticky lg:top-20 lg:h-[76vh]`}
        aria-label="Waiver document"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={view === "form" ? "secondary" : "ghost"}
              onClick={() => setView("form")}
            >
              Your form
            </Button>
            <Button
              size="sm"
              variant={view === "example" ? "secondary" : "ghost"}
              onClick={() => setView("example")}
            >
              Filled example
            </Button>
            {source && !hasMappedOriginal && (
              <Button
                size="sm"
                variant={view === "original" ? "secondary" : "ghost"}
                onClick={() => setView("original")}
              >
                Original PDF
              </Button>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setView(view === "wording" ? "form" : "wording")}
          >
            Edit wording
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="lg:hidden"
          onClick={() => setMobilePanel(true)}
        >
          How Arc fills this form
          <ChevronRight className="ml-2 size-4" />
        </Button>
        <div className={view === "example" ? "" : "hidden"}>
          <WaiverExamplePicker
            projects={draft.applicability === "incoming" ? [] : projects}
            onChange={setExample}
          />
        </div>
        {view === "example" ? (
          <div className="flex min-h-[500px] flex-1 flex-col">
            <Preview
              draft={draft}
              sample
              sourceFileId={source}
              values={example?.values}
              invoiceNumber={example?.invoiceNumber}
            />
          </div>
        ) : view === "advanced" ? (
          <div className="overflow-y-auto p-6">
            <Button variant="ghost" onClick={() => setView("form")}>
              <ArrowLeft className="mr-2 size-4" />
              Back to your form
            </Button>
            <fieldset disabled={disabled} className="mt-5">
              <Advanced
                document={doc}
                source={source}
                onChange={patchDocument}
              />
            </fieldset>
            {doc.mode === "original" && source && (
              <div className="mt-6 flex min-h-[500px] flex-col">
                <Mapper
                  source={source}
                  document={doc}
                  disabled={disabled}
                  onChange={patchDocument}
                />
              </div>
            )}
          </div>
        ) : (view === "original" || (view === "form" && hasMappedOriginal)) &&
          source ? (
          <div className="flex min-h-[500px] flex-1 flex-col">
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {hasMappedOriginal
                ? "Click a highlighted blank to see how Arc fills it."
                : "Original PDF kept for comparison. Use Your form to connect its blanks."}
              {doc.mode === "editable"
                ? " View Filled example to review the generated layout."
                : ""}
            </p>
            <PdfDocumentPreview
              url={`/api/settings/templates/${source}`}
              onPageCount={setPageCount}
              renderOverlay={(page) =>
                doc.placements
                  .filter((p) => p.page === page)
                  .map((p) => {
                    const field = fields.find((f) => f.key === p.key);
                    if (p.kind !== "text" || !field) return null;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        aria-label={`How Arc fills ${field.label}`}
                        aria-pressed={selected === field.key}
                        onClick={() => select(field.key)}
                        className={`absolute border-b focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selected === field.key ? "border-primary bg-primary/20" : "border-primary/50 bg-primary/10 hover:bg-primary/20"}`}
                        style={{
                          left: `${p.x * 100}%`,
                          top: `${p.y * 100}%`,
                          width: `${p.width * 100}%`,
                          height: `${p.height * 100}%`,
                        }}
                      >
                        <span className="sr-only">{field.label}</span>
                      </button>
                    );
                  })
              }
            />
          </div>
        ) : (
          <div className="overflow-y-auto p-4 sm:p-8">
            <div className="mx-auto max-w-[680px] space-y-5 border bg-background p-6 sm:p-10">
              {view === "wording" && doc.mode === "original" ? (
                <div className="space-y-3 text-sm">
                  <p>
                    Your original PDF preserves its printed wording. Switch to
                    an editable Arc document to change the text.
                  </p>
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => patchDocument({ ...doc, mode: "editable" })}
                  >
                    Use editable document
                  </Button>
                </div>
              ) : (
                <>
                  {view === "wording" ? (
                    <Input
                      aria-label="Document heading"
                      value={draft.title}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange({ ...draft, title: e.target.value })
                      }
                    />
                  ) : (
                    <h2 className="text-center text-lg font-semibold">
                      {draft.title}
                    </h2>
                  )}
                  {doc.blocks
                    .filter(
                      (b, index) =>
                        !(
                          index ===
                            doc.blocks.findIndex(
                              (block) => block.kind === "heading",
                            ) &&
                          b.kind === "heading" &&
                          !b.condition &&
                          b.text.trim().toLowerCase() ===
                            draft.title.trim().toLowerCase()
                        ),
                    )
                    .map((b) => (
                      <div
                        key={b.id}
                        className={
                          b.kind === "page_break"
                            ? "border-t border-dashed py-2"
                            : "whitespace-pre-wrap text-sm leading-7"
                        }
                      >
                        {b.kind === "paragraph" || b.kind === "heading" ? (
                          view === "wording" ? (
                            <EditableWaiverText
                              text={b.text}
                              disabled={disabled}
                              labels={Object.fromEntries(
                                fields.map((f) => [f.key, f.label]),
                              )}
                              onChange={(text) =>
                                patchDocument({
                                  ...doc,
                                  blocks: doc.blocks.map((v) =>
                                    v.id === b.id ? { ...v, text } : v,
                                  ),
                                })
                              }
                            />
                          ) : b.kind === "heading" ? (
                            <h3 className="font-semibold">
                              {fieldText(b.text)}
                            </h3>
                          ) : (
                            <p>{fieldText(b.text)}</p>
                          )
                        ) : b.kind === "table" ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left">
                              <thead>
                                <tr>
                                  {b.columns.map((c, i) => (
                                    <th
                                      className="border-b p-2 font-medium"
                                      key={i}
                                    >
                                      {fieldText(c)}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {b.rows.map((r, i) => (
                                  <tr key={i}>
                                    {r.map((c, j) => (
                                      <td className="border-b p-2" key={j}>
                                        {fieldText(c)}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {view === "wording" && (
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => setView("advanced")}
                              >
                                Edit table
                              </Button>
                            )}
                          </div>
                        ) : b.kind === "signature" ? (
                          <p className="border-t pt-4 text-xs text-muted-foreground">
                            {b.signerRole && b.signerRole !== "claimant"
                              ? b.signerRole
                              : "Authorized person"}{" "}
                            signs here · Date added when signed
                          </p>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Page break
                          </span>
                        )}
                        {b.condition && (
                          <p className="text-xs text-muted-foreground">
                            Shown according to your saved condition. Check
                            Filled example to see the generated document.
                          </p>
                        )}
                      </div>
                    ))}
                </>
              )}
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          className="lg:hidden"
          onClick={() => setMobilePanel(true)}
        >
          How Arc fills this form
          <ChevronRight className="ml-2 size-4" />
        </Button>
      </section>
      <aside
        className={`${mobilePanel ? "" : "hidden lg:block"} min-w-0 border-l px-5 py-6`}
        aria-label="Form setup"
      >
        <Button
          variant="ghost"
          className="mb-4 lg:hidden"
          onClick={() => setMobilePanel(false)}
        >
          <ArrowLeft className="mr-2 size-4" />
          Back to document
        </Button>
        {chosen ? (
          <div className="space-y-5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(undefined)}
            >
              <ArrowLeft className="mr-2 size-4" />
              All connections
            </Button>
            <FieldConnection
              key={chosen.key}
              field={chosen}
              disabled={disabled}
              onSave={(connection) => {
                const result = connectWaiverField(
                  draft,
                  chosen.key,
                  connection,
                );
                resolveWaiverValues(result.draft, {}, {}, true);
                onChange(result.draft);
                setSelected(result.key);
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next =
                  fields[
                    (fields.findIndex((f) => f.key === chosen.key) + 1) %
                      fields.length
                  ];
                if (next) setSelected(next.key);
              }}
            >
              Next blank
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium">Teach Arc once.</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Your wording stays in the document. Choose where the changing
                details come from, then Arc fills them each time.
              </p>
            </div>
            <label className="block space-y-2 text-xs font-medium">
              Save this form as
              <Input
                value={draft.name}
                disabled={disabled}
                placeholder="e.g. Final waiver"
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
              />
            </label>
            {manual.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {manual.length} answers to connect
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  These currently ask for an answer when preparing a waiver.
                  Connect them to Arc or save a fixed answer where appropriate.
                </p>
                {manual.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    onClick={() => select(f.key)}
                    className="flex w-full items-center justify-between gap-3 border-b py-3 text-left text-sm hover:text-primary"
                  >
                    <span>{f.label}</span>
                    <ChevronRight className="size-4 shrink-0" />
                  </button>
                ))}
              </div>
            )}
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium">
                {connected.length} connected to Arc or saved answers
              </summary>
              <div className="mt-2">
                {connected.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    onClick={() => select(f.key)}
                    className="flex w-full items-start gap-2 border-b py-3 text-left hover:text-primary"
                  >
                    <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm">
                      {f.label}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {waiverConnectionDescription(f.source)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </details>
            <p className="text-xs leading-5 text-muted-foreground">
              Signatures and signing dates are completed during signing. Any
              notarization shown on the form still needs its own completion
              process.
            </p>
            {notary.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  {notary.length} notarization details
                </summary>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Keep these separate from project and payment information. They
                  currently need answers when preparing the waiver; confirm the
                  appropriate details with the notary.
                </p>
                {notary.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    onClick={() => select(f.key)}
                    className="flex w-full items-center justify-between border-b py-3 text-left text-sm hover:text-primary"
                  >
                    {f.label}
                    <ChevronRight className="size-4" />
                  </button>
                ))}
              </details>
            )}
            {reviewGroups.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">Review before using</p>
                {reviewGroups.map((group) => (
                  <details key={group.key}>
                    <summary className="cursor-pointer text-xs font-medium">
                      {group.issues.every((i) => i.resolved)
                        ? "Reviewed · "
                        : ""}
                      {group.label}
                    </summary>
                    <div className="mt-3 space-y-3">
                      {group.issues.map((issue) => (
                        <p
                          className="text-xs leading-5 text-muted-foreground"
                          key={issue.id}
                        >
                          {issue.message}
                        </p>
                      ))}
                      <label className="flex items-start gap-2 text-xs leading-5">
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={group.issues.every((i) => i.resolved)}
                          onChange={(e) =>
                            patchDocument({
                              ...doc,
                              issues: doc.issues.map((i) =>
                                group.issues.some((v) => v.id === i.id)
                                  ? { ...i, resolved: e.target.checked }
                                  : i,
                              ),
                            })
                          }
                        />
                        I reviewed these details against the form.
                      </label>
                    </div>
                  </details>
                ))}
              </div>
            )}
            {onReplace && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={onReplace}
              >
                Replace PDF
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setView("advanced")}
            >
              <Settings2 className="mr-2 size-4" />
              Layout & advanced settings
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}

function FieldConnection({
  field,
  disabled,
  onSave,
}: {
  field: ReturnType<typeof waiverSetupFields>[number];
  disabled?: boolean;
  onSave: (value: { source: string; value: string }) => void;
}) {
  const [source, setSource] = useState(field.source),
    [value, setValue] = useState(field.custom?.value ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const type =
    field.custom?.type ??
    (field.key === "amount"
      ? "currency"
      : ["through_date", "signed_date"].includes(field.key)
        ? "date"
        : "text");
  const choices = Object.entries(templateFields).filter(
    ([key]) =>
      !key.startsWith("item_") &&
      (type === "currency"
        ? key === "amount"
        : type === "date"
          ? ["through_date", "signed_date"].includes(key)
          : true),
  );
  const mode = source === "manual" || source === "constant" ? source : "arc";
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <div>
        <h3 className="text-lg font-medium">{field.label}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          How should Arc fill this blank?
        </p>
      </div>
      <div className="space-y-2">
        {[
          ["arc", "Use information in Arc"],
          ["constant", "Always use the same answer"],
          ["manual", "Ask when preparing the waiver"],
        ].map(([key, label]) => (
          <label
            key={key}
            className="flex cursor-pointer items-start gap-3 py-2 text-sm"
          >
            <input
              type="radio"
              name={`connection-${field.key}`}
              checked={mode === key}
              onChange={() => {
                setSaved(false);
                setSource(
                  key === "arc" ? (choices[0]?.[0] ?? "project_name") : key,
                );
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {mode === "arc" && (
        <label className="block space-y-2 text-xs font-medium">
          Use this information
          <select
            className={selectClass}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSaved(false);
            }}
          >
            {choices.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <span className="block font-normal leading-5 text-muted-foreground">
            {waiverConnectionDescription(source)}
          </span>
        </label>
      )}
      {mode === "constant" && (
        <label className="block space-y-2 text-xs font-medium">
          Answer
          {type === "choice" ? (
            <select
              className={selectClass}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            >
              <option value="">Choose an answer</option>
              {field.custom?.options.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <Input
              type={type === "date" ? "date" : "text"}
              inputMode={type === "currency" ? "decimal" : undefined}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            />
          )}
        </label>
      )}
      {mode === "manual" && (
        <p className="text-xs leading-5 text-muted-foreground">
          Arc will ask for this information when the waiver is prepared. Nothing
          is assumed when an answer is missing.
        </p>
      )}
      {source === "amount" && (
        <p className="text-xs leading-5 text-muted-foreground">
          This is the waiver amount. Confirm it matches what this blank asks
          for, especially if the form names a check or a specific payment.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        disabled={disabled || (mode === "constant" && !value.trim())}
        onClick={() => {
          try {
            onSave({ source, value: source === "constant" ? value : "" });
            setSaved(true);
            setError("");
          } catch (e) {
            setError(e instanceof Error ? e.message : "Check this answer");
          }
        }}
      >
        {saved ? "Connection saved" : "Save connection"}
      </Button>
    </fieldset>
  );
}

function EditableWaiverText({
  text,
  disabled,
  labels,
  onChange,
}: {
  text: string;
  disabled?: boolean;
  labels: Record<string, string>;
  onChange: (text: string) => void;
}) {
  return (
    <div
      role="textbox"
      aria-label="Document wording"
      aria-multiline="true"
      aria-readonly={disabled}
      contentEditable={!disabled}
      suppressContentEditableWarning
      className="min-h-10 whitespace-pre-wrap border-b border-dashed p-2 text-sm leading-7 focus:outline focus:outline-1 focus:outline-primary"
      onBlur={(e) => {
        const read = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          if (node instanceof HTMLElement) {
            if (node.dataset.waiverField)
              return "{{" + node.dataset.waiverField + "}}";
            if (node.tagName === "BR") return "\n";
            const value = Array.from(node.childNodes).map(read).join("");
            return ["DIV", "P"].includes(node.tagName) ? value + "\n" : value;
          }
          return "";
        };
        const next = Array.from(e.currentTarget.childNodes)
          .map(read)
          .join("")
          .replace(/\n$/, "");
        if (next !== text) onChange(next);
      }}
    >
      {text.split(/(\{\{[^{}]+\}\})/g).map((part, i) => {
        const match = part.match(/^\{\{([^{}]+)\}\}$/);
        return match ? (
          <span
            key={i}
            contentEditable={false}
            data-waiver-field={match[1]}
            className="mx-0.5 border-b border-primary/40 px-1 text-primary"
          >
            {labels[match[1]] ??
              templateFields[match[1] as keyof typeof templateFields] ??
              "Connected field"}
          </span>
        ) : (
          part
        );
      })}
    </div>
  );
}
