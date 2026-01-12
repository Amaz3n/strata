"use client"

import { useState } from "react"
import type { CostCode, Company } from "@/lib/types"
import type { CommitmentSummary } from "@/lib/services/commitments"
import { ProjectBudgetClient } from "@/components/budgets/project-budget-client"
import { ProjectCommitmentsClient } from "@/components/commitments/project-commitments-client"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DollarSign, Users } from "lucide-react"

interface BudgetTabProps {
  projectId: string
  budgetData: any | null
  costCodes: CostCode[]
  varianceAlerts: any[]
  commitments: CommitmentSummary[]
  companies: Company[]
}

export function BudgetTab({
  projectId,
  budgetData,
  costCodes,
  varianceAlerts,
  commitments,
  companies,
}: BudgetTabProps) {
  const [subTab, setSubTab] = useState<"budget" | "commitments">("budget")

  return (
    <div className="space-y-4">
      {/* Sub-tabs for Budget and Commitments */}
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "budget" | "commitments")}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="budget" className="gap-2">
            <DollarSign className="h-4 w-4" />
            Budget
          </TabsTrigger>
          <TabsTrigger value="commitments" className="gap-2">
            <Users className="h-4 w-4" />
            Commitments
          </TabsTrigger>
        </TabsList>

        <TabsContent value="budget" className="mt-4">
          <ProjectBudgetClient
            projectId={projectId}
            budgetData={budgetData}
            costCodes={costCodes}
            varianceAlerts={varianceAlerts}
          />
        </TabsContent>

        <TabsContent value="commitments" className="mt-4">
          <ProjectCommitmentsClient
            projectId={projectId}
            commitments={commitments}
            companies={companies}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
