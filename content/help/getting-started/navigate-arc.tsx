export default function NavigateArcArticle() {
  return (
    <>
      <p>
        Arc changes its navigation based on whether you are working across the company or
        inside a specific project.
      </p>

      <h2>Workspace navigation</h2>
      <p>
        When no project is selected, the main navigation shows company-wide areas such as
        Home, Projects, Financial Control, Pipeline, and Directory. Only tools allowed by
        your permissions are shown.
      </p>

      <h2>Open a project</h2>
      <ol>
        <li>Select <strong>Projects</strong> from the main navigation.</li>
        <li>Choose a project from the project list.</li>
        <li>Use the project switcher to move between projects without returning to the list.</li>
      </ol>

      <h2>Project navigation</h2>
      <p>Inside a project, tools are grouped by the stage of work:</p>
      <ul>
        <li><strong>Overview</strong> provides the project summary and primary actions.</li>
        <li><strong>Plan</strong> contains documents, drawings, bids, and signatures.</li>
        <li><strong>Build</strong> contains the schedule, daily logs, punch, RFIs, submittals, and decisions.</li>
        <li><strong>Financials</strong> contains budgets, receivables, payables, expenses, and change orders.</li>
        <li><strong>Close</strong> contains closeout and warranty workflows.</li>
      </ul>

      <h2>Navigation on a phone</h2>
      <p>
        On smaller screens, the most common destinations appear in the bottom navigation.
        Select <strong>More</strong> to open the remaining workspace or project tools.
      </p>
    </>
  )
}
