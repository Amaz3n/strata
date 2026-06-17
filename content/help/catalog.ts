import type { HelpTopic } from "@/lib/help/types"
import IntegrationsOverviewArticle from "./accounting-integrations/integrations-overview"
import QuickBooksOnlineArticle from "./accounting-integrations/quickbooks-online"
import StripePaymentsArticle from "./accounting-integrations/stripe-payments"
import PortalsOverviewArticle from "./client-partner-portals/portals-overview"
import ClientPortalArticle from "./client-partner-portals/client-portal"
import SubcontractorPortalArticle from "./client-partner-portals/subcontractor-portal"
import BidProposalPortalsArticle from "./client-partner-portals/bid-proposal-portals"
import CloseoutOverviewArticle from "./closeout-warranty/closeout-overview"
import DirectoryOverviewArticle from "./directory-vendors/directory-overview"
import CompaniesContactsArticle from "./directory-vendors/companies-contacts"
import ProjectAssignmentsArticle from "./directory-vendors/project-assignments"
import ComplianceInsuranceArticle from "./directory-vendors/compliance-insurance"
import FieldOperationsOverviewArticle from "./field-operations/field-operations-overview"
import ScheduleArticle from "./field-operations/schedule"
import DailyLogsArticle from "./field-operations/daily-logs"
import PunchArticle from "./field-operations/punch"
import DecisionsArticle from "./field-operations/decisions"
import CreateProjectArticle from "./getting-started/create-project"
import GetSupportArticle from "./getting-started/get-support"
import InviteTeamArticle from "./getting-started/invite-team"
import NavigateArcArticle from "./getting-started/navigate-arc"
import WhatIsArcArticle from "./getting-started/what-is-arc"
import PipelineOverviewArticle from "./pipeline-preconstruction/pipeline-overview"
import ProspectsArticle from "./pipeline-preconstruction/prospects"
import EstimatesProposalsArticle from "./pipeline-preconstruction/estimates-proposals"
import PreconstructionBiddingArticle from "./pipeline-preconstruction/preconstruction-bidding"
import ProjectConversionArticle from "./pipeline-preconstruction/project-conversion"
import PlanningOverviewArticle from "./planning-documents/planning-overview"
import DocumentsArticle from "./planning-documents/documents"
import DrawingsArticle from "./planning-documents/drawings"
import BidsArticle from "./planning-documents/bids"
import RfisArticle from "./planning-documents/rfis"
import SubmittalsArticle from "./planning-documents/submittals"
import SignaturesArticle from "./planning-documents/signatures"
import ProjectFinancialsOverviewArticle from "./project-financials/project-financials-overview"
import BudgetArticle from "./project-financials/budget"
import CommitmentsArticle from "./project-financials/commitments"
import PayablesArticle from "./project-financials/payables"
import ExpensesTimeArticle from "./project-financials/expenses-time"
import ChangeOrdersArticle from "./project-financials/change-orders"
import ReceivablesInvoicingArticle from "./project-financials/receivables-invoicing"
import ProjectsOverviewArticle from "./projects/projects-overview"
import TroubleshootingOverviewArticle from "./troubleshooting/troubleshooting-overview"
import PermissionsAccessIssuesArticle from "./troubleshooting/permissions-access-issues"
import DocumentOcrIssuesArticle from "./troubleshooting/document-ocr-issues"
import IntegrationSyncIssuesArticle from "./troubleshooting/integration-sync-issues"
import AdministrationOverviewArticle from "./workspace-administration/administration-overview"
import TeamPermissionsArticle from "./workspace-administration/team-permissions"
import SubscriptionBillingArticle from "./workspace-administration/subscription-billing"
import CloseoutRecordsArticle from "./closeout-warranty/closeout-records"
import WarrantyRequestsArticle from "./closeout-warranty/warranty-requests"

/**
 * The complete Help Center hierarchy.
 *
 * Keep article bodies in their own files and import them here. This catalog is
 * the only place where navigation order and parent-child relationships live.
 */
export const helpTopics: HelpTopic[] = [
  {
    slug: "getting-started",
    title: "Getting started with Arc",
    description: "Learn the basics, set up your workspace, and get your team moving.",
    collections: [
      {
        slug: "arc-basics",
        title: "Arc basics",
        description: "Understand what Arc does and how to move around the workspace.",
        articles: [
          {
            slug: "what-is-arc",
            title: "What is Arc?",
            description: "A quick introduction to Arc and how construction work is organized.",
            updatedAt: "2026-06-06",
            content: WhatIsArcArticle,
          },
          {
            slug: "navigate-arc",
            title: "Navigate Arc",
            description: "Learn the difference between workspace and project navigation.",
            updatedAt: "2026-06-06",
            content: NavigateArcArticle,
          },
        ],
      },
      {
        slug: "set-up-your-workspace",
        title: "Set up your workspace",
        description: "Complete the first administrative steps for your Arc organization.",
        articles: [
          {
            slug: "create-your-first-project",
            title: "Create your first project",
            description: "Add a project and choose its initial financial setup.",
            updatedAt: "2026-06-06",
            content: CreateProjectArticle,
          },
          {
            slug: "invite-your-team",
            title: "Invite your team",
            description: "Invite internal teammates and assign their organization access.",
            updatedAt: "2026-06-06",
            content: InviteTeamArticle,
          },
          {
            slug: "get-help-and-contact-support",
            title: "Get help and contact support",
            description: "Find instructions or send a support request to Arc.",
            updatedAt: "2026-06-06",
            content: GetSupportArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "projects",
    title: "Projects",
    description: "Create, organize, and manage the jobs in your Arc workspace.",
    collections: [
      {
        slug: "project-management",
        title: "Project management",
        description: "Understand project structure, access, and settings.",
        articles: [
          {
            slug: "projects-overview",
            title: "Projects overview",
            description: "Learn how projects organize job-specific work in Arc.",
            updatedAt: "2026-06-06",
            content: ProjectsOverviewArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "planning-and-documents",
    title: "Planning & Documents",
    description: "Manage project files, drawings, bids, reviews, and signatures.",
    collections: [
      {
        slug: "planning-workflows",
        title: "Planning workflows",
        description: "An introduction to the tools used to plan and document work.",
        articles: [
          {
            slug: "planning-and-documents-overview",
            title: "Planning & Documents overview",
            description: "Choose the right Arc tool for files, drawings, bids, and reviews.",
            updatedAt: "2026-06-16",
            content: PlanningOverviewArticle,
          },
          {
            slug: "documents",
            title: "Documents",
            description: "Learn how to upload, organize, and share general project files.",
            updatedAt: "2026-06-16",
            content: DocumentsArticle,
          },
          {
            slug: "drawings",
            title: "Drawings",
            description: "Manage drawing sets, sheet revisions, and sheet tags.",
            updatedAt: "2026-06-16",
            content: DrawingsArticle,
          },
          {
            slug: "bids",
            title: "Bids",
            description: "Create bid packages, invite trade partners, and collect submissions.",
            updatedAt: "2026-06-16",
            content: BidsArticle,
          },
          {
            slug: "rfis",
            title: "RFIs",
            description: "Track project questions, official answers, and impacts.",
            updatedAt: "2026-06-16",
            content: RfisArticle,
          },
          {
            slug: "submittals",
            title: "Submittals",
            description: "Manage shop drawings, product samples, and reviewer approvals.",
            updatedAt: "2026-06-16",
            content: SubmittalsArticle,
          },
          {
            slug: "signatures",
            title: "Signatures",
            description: "Prepare, send, and execute documents electronically.",
            updatedAt: "2026-06-16",
            content: SignaturesArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "field-operations",
    title: "Field Operations",
    description: "Coordinate active work and keep a reliable field record.",
    collections: [
      {
        slug: "field-workflows",
        title: "Field workflows",
        description: "Learn the core tools used to manage work in the field.",
        articles: [
          {
            slug: "field-operations-overview",
            title: "Field Operations overview",
            description: "Understand schedules, daily logs, tasks, punch, and field reviews.",
            updatedAt: "2026-06-16",
            content: FieldOperationsOverviewArticle,
          },
          {
            slug: "schedule",
            title: "Schedule",
            description: "Build, maintain, and track your project timeline and Gantt charts.",
            updatedAt: "2026-06-16",
            content: ScheduleArticle,
          },
          {
            slug: "daily-logs",
            title: "Daily logs",
            description: "Keep a daily record of manpower, labor hours, weather, and inspections.",
            updatedAt: "2026-06-16",
            content: DailyLogsArticle,
          },
          {
            slug: "punch",
            title: "Punch",
            description: "Log construction deficiencies, assign owners, and track resolution.",
            updatedAt: "2026-06-16",
            content: PunchArticle,
          },
          {
            slug: "decisions",
            title: "Decisions",
            description: "Record design selections and owner authorizations to lock in direction.",
            updatedAt: "2026-06-16",
            content: DecisionsArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "project-financials",
    title: "Project Financials",
    description: "Track budgets, billing, costs, payments, and project changes.",
    collections: [
      {
        slug: "financial-workflows",
        title: "Financial workflows",
        description: "Understand how financial records move through a project.",
        articles: [
          {
            slug: "project-financials-overview",
            title: "Project Financials overview",
            description: "A guide to Arc's core project cost and billing tools.",
            updatedAt: "2026-06-16",
            content: ProjectFinancialsOverviewArticle,
          },
          {
            slug: "budget",
            title: "Budget",
            description: "Learn how to build project budgets, manage cost codes, and track variance.",
            updatedAt: "2026-06-16",
            content: BudgetArticle,
          },
          {
            slug: "commitments",
            title: "Commitments",
            description: "Manage subcontracts, purchase orders, billing caps, and retainage.",
            updatedAt: "2026-06-16",
            content: CommitmentsArticle,
          },
          {
            slug: "payables",
            title: "Payables",
            description: "Code vendor bills, track approvals, verify lien waivers, and sync with QBO.",
            updatedAt: "2026-06-16",
            content: PayablesArticle,
          },
          {
            slug: "expenses-time",
            title: "Expenses & Time",
            description: "Log out-of-pocket costs, use AI receipt scanning, and log timesheets.",
            updatedAt: "2026-06-16",
            content: ExpensesTimeArticle,
          },
          {
            slug: "change-orders",
            title: "Change Orders",
            description: "Track OCOs and SCOs, record timeline impacts, and adjust budgets.",
            updatedAt: "2026-06-16",
            content: ChangeOrdersArticle,
          },
          {
            slug: "receivables-invoicing",
            title: "Receivables & Invoices",
            description: "Progress bill clients, hold retainage, send secure invoice links, and collect payments.",
            updatedAt: "2026-06-16",
            content: ReceivablesInvoicingArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "pipeline-and-preconstruction",
    title: "Pipeline & Preconstruction",
    description: "Manage opportunities, estimates, proposals, and early bidding.",
    collections: [
      {
        slug: "pipeline-basics",
        title: "Pipeline basics",
        description: "Organize opportunities before they become active projects.",
        articles: [
          {
            slug: "pipeline-and-preconstruction-overview",
            title: "Pipeline & Preconstruction overview",
            description: "Learn how prospects, follow-ups, estimates, and bids fit together.",
            updatedAt: "2026-06-16",
            content: PipelineOverviewArticle,
          },
          {
            slug: "prospects",
            title: "Prospects",
            description: "Manage sales opportunities, pipeline funnel stages, and lead contacts.",
            updatedAt: "2026-06-16",
            content: ProspectsArticle,
          },
          {
            slug: "estimates-proposals",
            title: "Estimates & Proposals",
            description: "Build estimates, markups, optional upgrades, proposals, and contracts.",
            updatedAt: "2026-06-16",
            content: EstimatesProposalsArticle,
          },
          {
            slug: "preconstruction-bidding",
            title: "Preconstruction Bidding",
            description: "Request Early subcontractor pricing, distribute documents, and sync with estimates.",
            updatedAt: "2026-06-16",
            content: PreconstructionBiddingArticle,
          },
          {
            slug: "project-conversion",
            title: "Project Conversion",
            description: "Promote won prospects to active projects, promote contacts, and carry over files.",
            updatedAt: "2026-06-16",
            content: ProjectConversionArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "directory-and-vendors",
    title: "Directory & Vendors",
    description: "Maintain company, contact, vendor, and compliance records.",
    collections: [
      {
        slug: "directory-basics",
        title: "Directory basics",
        description: "Manage the people and businesses connected to your work.",
        articles: [
          {
            slug: "directory-and-vendors-overview",
            title: "Directory & Vendors overview",
            description: "Understand shared directory records and project assignments.",
            updatedAt: "2026-06-16",
            content: DirectoryOverviewArticle,
          },
          {
            slug: "companies-contacts",
            title: "Companies & Contacts",
            description: "Add companies, employee contacts, prequalifications, and link QBO.",
            updatedAt: "2026-06-16",
            content: CompaniesContactsArticle,
          },
          {
            slug: "project-assignments",
            title: "Project Assignments",
            description: "Assign directory companies to projects with roles and scopes.",
            updatedAt: "2026-06-16",
            content: ProjectAssignmentsArticle,
          },
          {
            slug: "compliance-insurance",
            title: "Compliance & Insurance",
            description: "Manage Certificates of Insurance (COI), compliance reviews, and payment holds.",
            updatedAt: "2026-06-16",
            content: ComplianceInsuranceArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "client-and-partner-portals",
    title: "Client & Partner Portals",
    description: "Share controlled project access with people outside your organization.",
    collections: [
      {
        slug: "external-access",
        title: "External access",
        description: "Understand invitations, secure links, and portal experiences.",
        articles: [
          {
            slug: "client-and-partner-portals-overview",
            title: "Client & Partner Portals overview",
            description: "Learn how Arc provides focused access to external participants.",
            updatedAt: "2026-06-16",
            content: PortalsOverviewArticle,
          },
          {
            slug: "client-portal",
            title: "Client Portal",
            description: "Share progress, photos, and open-book budgets, and collect payments and OCO signs.",
            updatedAt: "2026-06-16",
            content: ClientPortalArticle,
          },
          {
            slug: "subcontractor-portal",
            title: "Subcontractor Portal",
            description: "Review subcontracts, submit progress bills, upload COIs, and answer RFIs.",
            updatedAt: "2026-06-16",
            content: SubcontractorPortalArticle,
          },
          {
            slug: "bid-proposal-portals",
            title: "Bid & Proposal Portals",
            description: "Submit early bids, review specs, verify proposal contracts, and pay via Stripe links.",
            updatedAt: "2026-06-16",
            content: BidProposalPortalsArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "accounting-and-integrations",
    title: "Accounting & Integrations",
    description: "Connect Arc with accounting and payment services.",
    collections: [
      {
        slug: "connected-services",
        title: "Connected services",
        description: "Set up and maintain Arc's supported integrations.",
        articles: [
          {
            slug: "accounting-and-integrations-overview",
            title: "Accounting & Integrations overview",
            description: "An introduction to QuickBooks, Stripe, and integration setup.",
            updatedAt: "2026-06-16",
            content: IntegrationsOverviewArticle,
          },
          {
            slug: "quickbooks-online",
            title: "QuickBooks Online",
            description: "Link projects/vendors, sync bills and invoices, and automate payments.",
            updatedAt: "2026-06-16",
            content: QuickBooksOnlineArticle,
          },
          {
            slug: "stripe-payments",
            title: "Stripe Payments",
            description: "Onboard bank accounts, accept credit card/ACH payments, and set up payouts.",
            updatedAt: "2026-06-16",
            content: StripePaymentsArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "workspace-administration",
    title: "Workspace Administration",
    description: "Manage organization settings, access, billing, and security.",
    collections: [
      {
        slug: "settings-and-access",
        title: "Settings & access",
        description: "Configure the Arc workspace and the people who can use it.",
        articles: [
          {
            slug: "workspace-administration-overview",
            title: "Workspace Administration overview",
            description: "Learn about settings, permissions, billing, and account security.",
            updatedAt: "2026-06-16",
            content: AdministrationOverviewArticle,
          },
          {
            slug: "team-permissions",
            title: "Team & Permissions",
            description: "Invite team members, assign standard roles, and set custom permission overrides.",
            updatedAt: "2026-06-16",
            content: TeamPermissionsArticle,
          },
          {
            slug: "subscription-billing",
            title: "Subscription & Billing",
            description: "Manage billing cards, seat counts, receipts, and integration settings.",
            updatedAt: "2026-06-16",
            content: SubscriptionBillingArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "closeout-and-warranty",
    title: "Closeout & Warranty",
    description: "Finish projects, organize handoff records, and track warranty work.",
    collections: [
      {
        slug: "closing-projects",
        title: "Closing projects",
        description: "Prepare a complete project record and manage post-handoff issues.",
        articles: [
          {
            slug: "closeout-and-warranty-overview",
            title: "Closeout & Warranty overview",
            description: "Understand final review, closeout records, and warranty requests.",
            updatedAt: "2026-06-16",
            content: CloseoutOverviewArticle,
          },
          {
            slug: "closeout-records",
            title: "Closeout Records",
            description: "Collect as-builts, O&M manuals, and lien waivers, and archive projects.",
            updatedAt: "2026-06-16",
            content: CloseoutRecordsArticle,
          },
          {
            slug: "warranty-requests",
            title: "Warranty Requests",
            description: "Log post-occupancy defects, assign trade partners, and verify fixes.",
            updatedAt: "2026-06-16",
            content: WarrantyRequestsArticle,
          },
        ],
      },
    ],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description: "Resolve common access, browser, upload, and integration issues.",
    collections: [
      {
        slug: "common-issues",
        title: "Common issues",
        description: "Quick checks for the problems users encounter most often.",
        articles: [
          {
            slug: "troubleshooting-overview",
            title: "Troubleshooting overview",
            description: "Start here when a page, action, upload, or sync is not working.",
            updatedAt: "2026-06-16",
            content: TroubleshootingOverviewArticle,
          },
          {
            slug: "permissions-access-issues",
            title: "Permissions & Access issues",
            description: "Troubleshoot hidden buttons, missing actions, and expired invitation links.",
            updatedAt: "2026-06-16",
            content: PermissionsAccessIssuesArticle,
          },
          {
            slug: "document-ocr-issues",
            title: "Document & OCR upload issues",
            description: "Resolve stuck drawing uploads, OCR errors, and file size limits.",
            updatedAt: "2026-06-16",
            content: DocumentOcrIssuesArticle,
          },
          {
            slug: "integration-sync-issues",
            title: "QuickBooks & Stripe sync issues",
            description: "Debug failed QBO synchronizations and Stripe verification holds.",
            updatedAt: "2026-06-16",
            content: IntegrationSyncIssuesArticle,
          },
        ],
      },
    ],
  },
]
