import Link from "next/link"

export default function CreateProjectArticle() {
  return (
    <>
      <p>
        Create a project when you are ready to track a job&apos;s documents, operations,
        financials, and team in Arc.
      </p>

      <h2>Create the project</h2>
      <ol>
        <li>
          Open <Link href="/projects">Projects</Link>.
        </li>
        <li>Select <strong>New project</strong>.</li>
        <li>
          Enter the project details. The project name is required; complete the other
          fields that are useful to your team.
        </li>
        <li>Continue to the financial setup step.</li>
        <li>
          Choose the billing and contract settings that match the job, then select
          <strong> Create project</strong>.
        </li>
      </ol>

      <h2>Before you choose financial settings</h2>
      <p>
        The project&apos;s billing model controls parts of the financial workflow. Confirm
        the contract structure with the person responsible for accounting or project
        financials before completing this step.
      </p>

      <h2>After the project is created</h2>
      <p>
        Open the project to review its Overview. From there, add the project team and begin
        using the Plan, Build, Financials, and Close sections as needed.
      </p>

      <blockquote>
        If you cannot see the New project action, your Arc role may not have permission to
        create projects. Ask an organization administrator for access.
      </blockquote>
    </>
  )
}
