import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import Link from "next/link"
import { getSupportContracts } from "@/lib/services/admin"
import { formatDistanceToNow, format } from "date-fns"

interface SupportContract {
  id: string
  orgId: string
  orgName: string
  status: string
  tier: string
  startsAt: string
  endsAt: string | null
  createdAt: string
}

export async function SupportContractsTable() {
  const contracts = await getSupportContracts()

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Start Date</TableHead>
              <TableHead>End Date</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contracts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No support contracts have been created yet.
                </TableCell>
              </TableRow>
            ) : (
              contracts.map((contract) => (
                <TableRow key={contract.id}>
                  <TableCell>
                    <div>
                      <div className="font-medium">{contract.orgName}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {contract.tier}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={contract.status === 'active' ? 'default' : 'secondary'}>
                      {contract.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">
                      {format(new Date(contract.startsAt), 'MMM d, yyyy')}
                    </div>
                  </TableCell>
                  <TableCell>
                    {contract.endsAt ? (
                      <div className="text-sm">
                        {new Date(contract.endsAt) > new Date() ? (
                          <span className="text-green-600">
                            {format(new Date(contract.endsAt), 'MMM d, yyyy')}
                          </span>
                        ) : (
                          <span className="text-red-600">
                            Expired {format(new Date(contract.endsAt), 'MMM d, yyyy')}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(contract.createdAt), { addSuffix: true })}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}