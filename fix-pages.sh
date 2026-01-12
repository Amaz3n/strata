#!/bin/bash

# List of pages that use getCurrentUserAction
pages=(
    "app/settings/cost-codes/page.tsx"
    "app/settings/integrations/page.tsx"
    "app/settings/support/page.tsx"
    "app/settings/page.tsx"
    "app/settings/billing/page.tsx"
    "app/schedule/page.tsx"
    "app/tasks/page.tsx"
    "app/portal/page.tsx"
    "app/selections/page.tsx"
    "app/invoices/page.tsx"
    "app/projects/[id]/page.tsx"
    "app/projects/page.tsx"
    "app/contacts/page.tsx"
    "app/admin/provision/page.tsx"
    "app/rfis/page.tsx"
    "app/change-orders/page.tsx"
    "app/team/page.tsx"
    "app/submittals/page.tsx"
    "app/files/page.tsx"
    "app/page.tsx"
    "app/companies/page.tsx"
)

for page in "${pages[@]}"; do
    if [ -f "$page" ]; then
        # Check if dynamic export already exists
        if ! grep -q "export const dynamic = 'force-dynamic'" "$page"; then
            # Add the dynamic export after imports but before the component
            sed -i '' '1a\
export const dynamic = '\''force-dynamic'\''
' "$page"
            echo "Added dynamic export to $page"
        else
            echo "Dynamic export already exists in $page"
        fi
    fi
done




