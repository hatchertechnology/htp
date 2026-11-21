# SEOsmith local policy fixtures

These are byte-for-byte copies of `fixtures/policies/v3-local-*.json` from
SEOsmith commit `f7b9e62772e8b271a109c1029be4d789352774cd`. They exercise
local-only schema 3; they are not a wire contract or evidence of receiver
support. The receiver test pins each SHA-256 and rejects every fixture on
both ingestion paths without a stored audit. Update copies only from the
canonical producer fixtures, never by editing them independently.
