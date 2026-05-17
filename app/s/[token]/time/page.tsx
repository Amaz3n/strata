import { notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { validatePortalToken, loadSubPortalData } from "@/lib/services/portal-access"
import { PortalHeader } from "@/components/portal/portal-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { submitPortalTimeAction } from "./actions"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function PortalTimePage({ params }: Props) {
  const { token } = await params
  const access = await validatePortalToken(token)
  if (!access || access.portal_type !== "sub" || !access.company_id) notFound()

  const [data, costCodesResult] = await Promise.all([
    loadSubPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
    }),
    createServiceSupabaseClient()
      .from("cost_codes")
      .select("id, code, name")
      .eq("org_id", access.org_id)
      .eq("is_active", true)
      .order("code"),
  ])
  const costCodes = costCodesResult.data ?? []

  return (
    <div className="min-h-screen bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />
      <main className="mx-auto w-full max-w-xl px-4 py-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href={`/s/${token}`}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Submit time</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={submitPortalTimeAction.bind(null, token)} className="space-y-4" encType="multipart/form-data">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input name="work_date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
                </div>
                <div className="space-y-2">
                  <Label>Burden</Label>
                  <Input name="burden_multiplier" type="number" min="1" step="0.01" defaultValue="1" />
                </div>
              </div>
              <div className="space-y-3">
                <Label>Crew lines</Label>
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1.2fr_0.7fr_0.8fr_1.2fr]">
                    <Input name="worker_name" placeholder={index === 0 ? "Worker name" : "Optional worker"} required={index === 0} />
                    <Input name="hours" type="number" step="0.25" min="0.25" max="24" placeholder="Hours" required={index === 0} />
                    <Input name="base_rate" inputMode="decimal" placeholder="Rate" required={index === 0} />
                    <Select name="cost_code_id">
                      <SelectTrigger>
                        <SelectValue placeholder="Cost code" />
                      </SelectTrigger>
                      <SelectContent>
                        {costCodes.map((code: any) => (
                          <SelectItem key={code.id} value={code.id}>{code.code} {code.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Label>Photo or signed ticket</Label>
                <Input name="attachment" type="file" accept="image/*,application/pdf" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="is_billable" defaultChecked />
                Billable
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="is_overtime" />
                Overtime
              </label>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea name="notes" rows={4} />
              </div>
              <Button type="submit" className="w-full">Submit time</Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
