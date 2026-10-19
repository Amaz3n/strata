"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Plus, Send, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { sendDealPriceAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { money } from "@/lib/precon/format";
import { firstNames, proposalSignerSchema, type ProposalSectionKey, type ProposalSigner } from "@/lib/precon/proposal-documents";
import { cn } from "@/lib/utils";
import { useDealRoom } from "./deal-room";

/** Up to three people sign beside the client; the proposal's own limit. */
const MAX_CO_SIGNERS = 3;

/**
 * The last step before the client gets it: who signs and in what order (each on
 * a link of their own, you last), what the email says, and what changed since
 * the version they have. The document itself was reviewed on the tab behind this.
 */
export function DealProposalSend({ onClose }: { onClose: () => void }) {
  const room = useDealRoom();
  const router = useRouter();
  const { deal, move } = room;
  const { model } = room.proposal;
  const agreement = model.kind === "agreement";
  const [client, setClient] = useState<ProposalSigner>({ name: deal.client.name, email: deal.client.email });
  const [coSigners, setCoSigners] = useState<ProposalSigner[]>(room.proposal.state.proposal.co_signers);
  const signers = agreement ? [client, ...coSigners] : [client];
  const greeting = firstNames(signers.map((person) => person.name.trim()).filter(Boolean)) || "there";
  const [message, setMessage] = useState(() =>
    agreement
      ? `Hi ${greeting},\n\nHere is the proposal for ${deal.name}. Pick any options you want, ask about anything right on that section, and sign when you're ready.`
      : `Hi ${greeting},\n\nHere is the proposal for ${deal.name}. The price is an estimated range while a few prices firm up. Have a look, ask about anything on the section itself, and approve it if it works for you.`,
  );
  const [sending, startSend] = useTransition();
  const last = room.proposal.lastSent;
  const openQuestions = room.questions.filter((question) => question.status === "open").length;
  const range = move.firmness?.range;
  const price = agreement || !range ? `${money(move.firmness?.total ?? 0)} fixed price` : `${money(range.low)}–${money(range.high)} estimate`;

  const invalid = signers.map((person) => !proposalSignerSchema.safeParse(person).success);
  const emails = signers.map((person) => person.email.trim().toLowerCase());
  const repeated = emails.map((email, index) => Boolean(email) && emails.indexOf(email) !== index);
  const signerProblem = invalid.some(Boolean)
    ? "Every signer needs a name and a valid email."
    : repeated.some(Boolean)
      ? "Each signer needs their own email address."
      : null;
  const blocked = model.needs.length > 0 || signerProblem !== null || !room.editable;

  function editCoSigner(index: number, patch: Partial<ProposalSigner>) {
    setCoSigners((previous) => previous.map((person, at) => (at === index ? { ...person, ...patch } : person)));
  }

  function send() {
    startSend(async () => {
      try {
        if (agreement) {
          const next = coSigners.map((person) => ({ name: person.name.trim(), email: person.email.trim() }));
          if (JSON.stringify(next) !== JSON.stringify(room.proposal.state.proposal.co_signers))
            room.proposal.state.update({ co_signers: next });
        }
        const [worksheetVersion, proposalVersion] = await Promise.all([room.state.save(), room.proposal.state.save()]);
        const result = unwrapAction(
          await sendDealPriceAction(deal.id, model.kind, worksheetVersion, proposalVersion, message, {
            name: client.name.trim(),
            email: client.email.trim(),
          }),
        );
        if (result.emailSent) toast.success(`Sent to ${signers.map((person) => person.email.trim()).join(" and ")}`);
        else toast.warning("The proposal is ready, but an email did not go out. Use Remind to send it again.");
        onClose();
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to send. Nothing went out.");
      }
    });
  }

  function openSection(key: ProposalSectionKey) {
    onClose();
    room.act({ kind: "open_proposal", section: key });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{agreement ? "Send for signature" : "Send for approval"}</DialogTitle>
          <DialogDescription>
            Proposal{last ? ` v${last.version + 1}` : ""} for {deal.name} · <span className="tabular-nums">{price}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-5 overflow-y-auto px-5 py-4">
          {model.needs.length > 0 && (
            <section className="border border-warning/30 bg-warning/5">
              <p className="flex items-center gap-2 px-3 py-2 text-[13px] font-semibold text-warning">
                <AlertTriangle className="size-4" />
                {model.needs.length === 1 ? "One section needs you first" : `${model.needs.length} sections need you first`}
              </p>
              <ul className="divide-y divide-warning/20 border-t border-warning/20">
                {model.needs.map((need) => (
                  <li key={need.key}>
                    <button
                      type="button"
                      onClick={() => openSection(need.key)}
                      className="grid w-full grid-cols-[7rem_minmax(0,1fr)] gap-3 px-3 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-warning/10"
                    >
                      <span className="truncate font-medium">{need.name}</span>
                      <span className="text-muted-foreground">{need.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Group
            title={agreement ? "Signing order" : "Who gets it"}
            aside={agreement && signers.length > 1 ? "Each gets their own link" : undefined}
          >
            <ol className="grid gap-1.5">
              <SignerRow
                index={0}
                role="Client"
                signer={client}
                invalid={invalid[0] || repeated[0]}
                disabled={sending || !room.editable}
                onChange={(patch) => setClient((previous) => ({ ...previous, ...patch }))}
              />
              {agreement &&
                coSigners.map((person, index) => (
                  <SignerRow
                    key={index}
                    index={index + 1}
                    role="Co-signer"
                    signer={person}
                    invalid={invalid[index + 1] || repeated[index + 1]}
                    disabled={sending || !room.editable}
                    onChange={(patch) => editCoSigner(index, patch)}
                    onRemove={() => setCoSigners((previous) => previous.filter((_, at) => at !== index))}
                  />
                ))}
              {agreement && (
                <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2.5 border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
                  <span className="text-xs font-semibold tabular-nums">{signers.length + 1}</span>
                  <span>You countersign once {signers.length > 1 ? "everyone has" : "they have"} signed</span>
                </li>
              )}
            </ol>
            {agreement && coSigners.length < MAX_CO_SIGNERS && room.editable && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 justify-self-start px-2 text-xs"
                disabled={sending}
                onClick={() => setCoSigners((previous) => [...previous, { name: "", email: "" }])}
              >
                <Plus className="size-3.5" />
                Add a signer
              </Button>
            )}
            {agreement && openQuestions > 0 && (
              <p className="text-xs text-muted-foreground">
                {openQuestions === 1 ? "One question is" : `${openQuestions} questions are`} still open. They are answered on the
                proposal before anyone signs.
              </p>
            )}
          </Group>

          <Group title="Message">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={6}
              maxLength={4000}
              disabled={sending}
              className="text-[13px] leading-relaxed"
              aria-label="Message to the client"
            />
          </Group>

          {last && (
            <Group title={`What changed since v${last.version}`} aside="Printed at the top of the proposal">
              {model.changes.length ? (
                <dl className="divide-y">
                  {model.changes.map((change) => (
                    <div key={change.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-1.5 text-[13px] first:pt-0">
                      <dt className="text-xs text-muted-foreground">{change.label}</dt>
                      <dd>{change.text}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-[13px] text-muted-foreground">Nothing they would notice. The wording may have changed.</p>
              )}
            </Group>
          )}
        </div>

        <DialogFooter className="flex-wrap items-center gap-2 border-t px-5 py-3">
          {(model.needs.length > 0 || signerProblem) && (
            <p className="mr-auto text-xs text-muted-foreground">
              {model.needs.length ? "Finish the sections above to send." : signerProblem}
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || blocked} className="gap-2">
            <Send className="size-4" />
            {sending ? "Sending…" : agreement ? "Send for signature" : "Send for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignerRow({
  index,
  role,
  signer,
  invalid,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  role: string;
  signer: ProposalSigner;
  invalid: boolean;
  disabled: boolean;
  onChange: (patch: Partial<ProposalSigner>) => void;
  onRemove?: () => void;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1.2fr)_1.75rem] items-center gap-2 border px-3 py-2">
      <span className="text-xs font-semibold tabular-nums text-muted-foreground" title={role}>
        {index + 1}
      </span>
      <Input
        value={signer.name}
        placeholder={index === 0 ? "Client's full name" : "Full name"}
        aria-label={`Signer ${index + 1} name`}
        onChange={(event) => onChange({ name: event.target.value })}
        disabled={disabled}
        className="h-8 text-[13px]"
      />
      <Input
        type="email"
        value={signer.email}
        placeholder="Email"
        aria-label={`Signer ${index + 1} email`}
        aria-invalid={invalid && Boolean(signer.email.trim()) ? true : undefined}
        onChange={(event) => onChange({ email: event.target.value })}
        disabled={disabled}
        className={cn("h-8 text-[13px]", invalid && signer.email.trim() && "border-destructive")}
      />
      {onRemove ? (
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Remove signer ${index + 1}`} onClick={onRemove} disabled={disabled}>
          <X className="size-3.5" />
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

function Group({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
