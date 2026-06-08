import Link from "next/link"

export default function WhatIsArcArticle() {
  return (
    <>
      <p>
        Arc is a construction operations workspace for managing projects, field work,
        documents, financial workflows, and the people involved in a job.
      </p>

      <h2>How Arc is organized</h2>
      <p>Arc has two main working levels:</p>
      <ul>
        <li>
          <strong>Workspace tools</strong> help you manage information across the company,
          including Projects, Financial Control, Pipeline, and Directory.
        </li>
        <li>
          <strong>Project tools</strong> help you plan, build, manage financials, and close
          out one specific project.
        </li>
      </ul>

      <h2>What you can manage</h2>
      <p>
        The tools available to you depend on your role and permissions. A typical Arc
        workspace can include:
      </p>
      <ul>
        <li>Projects, schedules, daily logs, punch items, RFIs, and submittals.</li>
        <li>Documents, drawings, bids, and electronic signatures.</li>
        <li>Budgets, receivables, payables, expenses, and change orders.</li>
        <li>Companies, contacts, internal teammates, and project participants.</li>
      </ul>

      <h2>Start here</h2>
      <p>
        New administrators usually begin by creating a project and inviting their internal
        team. Other users can open an existing project and use the navigation to find the
        part of the job they are responsible for.
      </p>
      <p>
        <Link href="/help/getting-started/arc-basics/navigate-arc">
          Learn how to navigate Arc
        </Link>
        .
      </p>
    </>
  )
}
