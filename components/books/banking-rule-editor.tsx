"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type BankingRuleOption = { id: string; name: string };
export type BankingRuleDraft = {
  matchKind: "merchant_exact" | "description_contains";
  matchValue: string;
  direction: "inflow" | "outflow" | null;
  bankAccountId: string | null;
  glAccountId: string;
  vendorId: string | null;
};

const emptyDraft: BankingRuleDraft = { matchKind: "merchant_exact", matchValue: "", direction: null, bankAccountId: null, glAccountId: "", vendorId: null };

export function BankingRuleEditor({ open, onOpenChange, initialValue, categories, vendors, bankAccounts, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: BankingRuleDraft | null;
  categories: BankingRuleOption[];
  vendors: BankingRuleOption[];
  bankAccounts: BankingRuleOption[];
  onSave: (draft: BankingRuleDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<BankingRuleDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialValue ?? emptyDraft);
    setError(null);
  }, [open, initialValue]);

  const valid = draft.matchValue.trim().length >= 2 && Boolean(draft.glAccountId);
  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, matchValue: draft.matchValue.trim() });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this rule");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initialValue ? "Edit bank rule" : "New bank rule"}</DialogTitle>
          <DialogDescription>Set a clear condition and the categorization to apply.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-5 overflow-y-auto py-2 pr-1">
          <div className="grid gap-2">
            <Label htmlFor="bank-rule-condition">When a transaction matches</Label>
            <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
              <Select value={draft.matchKind} onValueChange={(value) => setDraft((current) => ({ ...current, matchKind: value as BankingRuleDraft["matchKind"] }))}>
                <SelectTrigger aria-label="Match field"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="merchant_exact">Merchant is exactly</SelectItem><SelectItem value="description_contains">Description contains</SelectItem></SelectContent>
              </Select>
              <Input id="bank-rule-condition" autoFocus maxLength={160} value={draft.matchValue} placeholder={draft.matchKind === "merchant_exact" ? "Uber" : "UBER *TRIP"} onChange={(event) => setDraft((current) => ({ ...current, matchValue: event.target.value }))} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Then categorize it as</Label>
            <Select value={draft.glAccountId} onValueChange={(glAccountId) => setDraft((current) => ({ ...current, glAccountId }))}>
              <SelectTrigger aria-label="Category"><SelectValue placeholder="Choose category" /></SelectTrigger>
              <SelectContent>{categories.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Vendor <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Select value={draft.vendorId ?? "any"} onValueChange={(value) => setDraft((current) => ({ ...current, vendorId: value === "any" ? null : value }))}>
              <SelectTrigger aria-label="Vendor"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="any">Leave vendor unchanged</SelectItem>{vendors.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 border-t pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Optional scope</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>Bank account</Label>
                <Select value={draft.bankAccountId ?? "any"} onValueChange={(value) => setDraft((current) => ({ ...current, bankAccountId: value === "any" ? null : value }))}>
                  <SelectTrigger aria-label="Bank account"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="any">Any account</SelectItem>{bankAccounts.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Direction</Label>
                <Select value={draft.direction ?? "any"} onValueChange={(value) => setDraft((current) => ({ ...current, direction: value === "any" ? null : value as BankingRuleDraft["direction"] }))}>
                  <SelectTrigger aria-label="Direction"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="any">Money in or out</SelectItem><SelectItem value="outflow">Money out</SelectItem><SelectItem value="inflow">Money in</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid || saving} onClick={() => void submit()}>{saving && <Loader2 className="size-4 animate-spin" />}{saving ? "Saving…" : initialValue ? "Save changes" : "Create rule"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
