"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, Plus, Save, Trash2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param";
import { answerProposalCommentAction, saveProposalDefaultAction } from "@/app/(app)/pipeline/[dealId]/proposal-actions";
import { unwrapAction } from "@/lib/action-result";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import { money } from "@/lib/precon/format";
import {
  fillProposalTemplate,
  isBuiltInSection,
  normalizeProposalLayout,
  paymentAmounts,
  paymentPercentTotal,
  PROPOSAL_DOCUMENT_HEADINGS,
  type DealProposal as DealProposalContent,
  type ProposalDefaultField,
  type ProposalLayoutEntry,
  type ProposalPayment,
  type ProposalSectionKey,
  type ProposalSectionState,
} from "@/lib/precon/proposal-documents";
import type { DealDocumentVersion } from "@/lib/services/precon-deals";
import type { ProposalComment } from "@/lib/services/precon-proposal";
import { cn } from "@/lib/utils";
import { DealDocumentPane } from "./deal-document-pane";
import { DealProposalSend } from "./deal-proposal-send";
import { DealQuestions } from "./deal-questions";
import { useDealRoom } from "./deal-room";

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Not sent", tone: "text-muted-foreground" },
  sent: { label: "Sent", tone: "text-primary" },
  approved: { label: "Approved", tone: "text-success" },
  changes_requested: { label: "Changes requested", tone: "text-warning" },
  rejected: { label: "Declined", tone: "text-destructive" },
  client_signed: { label: "Signed by the client", tone: "text-success" },
  executed: { label: "Signed by both sides", tone: "text-success" },
  converted_to_project: { label: "Signed by both sides", tone: "text-success" },
  void: { label: "Void", tone: "text-muted-foreground" },
};

const TONE: Record<ProposalSectionState["tone"], { dot: string; text: string }> = {
  auto: { dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  edited: { dot: "bg-primary", text: "text-foreground" },
  needs: { dot: "bg-warning", text: "text-warning" },
  off: { dot: "bg-border", text: "text-muted-foreground" },
};

const DISPLAY_OPTIONS = [
  ["sections", "By section"],
  ["itemized", "Every line"],
  ["lump_sum", "One total"],
] as const;

const PRICE_MODES = [
  ["signature", "Fixed price, to sign"],
  ["range", "Estimate, to approve"],
] as const;

const shortDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const newId = () => crypto.randomUUID().slice(0, 12);

/**
 * The client's one document. Each section on the left opens its editor in
 * place and says whether it is on its default, edited, waiting on you, or off;
 * sections can be switched off, renamed, moved and added. The document on the
 * right is exactly what the client gets, and clicking a part of it opens that
 * section.
 */
export function DealProposal({ versions, truncated }: { versions: DealDocumentVersion[]; truncated: boolean }) {
  const room = useDealRoom();
  const { deal, state, move, pricingStarted, intent } = room;
  const { model } = room.proposal;
  const layout = useLayout();
  const who = deal.client.name.split(" ")[0] || "the client";
  const [open, setOpen] = useState<ProposalSectionKey | null>(() => model.needs[0]?.key ?? null);
  const [sending, setSending] = useWorkspaceParam("send");

  useEffect(() => {
    if (intent?.kind === "proposal") select(intent.section);
    if (intent?.kind === "send") setSending("1");
    // Each intent is acted on once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  function select(key: ProposalSectionKey) {
    setOpen(key);
    requestAnimationFrame(() => {
      document.getElementById(`proposal-section-${key}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      document.querySelector(`[data-section="${key}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  if (!pricingStarted || !state.worksheet.rows.length)
    return (
      <div className="grid justify-items-center gap-2 border bg-card px-6 py-12 text-center shadow-xs">
        <h2 className="text-base font-semibold">Nothing to send yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {who === "the client" ? "The client's" : `${who}'s`} proposal is built from the price. Add lines on the Pricing tab and it
          appears here.
        </p>
        <Button asChild size="sm" className="mt-2">
          <OptimisticLink href={room.href("pricing")}>Go to pricing</OptimisticLink>
        </Button>
      </div>
    );

  const flags = Object.fromEntries(model.needs.map((need) => [need.key, need.label]));
  const onDocument = model.states.filter((item) => item.tone !== "off").length;

  return (
    <>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <section aria-label="Sections" className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2 px-2.5 pb-2">
              <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Proposal · {onDocument} {onDocument === 1 ? "section" : "sections"}
              </h2>
              <SaveState />
            </div>
            {!room.proposal.available && (
              <p className="mx-2.5 mb-2 bg-muted px-3 py-2 text-xs text-muted-foreground">
                Editing the proposal is waiting on a database update. The document shows your defaults until then.
              </p>
            )}
            {model.states.map((section, index) => (
              <SectionRow
                key={section.key}
                section={section}
                open={open === section.key}
                first={index === 0}
                last={index === model.states.length - 1}
                onToggle={() => (open === section.key ? setOpen(null) : select(section.key))}
              />
            ))}
            {layout.editable && (
              <div className="flex flex-wrap items-center justify-between gap-1 px-1 pt-2">
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => select(layout.add())}>
                  <Plus className="size-3.5" />
                  Add a section
                </Button>
                <DefaultControls
                  field="layout"
                  value={layout.entries}
                  edited={layout.edited}
                  onReset={layout.reset}
                  saveLabel="Save layout as my default"
                />
              </div>
            )}
          </section>
          <Versions versions={versions} truncated={truncated} who={who} />
        </div>

        <div className="flex h-[calc(100dvh-14rem)] min-h-[36rem] flex-col overflow-hidden border shadow-xs lg:sticky lg:top-16">
          <DealDocumentPane
            className="min-h-0 flex-1 border-l-0 lg:flex-1"
            dealName={deal.name}
            client={deal.client}
            worksheet={state.worksheet}
            signable={move.signable}
            range={move.firmness?.range ?? null}
            documents={room.documents}
            questions={room.questions}
            branding={room.branding}
            proposal={model.document}
            pricingDisplay={room.proposal.state.proposal.pricing_display}
            selectedSection={open}
            onSelectSection={select}
            sectionFlags={flags}
          />
        </div>
      </div>
      {sending && <DealProposalSend onClose={() => setSending(null)} />}
    </>
  );
}

function SaveState() {
  const { state } = useDealRoom().proposal;
  if (state.error) return <span className="text-xs text-destructive">{state.error}</span>;
  if (state.saving) return <span className="text-xs text-muted-foreground">Saving…</span>;
  if (state.dirty) return <span className="text-xs text-muted-foreground">Unsaved</span>;
  return null;
}

/**
 * The section list as this deal reads it: the deal's own layout once the
 * builder has touched it, the org default until then. Every change writes the
 * whole layout, so the order is never half-saved.
 */
function useLayout() {
  const room = useDealRoom();
  const { state } = room.proposal;
  const entries = normalizeProposalLayout(state.proposal.layout ?? room.proposalDefaults.layout);
  const write = (next: ProposalLayoutEntry[]) => state.update({ layout: normalizeProposalLayout(next) });
  const change = (key: ProposalSectionKey, patch: Partial<ProposalLayoutEntry>) =>
    write(entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  return {
    entries,
    editable: room.editable && room.proposal.available,
    edited: state.proposal.layout !== null,
    entry: (key: ProposalSectionKey) => entries.find((entry) => entry.key === key) ?? null,
    setOn: (key: ProposalSectionKey, on: boolean) => change(key, { on }),
    rename: (key: ProposalSectionKey, title: string) => change(key, { title: title.trim() ? title : null }),
    setBody: (key: ProposalSectionKey, body: string) => change(key, { body }),
    move: (key: ProposalSectionKey, by: -1 | 1) => {
      const from = entries.findIndex((entry) => entry.key === key);
      const to = from + by;
      if (from < 0 || to < 0 || to >= entries.length) return;
      const next = [...entries];
      [next[from], next[to]] = [next[to], next[from]];
      write(next);
    },
    add: () => {
      const key: ProposalSectionKey = `custom:${newId().toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
      // A new section lands just above the signatures, where most added text belongs.
      const at = entries.findIndex((entry) => entry.key === "signatures");
      const next = [...entries];
      next.splice(at < 0 ? next.length : at, 0, { key, title: "New section", on: true, body: "" });
      write(next);
      return key;
    },
    remove: (key: ProposalSectionKey) => write(entries.filter((entry) => entry.key !== key)),
    reset: () => state.update({ layout: null }),
  };
}

function SectionRow({
  section,
  open,
  first,
  last,
  onToggle,
}: {
  section: ProposalSectionState;
  open: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
}) {
  const layout = useLayout();
  const tone = TONE[section.tone];
  return (
    <div
      id={`proposal-section-${section.key}`}
      className={cn(
        "scroll-mt-20 border border-transparent transition-colors duration-150",
        open ? "border-border bg-card shadow-xs" : "hover:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 gap-y-0.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn("size-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-90")}
          />
          <span className={cn("truncate text-sm font-semibold", section.hidden && "text-muted-foreground line-through decoration-border")}>
            {section.name}
          </span>
          <span className={cn("col-start-2 flex min-w-0 items-center gap-1.5 text-xs", tone.text)}>
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
            <span className="truncate">{section.label}</span>
          </span>
        </button>
        {layout.editable && !section.locked && (
          <Switch
            checked={!section.hidden}
            onCheckedChange={(on) => layout.setOn(section.key, on)}
            aria-label={section.hidden ? `Put ${section.name} on the proposal` : `Take ${section.name} off the proposal`}
          />
        )}
      </div>
      {open && (
        <div className="grid gap-3 border-t px-3 pb-3.5 pt-3">
          {section.hidden ? (
            <Note>Off. The client does not see this section. Switch it on to put it back where it was.</Note>
          ) : (
            <SectionEditor sectionKey={section.key} />
          )}
          <SectionArrangement section={section} first={first} last={last} />
        </div>
      )}
    </div>
  );
}

/** The heading the client reads, where the section sits, and, for one you wrote, removing it. */
function SectionArrangement({ section, first, last }: { section: ProposalSectionState; first: boolean; last: boolean }) {
  const layout = useLayout();
  const entry = layout.entry(section.key);
  if (!layout.editable || !entry) return null;
  return (
    <div className="grid gap-2 border-t pt-3">
      <Field label="Heading on the document">
        <Input
          value={entry.title ?? ""}
          placeholder={section.builtIn ? PROPOSAL_DOCUMENT_HEADINGS[section.builtIn] : "Section heading"}
          onChange={(event) => layout.rename(section.key, event.target.value)}
          maxLength={120}
          className="h-8 text-[13px]"
        />
      </Field>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={first}
          onClick={() => layout.move(section.key, -1)}
        >
          <ArrowUp className="size-3.5" />
          Move up
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={last}
          onClick={() => layout.move(section.key, 1)}
        >
          <ArrowDown className="size-3.5" />
          Move down
        </Button>
        {!section.builtIn && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
            onClick={() => layout.remove(section.key)}
          >
            <Trash2 className="size-3.5" />
            Remove
          </Button>
        )}
        {section.locked && <span className="ml-auto text-xs text-muted-foreground">Always on</span>}
      </div>
    </div>
  );
}

function SectionEditor({ sectionKey }: { sectionKey: ProposalSectionKey }) {
  if (!isBuiltInSection(sectionKey)) return <CustomEditor sectionKey={sectionKey} />;
  switch (sectionKey) {
    case "cover":
      return <CoverEditor />;
    case "scope":
      return <ScopeEditor />;
    case "price":
      return <PriceEditor />;
    case "options":
      return <OptionsEditor />;
    case "allowances":
      return <AllowancesEditor />;
    case "inclusions":
      return <InclusionsEditor />;
    case "payments":
      return <PaymentsEditor />;
    case "schedule":
      return <ScheduleEditor />;
    case "terms":
      return <TermsEditor />;
    case "signatures":
      return <SignaturesEditor />;
    case "questions":
      return <QuestionsEditor />;
  }
}

function CustomEditor({ sectionKey }: { sectionKey: ProposalSectionKey }) {
  const layout = useLayout();
  const entry = layout.entry(sectionKey);
  return (
    <Field label="Text" hint="Prints as you write it">
      <Textarea
        value={entry?.body ?? ""}
        onChange={(event) => layout.setBody(sectionKey, event.target.value)}
        disabled={!layout.editable}
        rows={8}
        maxLength={20000}
        placeholder="Warranty, site rules, how you handle selections — anything the client should read."
        className="text-[13px] leading-relaxed"
      />
    </Field>
  );
}

/** The proposal as written, how to change it, and the document it makes. */
function useProposal() {
  const room = useDealRoom();
  const { state, model } = room.proposal;
  return {
    room,
    proposal: state.proposal,
    update: (patch: Partial<DealProposalContent>) => state.update(patch),
    document: model.document,
    defaults: room.proposalDefaults,
    names: model.names,
    editable: room.editable && room.proposal.available,
  };
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium">
      <span className="flex items-baseline justify-between gap-2">
        {label}
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** Reset a section to the default, or make this deal's wording the default for every new deal. */
function DefaultControls({
  field,
  value,
  edited,
  onReset,
  saveLabel = "Save as my default",
}: {
  field: ProposalDefaultField;
  /** Checked on the server against the field's own shape. */
  value: string | string[] | Array<Omit<ProposalPayment, "id">> | ProposalLayoutEntry[];
  edited: boolean;
  onReset: () => void;
  saveLabel?: string;
}) {
  const room = useDealRoom();
  const [saving, startSave] = useTransition();
  const editable = room.editable && room.proposal.available;
  if (!editable) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {edited && (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onReset}>
          Use my default
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        disabled={saving}
        onClick={() =>
          startSave(async () => {
            try {
              unwrapAction(await saveProposalDefaultAction(room.deal.id, { field, value }));
              toast.success("Saved as your default. New deals start from it.");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Unable to save your default.");
            }
          })
        }
      >
        <Save className="size-3.5" />
        {saving ? "Saving…" : saveLabel}
      </Button>
    </div>
  );
}

function CoverEditor() {
  const { proposal, update, document, editable } = useProposal();
  return (
    <>
      <Field label="Letter" hint="Names fill in from the deal">
        <Textarea
          value={proposal.cover ?? document.cover}
          onChange={(event) => update({ cover: event.target.value })}
          disabled={!editable}
          rows={10}
          className="text-[13px] leading-relaxed"
        />
      </Field>
      <DefaultControls field="cover" value={document.cover} edited={proposal.cover !== null} onReset={() => update({ cover: null })} />
    </>
  );
}

function ScopeEditor() {
  const { room, proposal, update, document, editable } = useProposal();
  if (!document.scope.length) return <Note>Add lines on Pricing and each section gets a paragraph here.</Note>;
  return (
    <>
      <Note>One paragraph per section of the price, started from the notes on its lines.</Note>
      {document.scope.map((paragraph) => {
        const written = proposal.scope[paragraph.section] !== undefined;
        return (
          <Field
            key={paragraph.section}
            label={paragraph.section || "The work"}
            hint={
              written ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    const { [paragraph.section]: _removed, ...rest } = proposal.scope;
                    update({ scope: rest });
                  }}
                >
                  Rewrite from line notes
                </button>
              ) : (
                `${paragraph.lines.length} line${paragraph.lines.length === 1 ? "" : "s"}`
              )
            }
          >
            <Textarea
              value={paragraph.text}
              placeholder={`What ${room.deal.client.name.split(" ")[0] || "the client"} gets in ${paragraph.section || "this work"}.`}
              onChange={(event) => update({ scope: { ...proposal.scope, [paragraph.section]: event.target.value } })}
              disabled={!editable}
              rows={4}
              className="text-[13px] leading-relaxed"
            />
          </Field>
        );
      })}
    </>
  );
}

function PriceEditor() {
  const { room, proposal, update, editable } = useProposal();
  const who = room.deal.client.name.split(" ")[0] || "The client";
  return (
    <>
      <Field label="What the client does with it">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={proposal.price_mode}
          disabled={!editable}
          onValueChange={(value) => {
            const choice = PRICE_MODES.find(([key]) => key === value);
            if (choice) update({ price_mode: choice[0] });
          }}
          className="justify-start"
        >
          {PRICE_MODES.map(([value, label]) => (
            <ToggleGroupItem key={value} value={value} className="px-3 text-xs">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Note>
        {proposal.price_mode === "signature"
          ? `${who} gets one total and signs. The payment schedule and signatures are on the document.`
          : `${who} sees a range and approves it. Nothing is signed; send a fixed price when it is ready.`}
      </Note>
      <Field label="Show the price">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={proposal.pricing_display}
          disabled={!editable}
          onValueChange={(value) => {
            const choice = DISPLAY_OPTIONS.find(([key]) => key === value);
            if (choice) update({ pricing_display: choice[0] });
          }}
          className="justify-start"
        >
          {DISPLAY_OPTIONS.map(([value, label]) => (
            <ToggleGroupItem key={value} value={value} className="px-3 text-xs">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Note>
        The amounts come from Pricing and are not edited here.{" "}
        <OptimisticLink href={room.href("pricing")} className="text-primary hover:underline">
          Change the price
        </OptimisticLink>
      </Note>
    </>
  );
}

function OptionsEditor() {
  const { room } = useProposal();
  const options = room.proposal.model.priceLines.filter((line) => line.is_optional);
  const who = room.deal.client.name.split(" ")[0] || "The client";
  return (
    <>
      {options.length ? (
        <ul className="divide-y border text-[13px]">
          {options.map((option, index) => (
            <li key={index} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-2.5 py-2">
              <span className="min-w-0 truncate">{option.description}</span>
              <span className="tabular-nums text-muted-foreground">+{money(option.amount_cents)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Note>No options yet. Mark a line optional on Pricing to offer it.</Note>
      )}
      <Note>
        {who} ticks options on their link and sees the total change. Options are set on{" "}
        <OptimisticLink href={room.href("pricing")} className="text-primary hover:underline">
          Pricing
        </OptimisticLink>
        .
      </Note>
    </>
  );
}

function AllowancesEditor() {
  const { proposal, update, document, defaults, editable } = useProposal();
  return (
    <>
      {document.allowances.length ? (
        <table className="w-full border text-[13px]">
          <tbody className="divide-y">
            {document.allowances.map((item, index) => (
              <tr key={index}>
                <td className="px-2.5 py-1.5">
                  {item.description}
                  {item.section && <span className="block text-[11px] text-muted-foreground">{item.section}</span>}
                </td>
                <td className="px-2.5 py-1.5 text-right tabular-nums">{money(item.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Note>No allowances on Pricing.</Note>
      )}
      <Field label="How allowances work">
        <Textarea
          value={proposal.allowance_policy ?? defaults.allowance_policy}
          onChange={(event) => update({ allowance_policy: event.target.value })}
          disabled={!editable}
          rows={3}
          className="text-[13px]"
        />
      </Field>
      <DefaultControls
        field="allowance_policy"
        value={document.allowance_policy}
        edited={proposal.allowance_policy !== null}
        onReset={() => update({ allowance_policy: null })}
      />
    </>
  );
}

function InclusionsEditor() {
  const { room, proposal, update, document, editable } = useProposal();
  const suggestions = room.proposal.model.suggestions;
  return (
    <>
      {suggestions.length > 0 && (
        <div className="grid border border-warning/30 bg-warning/5">
          <p className="px-2.5 pb-1 pt-2 text-xs font-semibold text-warning">
            The bids you chose leave these out. Say who covers each.
          </p>
          {suggestions.map((suggestion) => (
            <div key={suggestion.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-warning/20 px-2.5 py-2 text-[13px]">
              <span className="min-w-0">
                {suggestion.text}
                <span className="block text-[11px] text-muted-foreground">{suggestion.from}</span>
              </span>
              <span className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={!editable}
                  onClick={() =>
                    update({
                      exclusions: [...document.exclusions, suggestion.text],
                      suggestions: { ...proposal.suggestions, [suggestion.key]: "excluded" },
                    })
                  }
                >
                  Exclude
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={!editable}
                  onClick={() => update({ suggestions: { ...proposal.suggestions, [suggestion.key]: "covered" } })}
                >
                  We cover it
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      <ListEditor
        label="Included"
        field="inclusions"
        items={document.inclusions}
        edited={proposal.inclusions !== null}
        editable={editable}
        onChange={(inclusions) => update({ inclusions })}
        placeholder="Add something you include"
      />
      <ListEditor
        label="Not included"
        field="exclusions"
        items={document.exclusions}
        edited={proposal.exclusions !== null}
        editable={editable}
        onChange={(exclusions) => update({ exclusions })}
        placeholder="Add something you exclude"
      />
    </>
  );
}

function ListEditor({
  label,
  field,
  items,
  edited,
  editable,
  onChange,
  placeholder,
}: {
  label: string;
  field: "inclusions" | "exclusions";
  items: string[];
  edited: boolean;
  editable: boolean;
  onChange: (items: string[] | null) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const text = draft.trim();
    if (!text) return;
    onChange([...items, text]);
    setDraft("");
  }
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-medium">{label}</p>
      {items.length > 0 && (
        <ul className="divide-y border text-[13px]">
          {items.map((item, index) => (
            <li key={`${item}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1 pl-2.5 pr-1">
              <span className="min-w-0">{item}</span>
              {editable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`Remove ${item}`}
                  onClick={() => onChange(items.filter((_, at) => at !== index))}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholder} className="h-8 text-[13px]" />
          <Button type="submit" variant="outline" size="sm" className="h-8" disabled={!draft.trim()} aria-label={`Add to ${label}`}>
            <Plus className="size-3.5" />
          </Button>
        </form>
      )}
      <DefaultControls field={field} value={items} edited={edited} onReset={() => onChange(null)} />
    </div>
  );
}

function PaymentsEditor() {
  const { room, proposal, update, defaults, editable } = useProposal();
  const payments: ProposalPayment[] = proposal.payments ?? defaults.payments.map((payment, index) => ({ ...payment, id: `default-${index}` }));
  const total = room.move.firmness?.total ?? 0;
  const amounts = paymentAmounts(total, payments);
  const percent = paymentPercentTotal(payments);
  const set = (next: ProposalPayment[]) => update({ payments: next });
  const change = (index: number, patch: Partial<ProposalPayment>) =>
    set(payments.map((payment, at) => (at === index ? { ...payment, ...patch } : payment)));
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <th className="px-1 pb-1.5 font-semibold">Payment</th>
              <th className="w-[4.5rem] px-1 pb-1.5 text-right font-semibold">%</th>
              <th className="px-1 pb-1.5 text-right font-semibold">Amount</th>
              <th className="w-7" />
            </tr>
          </thead>
          <tbody>
            {payments.map((payment, index) => (
              <tr key={payment.id} className="border-t align-top">
                <td className="px-1 py-1">
                  <Input
                    value={payment.name}
                    aria-label="Payment name"
                    onChange={(event) => change(index, { name: event.target.value })}
                    disabled={!editable}
                    className="h-8 text-[13px]"
                  />
                  <Input
                    value={payment.when}
                    aria-label="When it is due"
                    placeholder="When it is due"
                    onChange={(event) => change(index, { when: event.target.value })}
                    disabled={!editable}
                    className="mt-1 h-7 border-transparent px-2 text-xs text-muted-foreground shadow-none hover:border-border focus-visible:border-border"
                  />
                </td>
                <td className="px-1 py-1">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step={0.5}
                    value={payment.percent}
                    aria-label={`${payment.name} percent`}
                    onChange={(event) => change(index, { percent: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })}
                    disabled={!editable}
                    className="h-8 text-right font-mono text-[13px] tabular-nums"
                  />
                </td>
                <td className="whitespace-nowrap px-1 py-2.5 text-right font-mono text-xs tabular-nums">{money(amounts[index] ?? 0)}</td>
                <td className="py-1.5">
                  {editable && payments.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={`Remove ${payment.name}`}
                      onClick={() => set(payments.filter((_, at) => at !== index))}
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <td className="px-1 pt-2">
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-7 gap-1 px-2 text-xs"
                    onClick={() => set([...payments, { id: newId(), name: "Payment", when: "", percent: Math.max(0, 100 - percent) }])}
                  >
                    <Plus className="size-3.5" />
                    Add a payment
                  </Button>
                )}
              </td>
              <td className={cn("px-1 pt-2 text-right font-mono tabular-nums", percent === 100 ? "text-success" : "text-destructive")}>
                {percent}%
              </td>
              <td className="px-1 pt-2 text-right font-mono text-xs tabular-nums">{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {percent !== 100 && <p className="text-xs text-destructive">The payments add to {percent}%. They need to add to 100%.</p>}
      <Note>Options the client picks are billed with the first payment. At Start building this becomes the job's draw schedule.</Note>
      <DefaultControls
        field="payments"
        value={payments.map(({ name, when, percent: share }) => ({ name, when, percent: share }))}
        edited={proposal.payments !== null}
        onReset={() => update({ payments: null })}
      />
    </>
  );
}

function ScheduleEditor() {
  const { proposal, update, editable } = useProposal();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
      <Field label="Start window">
        <Input
          value={proposal.start_window}
          placeholder="e.g. the week of January 12"
          onChange={(event) => update({ start_window: event.target.value })}
          disabled={!editable}
          className="h-8 text-[13px]"
        />
      </Field>
      <Field label="Weeks">
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={260}
          value={proposal.duration_weeks ?? ""}
          placeholder="—"
          onChange={(event) => {
            const weeks = Math.round(Number(event.target.value));
            update({ duration_weeks: event.target.value && weeks >= 1 ? Math.min(260, weeks) : null });
          }}
          disabled={!editable}
          className="h-8 text-right text-[13px] tabular-nums"
        />
      </Field>
      <p className="col-span-2 text-xs text-muted-foreground">The client reads it as a window, and you confirm the date when they sign.</p>
    </div>
  );
}

function TermsEditor() {
  const { proposal, update, document, defaults, names, editable } = useProposal();
  return (
    <>
      <Field label="Valid for" hint={`Until ${new Date(`${document.valid_until}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`}>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            value={proposal.valid_days}
            onChange={(event) => update({ valid_days: Math.max(1, Math.min(365, Math.round(Number(event.target.value)) || 1)) })}
            disabled={!editable}
            className="h-8 w-20 text-right text-[13px] tabular-nums"
          />
          <span className="text-xs text-muted-foreground">days from sending</span>
        </div>
      </Field>
      <Field label="Terms">
        <Textarea
          value={proposal.terms ?? fillProposalTemplate(defaults.terms, names)}
          onChange={(event) => update({ terms: event.target.value })}
          disabled={!editable}
          rows={8}
          className="text-[13px] leading-relaxed"
        />
      </Field>
      <DefaultControls field="terms" value={document.terms} edited={proposal.terms !== null} onReset={() => update({ terms: null })} />
    </>
  );
}

function SignaturesEditor() {
  const { room, proposal } = useProposal();
  const { client } = room.deal;
  const signers = [{ name: client.name, email: client.email }, ...proposal.co_signers];
  const me = room.members.find((member) => member.id === room.currentUserId)?.name ?? "You";
  return (
    <>
      <ol className="grid gap-1.5 text-[13px]">
        {signers.map((signer, index) => (
          <li key={index} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2.5 border px-2.5 py-2">
            <span className="text-xs font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{signer.name || "No name yet"}</span>
              <span className="block truncate text-xs text-muted-foreground">{signer.email || "No email yet"}</span>
            </span>
          </li>
        ))}
        <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2.5 border border-dashed px-2.5 py-2 text-muted-foreground">
          <span className="text-xs font-semibold tabular-nums">{signers.length + 1}</span>
          <span>{me} countersigns for {room.branding.name || "the company"}</span>
        </li>
      </ol>
      <div className="flex items-center justify-between gap-2">
        <Note>Each signer gets their own link. You set who signs when you send.</Note>
        {room.editable && proposal.price_mode === "signature" && (
          <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => room.act({ kind: "send", document: "agreement" })}>
            Change signers
          </Button>
        )}
      </div>
    </>
  );
}

function QuestionsEditor() {
  const room = useDealRoom();
  const { comments } = room.proposal;
  return (
    <>
      {comments.length ? (
        <ul className="grid gap-2">
          {comments.map((comment) => (
            <CommentThread key={comment.id} comment={comment} />
          ))}
        </ul>
      ) : (
        <Note>
          {room.deal.client.name.split(" ")[0] || "The client"} can ask about any section on their link. Their questions land here.
        </Note>
      )}
      <DealQuestions dealId={room.deal.id} clientName={room.deal.client.name} questions={room.questions} editable={room.editable} />
    </>
  );
}

function CommentThread({ comment }: { comment: ProposalComment }) {
  const room = useDealRoom();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [sending, startSend] = useTransition();
  const where = comment.section ? room.proposal.model.states.find((state) => state.key === comment.section)?.name : null;
  return (
    <li className="grid gap-1.5 border px-2.5 py-2 text-[13px]">
      <p className="text-[11px] text-muted-foreground">
        {comment.author}
        {where ? ` on ${where}` : ""} · {shortDate(comment.createdAt)}
      </p>
      <p className="whitespace-pre-wrap">{comment.body}</p>
      {comment.answer ? (
        <div className="bg-muted px-2.5 py-1.5">
          <p className="text-[11px] text-muted-foreground">
            {comment.answer.author} · {shortDate(comment.answer.createdAt)}
          </p>
          <p className="whitespace-pre-wrap">{comment.answer.body}</p>
        </div>
      ) : (
        room.editable && (
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              startSend(async () => {
                try {
                  unwrapAction(await answerProposalCommentAction(room.deal.id, comment.id, draft));
                  setDraft("");
                  toast.success("Answered. They see it on the document.");
                  router.refresh();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Unable to send the answer.");
                }
              });
            }}
          >
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Answer" rows={2} className="text-[13px]" />
            <Button type="submit" size="sm" className="h-7 justify-self-end px-3 text-xs" disabled={sending || !draft.trim()}>
              {sending ? "Sending…" : "Answer"}
            </Button>
          </form>
        )
      )}
    </li>
  );
}

function Versions({ versions, truncated, who }: { versions: DealDocumentVersion[]; truncated: boolean; who: string }) {
  return (
    <section className="border bg-card">
      <h2 className="border-b px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Versions sent</h2>
      {versions.length ? (
        <ol className="divide-y">
          {versions.map((version) => {
            const status = STATUS[version.status] ?? { label: version.status.replaceAll("_", " "), tone: "text-muted-foreground" };
            return (
              <li key={version.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13px]">
                <span className="font-medium">
                  Proposal v{version.version}
                  {version.purpose === "budget" && <span className="font-normal text-muted-foreground"> · estimate</span>}
                </span>
                <a
                  href={`/estimates/${version.id}/export`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  PDF
                  <ArrowUpRight className="size-3" />
                </a>
                <span className={cn("text-xs", status.tone)}>
                  {status.label}
                  {version.sentAt && <span className="text-muted-foreground"> · sent {shortDate(version.sentAt)}</span>}
                  {version.viewedAt && <span className="text-muted-foreground"> · opened {shortDate(version.viewedAt)}</span>}
                </span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {version.totalCents ? money(version.totalCents) : ""}
                </span>
                {version.decisionNote && (
                  <span className="col-span-2 mt-1 bg-muted px-2 py-1 text-xs text-muted-foreground">“{version.decisionNote}”</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Not sent yet. What you see is exactly what {who} will get.</p>
      )}
      {truncated && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the {versions.length} newest versions.</p>}
    </section>
  );
}
