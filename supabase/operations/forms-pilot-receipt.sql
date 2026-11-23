-- Operator-bound parameters: $1 website, $2 owner, $3 form, $4 submission (UUIDs).
-- One READ ONLY statement/snapshot. See docs/forms/pilot-receipts.md before use.
WITH scope AS MATERIALIZED (
  SELECT f.id, f.website_id
  FROM public.websites w
  JOIN public.website_forms f ON f.website_id = w.id
  WHERE w.id = $1::uuid AND w.owner_id = $2::uuid AND f.id = $3::uuid
), evidence AS (
  SELECT EXISTS (SELECT 1 FROM scope) AS scoped,
    EXISTS (SELECT 1 FROM scope s JOIN public.website_form_responses r
      ON r.website_id = s.website_id AND r.form_id = s.id
      WHERE r.submission_id = $4::uuid) AS active,
    EXISTS (SELECT 1 FROM scope s JOIN public.website_form_submission_tombstones t
      ON t.form_id = s.id WHERE t.submission_id = $4::uuid) AS deleted
)
SELECT CASE WHEN row_security_active('public.websites'::regclass)
              OR row_security_active('public.website_forms'::regclass)
              OR row_security_active('public.website_form_responses'::regclass)
              OR row_security_active('public.website_form_submission_tombstones'::regclass)
              THEN 'visibility_unavailable'
            WHEN $1::uuid IS NULL OR $2::uuid IS NULL OR $3::uuid IS NULL OR $4::uuid IS NULL THEN 'scope_unavailable'
            WHEN NOT scoped THEN 'scope_unavailable'
            WHEN active AND deleted THEN 'ambiguous'
            WHEN active THEN 'active_receipt'
            WHEN deleted THEN 'deleted_receipt'
            ELSE 'no_receipt_observed' END AS receipt_status
FROM evidence;
