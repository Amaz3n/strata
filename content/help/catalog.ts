import type { HelpTopic } from "@/lib/help/types"
import IntegrationsOverviewArticle from "./accounting-integrations/integrations-overview"
import PortalsOverviewArticle from "./client-partner-portals/portals-overview"
import CloseoutOverviewArticle from "./closeout-warranty/closeout-overview"
import DirectoryOverviewArticle from "./directory-vendors/directory-overview"
import FieldOperationsOverviewArticle from "./field-operations/field-operations-overview"
import CreateProjectArticle from "./getting-started/create-project"
import GetSupportArticle from "./getting-started/get-support"
import InviteTeamArticle from "./getting-started/invite-team"
import NavigateArcArticle from "./getting-started/navigate-arc"
import WhatIsArcArticle from "./getting-started/what-is-arc"
import PipelineOverviewArticle from "./pipeline-preconstruction/pipeline-overview"
import PlanningOverviewArticle from "./planning-documents/planning-overview"
import ProjectFinancialsOverviewArticle from "./project-financials/project-financials-overview"
import ProjectsOverviewArticle from "./projects/projects-overview"
import TroubleshootingOverviewArticle from "./troubleshooting/troubleshooting-overview"
import AdministrationOverviewArticle from "./workspace-administration/administration-overview"

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
            updatedAt: "2026-06-06",
            content: PlanningOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: FieldOperationsOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: ProjectFinancialsOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: PipelineOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: DirectoryOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: PortalsOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: IntegrationsOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: AdministrationOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: CloseoutOverviewArticle,
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
            updatedAt: "2026-06-06",
            content: TroubleshootingOverviewArticle,
          },
        ],
      },
    ],
  },
]
