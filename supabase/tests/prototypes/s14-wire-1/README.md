# S14 candidate receiver experiments — not support

This directory is test-only. No file here is a migration, and none is loaded by
the production API. The receiver still advertises and accepts only schemas 1
and 2. These experiments are pinned to the unfrozen producer candidate manifest
SHA256 `84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304`.
Run with `S14_CANDIDATE_DIR` set to an exact copy of that candidate bundle:

```
S14_CANDIDATE_DIR=/path/to/pinned/bundle node --test supabase/tests/prototypes/s14-wire-1/*.test.mjs
```

The raw preflight experiment extends the existing scanner to recognize schema 4,
checking decoded duplicate object keys, schema-version spelling and depth.
The separate policy check validates some policy/config/request bindings and
embedded policy uniqueness/digest. A pure scope helper tests candidate digest
and trusted worker binding separately from RPC authorization. A fixed-registry
helper compares the candidate catalog and ordered rule declarations; it does
not yet reconstruct candidate populations. An identity helper checks emitted
record hashes, duplicate entities and policy references. A tuple-shape helper
checks emitted state combinations but does not recompute rule outcomes or facts.
A separate arithmetic check deliberately demonstrates that a forged omitted
pass can satisfy count equations; it must be rejected by source recomputation. The actual worker and owner functions remain
closed to schema 4 in the gate test. A green result does **not** validate a
report for acceptance. Missing work includes canonical byte reconstruction,
complete numeric lexical validation, all source/scope/registry/identity and
projection checks, independent rule state and omitted-population recomputation,
summary/read support, authorization and lifecycle tests, and production-budget
measurements. Never install these helpers or advertise capability as-is.
