const fs = require('fs');

const path = './components/esign/signatures-hub-client.tsx';
let content = fs.readFileSync(path, 'utf8');

const startIdx = content.indexOf('  return (\n    <TooltipProvider>\n      <div className="space-y-6">\n        {/* Summary Cards */}');
const endMarker = '          </Table>\n        </div>\n\n        <EnvelopeWizard';
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
    console.error('Could not find start or end index');
    process.exit(1);
}

const replacement = `  return (
    <TooltipProvider>
      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search document, project, recipient, or status"
              className="w-full sm:w-80"
            />
            <div className="flex items-center gap-2">
              <Select value={queueFilter} onValueChange={(value) => setQueueFilter(value as QueueFilter)}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue placeholder="Filter queue" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All envelopes</SelectItem>
                  <SelectItem value="waiting">Waiting on signers</SelectItem>
                  <SelectItem value="executed">Executed envelopes</SelectItem>
                  <SelectItem value="expiring">Expiring soon</SelectItem>
                  <SelectItem value="drafts">Drafts only</SelectItem>
                  <SelectItem value="voided">Voided / Canceled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto sm:items-center">
            {scope === "org" ? (
              <Select value={newEnvelopeProjectId} onValueChange={setNewEnvelopeProjectId} disabled={projectsForNewEnvelope.length === 0}>
                <SelectTrigger className="w-full sm:w-60">
                  <SelectValue placeholder="Project for new envelope" />
                </SelectTrigger>
                <SelectContent>
                  {projectsForNewEnvelope.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            <Button onClick={handleStartStandaloneEnvelope} disabled={!newEnvelopeProjectId} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New Envelope
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="pl-4 py-3 w-[25%] min-w-[200px]">Document</TableHead>
                <TableHead className="py-3 text-center w-[120px]">Type</TableHead>
                {scope === "org" ? <TableHead className="py-3 w-[15%] min-w-[120px]">Project</TableHead> : null}
                <TableHead className="py-3 w-[15%] min-w-[150px]">Signers</TableHead>
                <TableHead className="py-3 text-center w-[130px]">Status</TableHead>
                <TableHead className="py-3 w-[150px]">Progress</TableHead>
                <TableHead className="py-3 w-[120px]">Expires</TableHead>
                <TableHead className="pr-4 py-3 text-right w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => {
                const isPending = pendingActionId === row.envelope_id
                const availableActions = getAvailableActions(row)
                const hasActions = availableActions.length > 0

                return (
                  <TableRow 
                    key={row.envelope_id} 
                    className="group cursor-pointer hover:bg-muted/30 h-[64px]"
                    onClick={() => {
                      setSelectedRow(row)
                      setDetailOpen(true)
                    }}
                  >
                    <TableCell className="pl-4 py-3 min-w-0">
                      <div className="space-y-1">
                        <span className="text-sm font-semibold block truncate">{row.document_title}</span>
                        {getVersionLabel(row) ? (
                          <span className="text-xs text-muted-foreground block">{getVersionLabel(row)}</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-center">
                      <span className="text-sm text-muted-foreground capitalize block truncate">
                        {formatStatusLabel(row.document_type)}
                      </span>
                    </TableCell>
                    {scope === "org" ? (
                      <TableCell className="py-3">
                        <span className="text-sm text-muted-foreground block truncate">
                          {row.project_name ?? "—"}
                        </span>
                      </TableCell>
                    ) : null}
                    <TableCell className="py-3">
                      <span className="text-xs text-muted-foreground line-clamp-2">{row.recipient_names.join(", ") || "—"}</span>
                    </TableCell>
                    <TableCell className="py-3 text-center">
                      <Badge
                        variant="secondary"
                        className={\`capitalize border text-[11px] h-5 px-2 \${envelopeStatusClassName[row.envelope_status] ?? ""}\`}
                      >
                        {formatStatusLabel(row.envelope_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="space-y-1.5 w-full pr-4">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>{row.signer_summary.signed}/{row.signer_summary.total}</span>
                          <span>{getProgressPercent(row)}%</span>
                        </div>
                        <Progress value={getProgressPercent(row)} className="h-1.5" />
                        {getPendingLabel(row) ? (
                          <p className="text-[10px] text-blue-600 dark:text-blue-400 font-medium truncate">{getPendingLabel(row)}</p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <div className="text-xs">
                        {row.expires_at ? (
                          <div className={cn(
                            "flex items-center gap-1.5",
                            row.queue_flags.expiring_soon ? "text-orange-600 font-medium" : "text-muted-foreground"
                          )}>
                            <Calendar className="h-3 w-3" />
                            {format(new Date(row.expires_at), "MMM d, yyyy")}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="pr-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end">
                        {hasActions ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity" disabled={isPending} title="More actions">
                                <MoreHorizontal className="h-3.5 w-3.5" />
                                <span className="sr-only">More actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {availableActions.includes("view_source") ? (
                                <DropdownMenuItem onClick={() => handleViewSource(row)}>
                                  <Link2 className="mr-2 h-4 w-4" />
                                  Open source document
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("resend") ? (
                                <DropdownMenuItem onClick={() => void handleResendReminder(row)}>
                                  <Mail className="mr-2 h-4 w-4" />
                                  Resend reminder
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("continue_draft") ? (
                                <DropdownMenuItem onClick={() => handleContinueDraft(row)}>
                                  <RefreshCcw className="mr-2 h-4 w-4" />
                                  Continue
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("download") ? (
                                <DropdownMenuItem onClick={() => void handleDownload(row)}>
                                  <Download className="mr-2 h-4 w-4" />
                                  Download executed PDF
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("void") ? (
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleVoidTrigger(row)}>
                                  <Ban className="mr-2 h-4 w-4" />
                                  Void envelope
                                </DropdownMenuItem>
                              ) : null}
                              {availableActions.includes("delete_draft") ? (
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDeleteTrigger(row)}>
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete draft
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={scope === "org" ? 8 : 7} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                        <FileText className="h-6 w-6" />
                      </div>
                      <div className="text-center max-w-[400px]">
                        <p className="font-medium">No envelopes found</p>
                        <p className="text-sm text-muted-foreground mt-0.5">Adjust your filters or create a new envelope.</p>
                      </div>
                      {projectsForNewEnvelope.length > 0 ? (
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={handleStartStandaloneEnvelope} disabled={!newEnvelopeProjectId}>
                            <Plus className="mr-2 h-4 w-4" />
                            New Envelope
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>\n\n        <EnvelopeWizard`;

content = content.substring(0, startIdx) + replacement + content.substring(endIdx + endMarker.length);

// Let's also add Plus to the import from @/components/icons
content = content.replace(
  'import { Ban, Download, Mail, MoreHorizontal, RefreshCcw, Trash2, Link2, Clock, CheckCircle2, AlertCircle, FileText, User, Users, Calendar } from "@/components/icons"',
  'import { Ban, Download, Mail, MoreHorizontal, RefreshCcw, Trash2, Link2, Clock, CheckCircle2, AlertCircle, FileText, User, Users, Calendar, Plus } from "@/components/icons"'
);

fs.writeFileSync(path, content, 'utf8');
console.log('Successfully updated signatures-hub-client.tsx');
