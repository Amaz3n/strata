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
  | "selection_change_variance_unrouted"
  | "takedown_due"
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
  | "warranty_first_response_breached"
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
  | "payment_recovery_unattributed"
  | "payment_operations_alert"
  | "payment_run_fee_charge_failed"
  | "vendor_transfer_needs_attention"
  | "vendor_payment_returned"
  | "payment_reconciliation_completed"
  | "vendor_payment_relationship_claimed"
  | "vendor_payment_relationship_active"
  | "vendor_payment_relationship_onboarding"
  | "vendor_payment_relationship_suspended"
  | "vendor_payment_relationship_revoked"
  | "vendor_recipient_onboarding_started"
  | "vendor_recipient_status_updated"
  | "payment_rail_policy_updated"
  | "payment_run_approvers_updated"
  | "payment_hold_overridden"
  | "payment_reversed"
  | "payment_reversed_from_qbo"
  | "vendor_bill_payment_reversed"
  | "vendor_credit_applied"
  | "vendor_payout_destination_changed"
  | "accounting_reconciliation_drift"

/**
 * The order groups appear in Settings → Notifications, and the header each one
 * carries. Money categories lead because the people who tune this screen most
 * are the ones being paged about money.
 */
export const NOTIFICATION_EMAIL_CATEGORIES = [
  {
    key: "payables",
    label: "Payables & bill approvals",
    description: "Vendor invoices moving through coding, approval, and release.",
  },
  {
    key: "arc_pay",
    label: "Arc Pay vendor payments",
    description: "Money leaving your bank for a vendor, and anything that stops it.",
  },
  {
    key: "banking",
    label: "Banking & payment controls",
    description: "Funding banks, payout destinations, limits, and who may approve a run.",
  },
  {
    key: "accounting",
    label: "Accounting & reconciliation",
    description: "Customer payments, reversals, and the nightly tie-out against your ledger.",
  },
  {
    key: "project",
    label: "Project coordination",
    description: "RFIs, submittals, change orders, meetings, and transmittals.",
  },
  {
    key: "field",
    label: "Field & safety",
    description: "Daily logs, schedule risk, and incidents on site.",
  },
  {
    key: "starts",
    label: "Starts & production",
    description: "Lot start packages, release failures, and land takedowns coming due.",
  },
  {
    key: "sales",
    label: "Sales & signatures",
    description: "Purchase agreements, selections, and completed signatures.",
  },
  {
    key: "warranty",
    label: "Warranty & service",
    description: "Warranty requests, assigned visits, and SLA breaches.",
  },
  {
    key: "reports",
    label: "Reports & digests",
    description: "Scheduled report deliveries.",
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; description: string }>

export type NotificationEmailCategory = (typeof NOTIFICATION_EMAIL_CATEGORIES)[number]["key"]

export const EMAIL_NOTIFICATION_TYPES = [
  {
    key: "vendor_bill_submitted",
    category: "payables",
    label: "Payable needs approval",
    description: "Email me when a vendor invoice arrives and is waiting on my approval.",
  },
  {
    key: "vendor_bill_approved",
    category: "payables",
    label: "Payable approved",
    description: "Email me when a payable I submitted or entered is approved for payment.",
  },
  {
    key: "vendor_bill_rejected",
    category: "payables",
    label: "Payable rejected",
    description: "Email me when a payable I submitted or entered is rejected, with the reason.",
  },
  {
    key: "vendor_payment_paid",
    category: "arc_pay",
    label: "Vendor payment completed",
    description: "Email me when a vendor payment finishes settling and the vendor has been paid.",
  },
  {
    key: "payable_email_ingest",
    category: "payables",
    label: "Payable arrived by email",
    description: "Email me when an invoice sent to our payables address is captured into Arc.",
  },
  {
    key: "accounting_reconciliation_drift",
    category: "accounting",
    label: "Accounting reconciliation drift",
    description: "Email me when Arc detects a new accounting connection or ledger discrepancy.",
  },
  {
    key: "vendor_payment_relationship_claimed",
    category: "arc_pay",
    label: "Vendor connected a payout account",
    description: "Email me when a vendor links one of our company records to their Arc Pay payout account.",
  },
  {
    key: "funding_source_review_requested",
    category: "banking",
    label: "Funding bank review requested",
    description: "Email me when a new vendor-payment funding bank needs independent approval.",
  },
  {
    key: "payment_run_submitted",
    category: "arc_pay",
    label: "Payment run needs approval",
    description: "Email me when an Arc Pay run is submitted for approval.",
  },
  {
    key: "payment_run_approval_recorded",
    category: "arc_pay",
    label: "Payment run approval recorded",
    description: "Email me when an approver records a decision on my payment run.",
  },
  {
    key: "payment_run_approved",
    category: "arc_pay",
    label: "Payment run approved",
    description: "Email me when my Arc Pay run reaches approval quorum.",
  },
  {
    key: "payment_run_rejected",
    category: "arc_pay",
    label: "Payment run rejected",
    description: "Email me when an approver rejects my Arc Pay run.",
  },
  {
    key: "funding_source_change_approved",
    category: "banking",
    label: "Funding bank approval",
    description: "Email me when a reviewer approves a funding-bank change.",
  },
  {
    key: "funding_source_change_rejected",
    category: "banking",
    label: "Funding bank rejection",
    description: "Email me when a reviewer rejects a funding-bank change.",
  },
  {
    key: "funding_source_activated",
    category: "banking",
    label: "Funding bank activated",
    description: "Email me when an approved funding bank finishes its cooling period.",
  },
  {
    key: "funding_source_activation_failed",
    category: "banking",
    label: "Funding bank activation failed",
    description: "Email me when an approved funding bank cannot be activated after its cooling period.",
  },
  {
    key: "payment_run_execution_failed",
    category: "arc_pay",
    label: "Payment run failed",
    description: "Email me when a vendor payment run fails during provider submission.",
  },
  {
    key: "vendor_transfer_needs_attention",
    category: "arc_pay",
    label: "Vendor transfer blocked",
    description: "Email me when a builder debit has cleared but the vendor payout could not be sent.",
  },
  {
    key: "payment_run_fee_charge_failed",
    category: "arc_pay",
    label: "Arc fee debit failed",
    description: "Email me when Arc could not collect its fee for a payment run and the balance is still owed.",
  },
  {
    key: "payment_operations_alert",
    category: "arc_pay",
    label: "Payment operations alert",
    description: "Email me when automated monitoring finds a stalled payment release or a reconciliation that stopped running.",
  },
  {
    key: "payment_submission_needs_recovery",
    category: "arc_pay",
    label: "Payment submission needs recovery",
    description: "Email me when Arc cannot tell whether a vendor payment reached the provider and needs a human to confirm it.",
  },
  {
    key: "payment_recovery_unattributed",
    category: "arc_pay",
    label: "Payment run cannot be recovered automatically",
    description:
      "Email me when a payment run is stranded because the person who built it no longer has an account, and Arc cannot re-execute it as anyone.",
  },
  {
    key: "vendor_payment_returned",
    category: "arc_pay",
    label: "Vendor payment returned",
    description: "Email me when a provider reports a vendor payment return or reversal.",
  },
  {
    key: "vendor_payout_destination_changed",
    category: "banking",
    label: "Vendor payout bank changed",
    description: "Email me when a vendor's payout bank account changes and payments to them are put on hold.",
  },
  {
    key: "payment_reconciliation_completed",
    category: "accounting",
    label: "Payment reconciliation complete",
    description: "Email me when daily vendor-payment reconciliation finishes, including with exceptions.",
  },
  {
    key: "payment_reversed",
    category: "accounting",
    label: "Customer payment reversed",
    description: "Email me when a return or correction reopens a customer invoice balance.",
  },
  {
    key: "payment_reversed_from_qbo",
    category: "accounting",
    label: "Customer payment reversed in QuickBooks",
    description:
      "Email me when a customer payment is deleted in QuickBooks and Arc reopens the invoice balance to match.",
  },
  {
    key: "vendor_bill_payment_reversed",
    category: "payables",
    label: "Vendor payment reversed",
    description: "Email me when a recorded vendor payment is reversed and the payable is open again.",
  },
  {
    key: "vendor_credit_applied",
    category: "payables",
    label: "Vendor credit applied",
    description: "Email me when an approved vendor credit reduces an open payable.",
  },
  {
    key: "payment_rail_policy_updated",
    category: "banking",
    label: "Vendor payment policy changed",
    description: "Email me when payment limits, holds, or rail controls change.",
  },
  {
    key: "payment_run_approvers_updated",
    category: "banking",
    label: "Payment approvers changed",
    description: "Email me when the Arc Pay approver roster changes.",
  },
  {
    key: "payment_hold_overridden",
    category: "payables",
    label: "Payment hold overridden",
    description: "Email me when someone overrides a payable release hold.",
  },
  {
    key: "vendor_payment_relationship_suspended",
    category: "arc_pay",
    label: "Vendor Arc Pay access suspended",
    description: "Email me when a builder suspends a vendor's Arc Pay access.",
  },
  {
    key: "vendor_payment_relationship_revoked",
    category: "arc_pay",
    label: "Vendor Arc Pay access revoked",
    description: "Email me when a builder revokes a vendor's Arc Pay access.",
  },
  {
    key: "vendor_payment_relationship_active",
    category: "arc_pay",
    label: "Vendor Arc Pay access restored",
    description: "Email me when a suspended or pending vendor becomes payable through Arc Pay again.",
  },
  {
    key: "vendor_payment_relationship_onboarding",
    category: "arc_pay",
    label: "Vendor Arc Pay access moved back to setup",
    description: "Email me when a vendor drops out of payable status and has to finish Arc Pay setup again.",
  },
  {
    key: "vendor_recipient_onboarding_started",
    category: "arc_pay",
    label: "Vendor started Arc Pay setup",
    description: "Email me when a vendor we invited begins business and bank verification.",
  },
  {
    key: "vendor_recipient_status_updated",
    category: "arc_pay",
    label: "Vendor is ready for Arc Pay",
    description:
      "Email me when a vendor finishes verification and their bills can be paid through Arc Pay — or when they lose that status.",
  },
  {
    key: "change_event_rfq_invite",
    category: "project",
    label: "Change-event RFQ invite",
    description: "Email subcontractors when a pricing request is sent.",
  },
  {
    key: "change_event_rfq_response",
    category: "project",
    label: "Change-event RFQ response",
    description: "Email me when a subcontractor responds to a pricing request.",
  },
  {
    key: "scheduled_report_ready",
    category: "reports",
    label: "Scheduled report delivery",
    description: "Email scheduled report files when they are ready.",
  },
  {
    key: "warranty_visit_assigned",
    category: "warranty",
    label: "Warranty visit assigned",
    description: "Email me when a warranty service visit is assigned to me.",
  },
  {
    key: "warranty_sla_breached",
    category: "warranty",
    label: "Warranty SLA breached",
    description: "Email me when a warranty request passes its resolution target.",
  },
  {
    key: "warranty_first_response_breached",
    category: "warranty",
    label: "Warranty first response overdue",
    description: "Email me when nobody has contacted the homeowner within the first-response target.",
  },
  {
    key: "purchase_agreement_executed",
    category: "sales",
    label: "Purchase agreement executed",
    description: "Email me when a buyer purchase agreement is fully executed.",
  },
  {
    key: "selection_cutoff_reminder",
    category: "sales",
    label: "Selection deadline reminder",
    description: "Email me when selections are due in 14 or 7 days.",
  },
  {
    key: "daily_log_mentioned",
    category: "field",
    label: "Daily log mentions",
    description: "Email me when someone tags me in a daily log or comment.",
  },
  {
    key: "change_order_approved",
    category: "project",
    label: "Change order approved",
    description: "Email me when a change order is approved.",
  },
  {
    key: "recipient_signed",
    category: "sales",
    label: "Signature completed",
    description: "Email me when someone signs through the signatures page.",
  },
  {
    key: "payment_recorded",
    category: "accounting",
    label: "Invoice paid",
    description: "Email me when an invoice payment is recorded.",
  },
  {
    key: "rfi_created",
    category: "project",
    label: "RFI created",
    description: "Email me when a new RFI is created.",
  },
  {
    key: "warranty_request_created",
    category: "warranty",
    label: "Client warranty request",
    description: "Email me when a client creates a warranty request.",
  },
  {
    key: "submittal_decided",
    category: "project",
    label: "Submittal decided",
    description: "Email me when a submittal receives a decision.",
  },
  {
    key: "schedule_risk",
    category: "field",
    label: "Schedule risk issue",
    description: "Email me when Arc flags a schedule risk.",
  },
  {
    key: "meeting_finalized",
    category: "project",
    label: "Meeting minutes finalized",
    description: "Email me when project meeting minutes are finalized.",
  },
  {
    key: "meeting_minutes_distributed",
    category: "project",
    label: "Meeting minutes distributed",
    description: "Email me when finalized meeting minutes are distributed.",
  },
  {
    key: "transmittal_sent",
    category: "project",
    label: "Transmittal sent",
    description: "Email me when a project transmittal is sent.",
  },
  {
    key: "safety_incident_alert",
    category: "field",
    label: "Serious safety incident",
    description: "Email me when a lost-time or fatality incident is reported.",
  },
  {
    key: "start_release_failed",
    category: "starts",
    label: "Start release failed",
    description: "Email me when a start release fails and needs attention.",
  },
  {
    key: "start_package_ready",
    category: "starts",
    label: "Start package ready",
    description: "Email me when a lot's start package has all gates cleared.",
  },
  {
    key: "takedown_due",
    category: "starts",
    label: "Land takedown due",
    description: "Email me as a contracted lot takedown approaches its close date.",
  },
] as const satisfies ReadonlyArray<{
  key: NotificationType
  label: string
  description: string
  category: NotificationEmailCategory
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
