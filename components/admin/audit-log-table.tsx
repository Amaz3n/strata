import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Eye, EyeOff } from "@/components/icons"
import Link from "next/link"
import { getAuditLogs } from "@/lib/services/admin"
import { formatDistanceToNow, format } from "date-fns"

interface AuditLogTableProps {
  search: string
  action: string
  entityType: string
  user: string
  page: number
}

export async function AuditLogTable({ search, action, entityType, user, page }: AuditLogTableProps) {
  const { auditLogs, totalCount, hasNextPage, hasPrevPage } = await getAuditLogs({
    search,
    action: action === 'all' ? undefined : action,
    entityType: entityType === 'all' ? undefined : entityType,
    user: user === 'all' ? undefined : user,
    page,
    limit: 50,
  })

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Timestamp</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {auditLogs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No audit log entries found matching your criteria
                </TableCell>
              </TableRow>
            ) : (
              auditLogs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">
                          {log.userInitials}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="font-medium">{log.userName}</div>
                        <div className="text-sm text-muted-foreground">
                          {log.userEmail}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getActionVariant(log.action)}>
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div>
                      <div className="font-medium capitalize">
                        {log.entityType.replace('_', ' ')}
                      </div>
                      {log.entityId && (
                        <div className="text-sm text-muted-foreground font-mono">
                          {log.entityId.slice(0, 8)}...
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-xs truncate text-sm">
                      {log.description || 'No details available'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">
                      <div>{format(new Date(log.createdAt), 'MMM d, yyyy')}</div>
                      <div className="text-muted-foreground">
                        {format(new Date(log.createdAt), 'HH:mm:ss')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/admin/audit/${log.id}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {(hasNextPage || hasPrevPage) && (
        <div className="flex justify-between items-center">
          <Button
            variant="outline"
            disabled={!hasPrevPage}
            asChild={hasPrevPage}
          >
            {hasPrevPage ? (
              <Link href={`/admin/audit?page=${page - 1}&search=${search}&action=${action}&entityType=${entityType}&user=${user}`}>
                Previous
              </Link>
            ) : (
              <span>Previous</span>
            )}
          </Button>

          <div className="text-sm text-muted-foreground">
            Page {page} • {totalCount} total entries
          </div>

          <Button
            variant="outline"
            disabled={!hasNextPage}
            asChild={hasNextPage}
          >
            {hasNextPage ? (
              <Link href={`/admin/audit?page=${page + 1}&search=${search}&action=${action}&entityType=${entityType}&user=${user}`}>
                Next
              </Link>
            ) : (
              <span>Next</span>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

function getActionVariant(action: string) {
  switch (action) {
    case 'insert':
      return 'default'
    case 'update':
      return 'secondary'
    case 'delete':
      return 'destructive'
    default:
      return 'outline'
  }
}