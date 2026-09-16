export default function PurchasingArticle() {
  return (
    <>
      <p>
        Purchasing is the organization desk for turning known pricing into controlled purchase orders. It connects
        vendor price agreements, community and plan bid packages, field exceptions, variance purchase orders, and
        pay-on-PO completion review.
      </p>

      <h2>Maintain the price book</h2>
      <p>
        Create a vendor price agreement for the applicable cost code, scope, and effective date range. An agreement
        can be organization-wide or limited to the right division, community, or plan. Keep dates and scope precise:
        overlapping or expired agreements create ambiguity that should be resolved before generation.
      </p>

      <h2>Resolve exceptions before generating POs</h2>
      <p>
        When Arc cannot price a line safely, it places the item in <strong>PO generation exceptions</strong> rather
        than silently assigning a zero or guessed price. Review the cost code, description, quantity, reason, and
        suggested agreement. Use a valid candidate agreement or enter a documented manual resolution, then rerun
        generation. Use a dry run when you want to inspect the result without creating orders.
      </p>

      <h2>Review field variance and completion</h2>
      <p>
        A variance purchase order records a requested change from the field with its reason and supporting photos.
        Approve or reject it through the purchasing desk so the variance remains visible in reporting. For pay-on-PO
        work, verify the field completion first; approval creates the approved vendor bill only after the completion
        record is ready.
      </p>

      <blockquote>
        Purchasing controls the promise to buy. Payables controls the vendor bill and payment. Keep those records
        linked, but do not use one to bypass review in the other.
      </blockquote>
    </>
  )
}
