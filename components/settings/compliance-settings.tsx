"use client"

import { useState, useTransition } from "react"

import type { ComplianceRules } from "@/lib/types"
import { updateComplianceRulesAction } from "@/app/(app)/settings/compliance/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"

export function ComplianceSettings({
  initialRules,
  canManage,
}: {
  initialRules: ComplianceRules
  canManage: boolean
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [rules, setRules] = useState<ComplianceRules>(initialRules)

  const setRule = (key: keyof ComplianceRules, value: boolean) => {
    setRules((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    startTransition(async () => {
      try {
        await updateComplianceRulesAction(rules)
        toast({ title: "Compliance rules updated" })
      } catch (error: any) {
        toast({ title: "Unable to update rules", description: error?.message ?? "Try again." })
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compliance rules</CardTitle>
        <CardDescription>Configure which documents block vendor payments.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <Label className="text-sm font-medium">Require W-9</Label>
            <p className="text-xs text-muted-foreground">Block payments when W-9 is missing.</p>
          </div>
          <Switch
            checked={rules.require_w9 ?? false}
            onCheckedChange={(checked) => setRule("require_w9", checked)}
            disabled={!canManage}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <Label className="text-sm font-medium">Require insurance (COI)</Label>
            <p className="text-xs text-muted-foreground">Block payments when insurance is missing or expired.</p>
          </div>
          <Switch
            checked={rules.require_insurance ?? false}
            onCheckedChange={(checked) => setRule("require_insurance", checked)}
            disabled={!canManage}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <Label className="text-sm font-medium">Require license</Label>
            <p className="text-xs text-muted-foreground">Block payments when license is missing or expired.</p>
          </div>
          <Switch
            checked={rules.require_license ?? false}
            onCheckedChange={(checked) => setRule("require_license", checked)}
            disabled={!canManage}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <Label className="text-sm font-medium">Require lien waiver</Label>
            <p className="text-xs text-muted-foreground">Block payments until a waiver is received.</p>
          </div>
          <Switch
            checked={rules.require_lien_waiver ?? false}
            onCheckedChange={(checked) => setRule("require_lien_waiver", checked)}
            disabled={!canManage}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <Label className="text-sm font-medium">Block payments on missing docs</Label>
            <p className="text-xs text-muted-foreground">Disable to allow payment overrides.</p>
          </div>
          <Switch
            checked={rules.block_payment_on_missing_docs ?? false}
            onCheckedChange={(checked) => setRule("block_payment_on_missing_docs", checked)}
            disabled={!canManage}
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!canManage || isPending}>
            {isPending ? "Saving..." : "Save rules"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
