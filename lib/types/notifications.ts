export type NotificationType =
  | "task_assigned"
  | "task_created"
  | "task_updated"
  | "task_completed"
  | "daily_log_created"
  | "daily_log_mentioned"
  | "schedule_item_created"
  | "schedule_item_updated"
  | "schedule_risk"
  | "rfi_created"
  | "rfi_response_added"
  | "rfi_decided"
  | "submittal_created"
  | "submittal_item_added"
  | "submittal_decided"
  | "change_order_created"
  | "change_order_published"
  | "change_order_approved"
  | "invoice_created"
  | "invoice_updated"
  | "invoice_sent"
  | "payment_recorded"
  | "vendor_bill_submitted"
  | "selection_created"
  | "selection_cutoff_reminder"
  | "selection_cutoff_missed"
  | "selection_cutoff_changed"
  | "portal_message"
  | "file_created"
  | "file_archived"
  | "file_deleted"
  | "drawing_set_created"
  | "drawing_set_deleted"
  | "drawing_markup_created"
  | "drawing_pin_created"
  | "lien_waiver_created"
  | "lien_waiver_signed"
  | "team_member_invited"
  | "team_member_joined"
  | "compliance_item_created"
  | "compliance_item_due"
  | "compliance_item_overdue"
  | "punch_item_created"
  | "decision_created"
  | "decision_updated"
  | "warranty_item_created"
  | "warranty_item_due"
  | "warranty_item_expired"
  | "warranty_request_created"
  | "contact_created"
  | "contact_updated"
  | "company_created"
  | "company_updated"
  | "project_created"
  | "project_updated"
  | "project_completed"
  | "project_archived"
  | "estimate_created"
  | "estimate_updated"
  | "estimate_sent"
  | "estimate_changes_requested"
  | "estimate_declined"
  | "proposal_created"
  | "proposal_updated"
  | "proposal_sent"
  | "contract_created"
  | "contract_signed"
  | "commitment_created"
  | "commitment_updated"
  | "bid_submission_received"
  | "bid_submission_withdrawn"
  | "bid_award_rescinded"
  | "bid_invite_declined"
  | "recipient_signed"
  | "payable_email_ingest"
  | "meeting_finalized"
  | "meeting_minutes_distributed"
  | "transmittal_sent"
  | "safety_incident_reported"
  | "safety_incident_alert"
  | "observation_created"
  | "inspection_completed"
  | "vpo.requested"
  | "vpo.approved"
  | "vpo.rejected"
  | "po_completion.reported"
  | "po_completion.verified"
  | "po_completion.approved"
  | "po_completion.rejected"
  | "variance_digest"
  | "start_package_ready"
  | "start_released"
  | "start_release_failed"
  | "start_gate_waived"
  | "project_superintendent_assigned"
  | "purchase_agreement_executed"
  | "warranty_visit_assigned"
  | "warranty_visit_confirmed"
  | "warranty_visit_completed"
  | "warranty_backcharge_disputed"
  | "warranty_sla_breached"

export const EMAIL_NOTIFICATION_TYPES = [
  {
    key: "warranty_visit_assigned",
    label: "Warranty visit assigned",
    description: "Email me when a warranty service visit is assigned to me.",
  },
  {
    key: "warranty_sla_breached",
    label: "Warranty SLA breached",
    description: "Email me when a warranty request passes its resolution target.",
  },
  {
    key: "purchase_agreement_executed",
    label: "Purchase agreement executed",
    description: "Email me when a buyer purchase agreement is fully executed.",
  },
  {
    key: "selection_cutoff_reminder",
    label: "Selection deadline reminder",
    description: "Email me when selections are due in 14 or 7 days.",
  },
  {
    key: "daily_log_mentioned",
    label: "Daily log mentions",
    description: "Email me when someone tags me in a daily log or comment.",
  },
  {
    key: "change_order_approved",
    label: "Change order approved",
    description: "Email me when a change order is approved.",
  },
  {
    key: "recipient_signed",
    label: "Signature completed",
    description: "Email me when someone signs through the signatures page.",
  },
  {
    key: "payment_recorded",
    label: "Invoice paid",
    description: "Email me when an invoice payment is recorded.",
  },
  {
    key: "rfi_created",
    label: "RFI created",
    description: "Email me when a new RFI is created.",
  },
  {
    key: "warranty_request_created",
    label: "Client warranty request",
    description: "Email me when a client creates a warranty request.",
  },
  {
    key: "submittal_decided",
    label: "Submittal decided",
    description: "Email me when a submittal receives a decision.",
  },
  {
    key: "schedule_risk",
    label: "Schedule risk issue",
    description: "Email me when Arc flags a schedule risk.",
  },
  {
    key: "meeting_finalized",
    label: "Meeting minutes finalized",
    description: "Email me when project meeting minutes are finalized.",
  },
  {
    key: "meeting_minutes_distributed",
    label: "Meeting minutes distributed",
    description: "Email me when finalized meeting minutes are distributed.",
  },
  {
    key: "transmittal_sent",
    label: "Transmittal sent",
    description: "Email me when a project transmittal is sent.",
  },
  {
    key: "safety_incident_alert",
    label: "Serious safety incident",
    description: "Email me when a lost-time or fatality incident is reported.",
  },
  {
    key: "start_release_failed",
    label: "Start release failed",
    description: "Email me when a start release fails and needs attention.",
  },
  {
    key: "start_package_ready",
    label: "Start package ready",
    description: "Email me when a lot's start package has all gates cleared.",
  },
] as const satisfies ReadonlyArray<{
  key: NotificationType
  label: string
  description: string
}>

export type EmailNotificationType = (typeof EMAIL_NOTIFICATION_TYPES)[number]["key"]
export type EmailNotificationTypeSettings = Partial<Record<EmailNotificationType, boolean>>

export interface NotificationRecord {
  id: string
  org_id: string
  user_id: string
  type: NotificationType
  title: string
  message: string
  payload: Record<string, any>
  is_read: boolean
  created_at: string
  updated_at: string
  project_id?: string
  entity_type?: string
  entity_id?: string
  event_id?: string
}

export interface NotificationInput {
  orgId: string
  userId: string
  type: NotificationType
  title: string
  message: string
  projectId?: string
  entityType?: string
  entityId?: string
  eventId?: string
  metadata?: Record<string, unknown>
}
