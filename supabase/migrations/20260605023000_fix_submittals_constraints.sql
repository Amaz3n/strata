-- Fix submittals status check constraint to include 'submitted' and 'in_review'
ALTER TABLE public.submittals DROP CONSTRAINT IF EXISTS submittals_status_check;
ALTER TABLE public.submittals ADD CONSTRAINT submittals_status_check CHECK (status = ANY (ARRAY['draft'::text, 'pending'::text, 'submitted'::text, 'in_review'::text, 'approved'::text, 'approved_as_noted'::text, 'revise_resubmit'::text, 'rejected'::text]));

-- Fix submittals type check constraint to include 'mockup', 'mock_up', 'test_report', and 'certificate'
ALTER TABLE public.submittals DROP CONSTRAINT IF EXISTS submittals_submittal_type_check;
ALTER TABLE public.submittals ADD CONSTRAINT submittals_submittal_type_check CHECK (submittal_type = ANY (ARRAY['product_data'::text, 'shop_drawing'::text, 'sample'::text, 'mockup'::text, 'mock_up'::text, 'certificate'::text, 'test_report'::text, 'other'::text]));
