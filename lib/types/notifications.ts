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
  | "change_event_rfq_invite"
  | "change_event_rfq_response"
  | "invoice_created"
  | "invoice_updated"
  | "invoice_sent"
  | "payment_recorded"
  | "vendor_bill_submitted"
  | "vendor_bill_approved"
  | "vendor_bill_rejected"
  | "vendor_payment_paid"
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
  | "scheduled_report_ready"
  | "funding_source_review_requested"
  | "funding_source_change_approved"
  | "funding_source_change_rejected"
  | "funding_source_activated"
  | "funding_source_activation_failed"
  | "payment_run_submitted"
  | "payment_run_approval_recorded"
  | "payment_run_approved"
  | "payment_run_rejected"
  | "payment_run_execution_failed"
  | "payment_submission_needs_recovery"
  | "payment_operations_alert"
  | "payment_run_fee_charge_failed"
  | "vendor_transfer_needs_attention"
  | "vendor_payment_returned"
  | "payment_reconciliation_completed"
  | "vendor_payment_relationship_claimed"
  | "accounting_reconciliation_drift"

export const EMAIL_NOTIFICATION_TYPES = [
  {
    key: "vendor_bill_submitted",
    label: "Payable needs approval",
    description: "Email me when a vendor invoice arrives and is waiting on my approval.",
  },
  {
    key: "vendor_bill_approved",
    label: "Payable approved",
    description: "Email me when a payable I submitted or entered is approved for payment.",
  },
  {
    key: "vendor_bill_rejected",
    label: "Payable rejected",
    description: "Email me when a payable I submitted or entered is rejected, with the reason.",
  },
  {
    key: "vendor_payment_paid",
    label: "Vendor payment completed",
    description: "Email me when a vendor payment finishes settling and the vendor has been paid.",
  },
  {
    key: "payable_email_ingest",
    label: "Payable arrived by email",
    description: "Email me when an invoice sent to our payables address is captured into Arc.",
  },
  {
    key: "accounting_reconciliation_drift",
    label: "Accounting reconciliation drift",
    description: "Email me when Arc detects a new accounting connection or ledger discrepancy.",
  },
  {
    key: "vendor_payment_relationship_claimed",
    label: "Vendor connected a payout account",
    description: "Email me when a vendor links one of our company records to their Arc payout account.",
  },
  {
    key: "funding_source_review_requested",
    label: "Funding bank review requested",
    description: "Email me when a new vendor-payment funding bank needs independent approval.",
  },
  {
    key: "payment_run_submitted",
    label: "Payment run needs approval",
    description: "Email me when an electronic vendor-payment run is submitted for approval.",
  },
  {
    key: "payment_run_approval_recorded",
    label: "Payment run approval recorded",
    description: "Email me when an approver records a decision on my payment run.",
  },
  {
    key: "payment_run_approved",
    label: "Payment run approved",
    description: "Email me when my electronic payment run reaches approval quorum.",
  },
  {
    key: "payment_run_rejected",
    label: "Payment run rejected",
    description: "Email me when an approver rejects my electronic payment run.",
  },
  {
    key: "funding_source_change_approved",
    label: "Funding bank approval",
    description: "Email me when a reviewer approves a funding-bank change.",
  },
  {
    key: "funding_source_change_rejected",
    label: "Funding bank rejection",
    description: "Email me when a reviewer rejects a funding-bank change.",
  },
  {
    key: "funding_source_activated",
    label: "Funding bank activated",
    description: "Email me when an approved funding bank finishes its cooling period.",
  },
  {
    key: "funding_source_activation_failed",
    label: "Funding bank activation failed",
    description: "Email me when an approved funding bank cannot be activated after its cooling period.",
  },
  {
    key: "payment_run_execution_failed",
    label: "Payment run failed",
    description: "Email me when a vendor payment run fails during provider submission.",
  },
  {
    key: "vendor_transfer_needs_attention",
    label: "Vendor transfer blocked",
    description: "Email me when a builder debit has cleared but the vendor payout could not be sent.",
  },
  {
    key: "payment_run_fee_charge_failed",
    label: "Arc fee debit failed",
    description: "Email me when Arc could not collect its fee for a payment run and the balance is still owed.",
  },
  {
    key: "payment_operations_alert",
    label: "Payment operations alert",
    description: "Email me when automated monitoring finds a stalled payment release or a reconciliation that stopped running.",
  },
  {
    key: "payment_submission_needs_recovery",
    label: "Payment submission needs recovery",
    description: "Email me when Arc cannot tell whether a vendor payment reached the provider and needs a human to confirm it.",
  },
  {
    key: "vendor_payment_returned",
    label: "Vendor payment returned",
    description: "Email me when a provider reports a vendor payment return or reversal.",
  },
  {
    key: "payment_reconciliation_completed",
    label: "Payment reconciliation complete",
    description: "Email me when daily vendor-payment reconciliation finishes, including with exceptions.",
  },
  {
    key: "change_event_rfq_invite",
    label: "Change-event RFQ invite",
    description: "Email subcontractors when a pricing request is sent.",
  },
  {
    key: "change_event_rfq_response",
    label: "Change-event RFQ response",
    description: "Email me when a subcontractor responds to a pricing request.",
  },
  {
    key: "scheduled_report_ready",
    label: "Scheduled report delivery",
    description: "Email scheduled report files when they are ready.",
  },
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
