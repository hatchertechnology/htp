#!/usr/bin/env bash
# Review M3: H2's native runner (scripts/s14-schema4-native/run.sh) cannot take S2's exact-cap fixture:
# `--exact-cap-report` inserts the cap website as 00000000-0000-4000-8000-000000000002, the same website id the
# H1 genuine pairing already uses, and the second insert fails on websites_pkey / seosmith_bindings_pkey
# (and the fixture's request id 00000000-...-0001 equals the genuine pairing's). S2's fixtures bind the website
# id into their digests, so the id cannot be changed; the request id can.
#
# This wrapper does NOT edit H2's files. It runs a patched COPY of the runner from a scratch tree:
#   * the cap fixture's request id is rewritten (prep.mjs) and its summary regenerated with the real `admit`;
#   * the two inserts that would collide become `on conflict ... do nothing`, and the cap deliveries use the
#     genuine pairing's binding token (one website, one binding);
#   * everything else (migration order, ACL checks, the N-M3 timing at --cpus 0.2 --memory 1g, the 10 s gate)
#     is H2's runner unchanged.
#
#   scripts/s14-schema4-e2e/native-exact-cap.sh [--order prod|lexical] [--out FILE]
# Needs podman, the PG17 image the runner uses, and the HTP release `admit` example (built here if missing).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
order=prod; outf=""
while [[ $# -gt 0 ]]; do case "$1" in --order) order="$2"; shift 2 ;; --out) outf="$2"; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
HTP_T="${HTP_TARGET_DIR:-/var/tmp/s4x-target-htp}"
S4FIX="${S4FIX:-/mnt/storage/worktrees/s4-x-seosmith/fixtures/contracts/s14-schema4-v1}"
[[ -f "$S4FIX/exact-cap.json" ]] || { echo "set S4FIX to SEOsmith's fixtures/contracts/s14-schema4-v1" >&2; exit 2; }
[[ -x "$HTP_T/release/examples/admit" ]] || ( cd "$root" && CARGO_TARGET_DIR="$HTP_T" cargo build --release --locked -p htp-s14-receiver --example admit )
tmp="$(mktemp -d /var/tmp/s4x-native-wrap.XXXXXX)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/scripts/native-wrap" "$tmp/scripts"
ln -s "$root/supabase" "$tmp/supabase"; ln -s "$root/crates" "$tmp/crates"; ln -s "$root/scripts/s14-schema4-native" "$tmp/scripts/s14-schema4-native"
cp "$root/scripts/s14-schema4-native/run.sh" "$tmp/scripts/native-wrap/run.sh"

node "$here/prep.mjs" "$S4FIX/exact-cap.json" "$tmp/cap.json" --request 00000000-0000-4000-8000-0000000000c1
"$HTP_T/release/examples/admit" "$tmp/cap.json" >"$tmp/cap.summary" 2>"$tmp/cap.admit.err" || { cat "$tmp/cap.admit.err"; exit 1; }

python3 - "$tmp/scripts/native-wrap/run.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
def rep(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
rep('''cap_token="native-worker-token-0000000000000000000000000002"''', '''cap_token="$token"''')
rep(''',('$cap_site','00000000-0000-4000-8000-0000000000cc','example.com');''', ''',('$cap_site','00000000-0000-4000-8000-0000000000cc','example.com') on conflict (id) do nothing;''')
rep(''',('$cap_site','$cap_tok_sha');''', ''',('$cap_site','$cap_tok_sha') on conflict (website_id) do nothing;''')
open(p, 'w').write(s)
PY
export S14_TARGET_DIR="$HTP_T"
cmd=("$tmp/scripts/native-wrap/run.sh" --order "$order" "$root" --exact-cap-report "$tmp/cap.json" --exact-cap-summary "$tmp/cap.summary")
if [[ -n "$outf" ]]; then "${cmd[@]}" 2>&1 | tee "$outf"; else "${cmd[@]}"; fi
