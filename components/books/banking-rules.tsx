"use client";

import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { createBankManualRuleAction, deleteBankManualRuleAction, listBankManualRulesAction, setBankManualRuleActiveAction, updateBankManualRuleAction } from "@/app/(app)/books/actions";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { BankManualRuleListing } from "@/lib/services/books/bank-manual-rules";
import { BankingRuleEditor, type BankingRuleDraft, type BankingRuleOption } from "./banking-rule-editor";

type BankManualRule = BankManualRuleListing[number];

type Props = { active: boolean; canEdit: boolean; categories: BankingRuleOption[]; vendors: BankingRuleOption[]; bankAccounts: BankingRuleOption[]; onChanged?: () => void };

const conditionText = (rule: BankManualRule) => rule.matchKind === "merchant_exact" ? `Merchant is “${rule.matchValue}”` : `Description contains “${rule.matchValue}”`;
const scopeText = (rule: BankManualRule) => `${rule.bankAccountName ?? "Any bank account"} · ${rule.direction === "inflow" ? "money in" : rule.direction === "outflow" ? "money out" : "any direction"}`;
const toDraft = (rule: BankManualRule): BankingRuleDraft => ({ matchKind: rule.matchKind, matchValue: rule.matchValue, direction: rule.direction, bankAccountId: rule.bankAccountId, glAccountId: rule.glAccountId, vendorId: rule.vendorId });

export function BankingRules({ active, canEdit, categories, vendors, bankAccounts, onChanged }: Props) {
  const [rules, setRules] = useState<BankManualRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<BankManualRule | null>(null);
  const [deleting, setDeleting] = useState<BankManualRule | null>(null);
  const editorInitialValue = useMemo(() => editing ? toDraft(editing) : null, [editing]);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listBankManualRulesAction();
      if (result.success) setRules(result.data);
      else setError(result.error ?? "Could not load bank rules");
    } catch {
      setError("Could not load bank rules");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (active && canEdit) void reload(); }, [active, canEdit]);

  return (
    <>
      <Accordion type="single" collapsible className="border-t">
        <AccordionItem value="bank-rules">
          <AccordionTrigger className="py-5 hover:no-underline">
            <span className="min-w-0">
              <span className="block text-left text-sm font-semibold">Bank rules</span>
              <span className="mt-0.5 block text-left text-xs font-normal text-muted-foreground">
                {rules.length ? `${rules.length} ${rules.length === 1 ? "rule" : "rules"}` : "Rules for matching transactions"}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-5">
            <div className="mb-3 flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground">Rules you create take priority over learned suggestions.</p>
              {canEdit && <Button size="sm" variant="outline" onClick={() => { setEditing(null); setEditorOpen(true); }}><Plus className="size-3.5" />New rule</Button>}
            </div>
            {!canEdit ? (
              <p className="border-y py-5 text-sm text-muted-foreground">Rule management requires banking review access.</p>
            ) : loading ? (
              <p className="border-y py-5 text-sm text-muted-foreground">Loading rules…</p>
            ) : error ? (
              <div className="flex items-center justify-between gap-3 border-y py-4"><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="ghost" onClick={() => void reload()}>Try again</Button></div>
            ) : rules.length === 0 ? (
              <div className="border-y py-7 text-center"><p className="text-sm font-medium">No bank rules</p><p className="mt-1 text-xs text-muted-foreground">Create one for transactions you categorize the same way every time.</p></div>
            ) : (
              <div className="border-y">
                {rules.map((rule) => (
                  <div key={rule.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b py-3 last:border-b-0">
                    <div className={rule.active ? "min-w-0" : "min-w-0 opacity-55"}>
                      <p className="truncate text-sm font-medium">{conditionText(rule)}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{rule.vendorName ? `${rule.vendorName} · ` : ""}{rule.accountCode} · {rule.accountName}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{scopeText(rule)}</p>
                    </div>
                    <Switch checked={rule.active} disabled={busy === rule.id} aria-label={`${rule.active ? "Pause" : "Enable"} ${conditionText(rule)}`} onCheckedChange={async (checked) => {
                      setBusy(rule.id);
                      try {
                        const result = await setBankManualRuleActiveAction({ ruleId: rule.id, active: checked });
                        if (!result.success) return toast.error(result.error);
                        setRules((current) => current.map((item) => item.id === rule.id ? { ...item, active: checked } : item));
                        onChanged?.();
                      } catch { toast.error("Could not update this bank rule"); }
                      finally { setBusy(null); }
                    }} />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${conditionText(rule)}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => { setEditing(rule); setEditorOpen(true); }}>Edit rule</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(rule)}>Delete rule</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <BankingRuleEditor open={editorOpen} onOpenChange={setEditorOpen} initialValue={editorInitialValue} categories={categories} vendors={vendors} bankAccounts={bankAccounts} onSave={async (draft) => {
        const result = editing ? await updateBankManualRuleAction({ ruleId: editing.id, ...draft }) : await createBankManualRuleAction(draft);
        if (!result.success) throw new Error(result.error);
        await reload();
        onChanged?.();
        toast.success(editing ? "Bank rule updated" : "Bank rule created");
      }} />

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete this bank rule?</AlertDialogTitle><AlertDialogDescription>Future transactions will stop using this rule. Existing categorizations will not change.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={async () => {
            if (!deleting) return;
            try {
              const result = await deleteBankManualRuleAction({ ruleId: deleting.id });
              if (!result.success) return toast.error(result.error);
              setRules((current) => current.filter((item) => item.id !== deleting.id));
              onChanged?.();
              toast.success("Bank rule deleted");
            } catch { toast.error("Could not delete this bank rule"); }
          }}>Delete rule</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
