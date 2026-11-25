"""Exercise the workflow's actual detector in disposable Git repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap

workflow = (Path(__file__).resolve().parents[1] / 'workflows/forms-pr.yml').read_text()
script = textwrap.dedent(workflow.split('        run: |\n', 1)[1].split('\n      - name: Test scope detector', 1)[0])
required = [
    'supabase/migrations/20261208000000_forms_notification_claim_fence.sql',
    'supabase/tests/forms-delivery-claim-local.py',
    'supabase/tests/forms-delivery-scoped-claim-local.py',
    'apps/web/app/components/FormsNotifications.vue',
    'apps/web/shared/utils/forms-notification-client.ts',
    'apps/web/tests/forms-notification-client.test.ts',
    'apps/web/tests/fixtures/check-forms-static-notifications.mjs',
    'supabase/functions/_shared/limited_body.ts',
    'apps/api/src/form_ingress.rs',
    'apps/web/app/components/WebsiteForms.vue',
    'apps/web/server/utils/forms-pilot.ts',
    'apps/web/server/api/forms/pilot-eligibility.get.ts',
    'apps/web/tests/forms-pilot-auth.test.ts',
    'apps/web/tests/forms-pilot-eligibility.test.ts',
    'apps/web/tests/forms-confirm-gate.test.ts',
    'apps/web/tests/fixtures/check-forms-pilot.mjs',
    'apps/web/tests/fixtures/check-forms-api-cors.mjs',
    'apps/web/tests/fixtures/check-forms-pilot-api-cors.mjs',
    'scripts/test-forms-pilot-http.sh',
    'supabase/operations/forms-pilot-receipt.sql',
    'supabase/tests/fixtures/forms-pilot-scope/receipt-pg17.py',
    'supabase/tests/fixtures/forms-pilot-scope/seed.sql',
    'supabase/tests/fixtures/forms-pilot-scope/postgrest-check.mjs',
    'supabase/tests/website-forms.test.mjs',
    'supabase/tests/forms-client-admission.test.mjs',
    'supabase/tests/forms-host-challenge-quota.test.mjs',
    'supabase/tests/forms-activation-fixture.test.mjs',
    'supabase/tests/fixtures/forms-activation/host-proof-regrant.sql',
    'supabase/tests/fixtures/forms-activation/host-proof-rollback.sql',
    'supabase/migrations/20261201000000_forms_pilot_scope.sql',
    'supabase/rollbacks/20261201000000_forms_pilot_scope_disable.sql',
    'supabase/tests/forms-pilot-scope.test.mjs',
]
with tempfile.TemporaryDirectory(prefix='forms-ci-scope-') as temporary:
    root = Path(temporary)
    def git(*args):
        return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
    def put(name):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture\n')
    def commit(message):
        git('add', '-A')
        git('commit', '-qm', message)
        return git('rev-parse', 'HEAD')
    def check(base, head, expected_code, expected_output):
        output = root / '.git' / 'scope-output'
        output.write_text('')
        env = {**os.environ, 'BASE_SHA': base, 'HEAD_SHA': head, 'GITHUB_OUTPUT': str(output)}
        result = subprocess.run(['bash', '-c', script], cwd=root, env=env, capture_output=True, text=True)
        assert result.returncode == expected_code, (result.returncode, result.stderr)
        assert expected_output in output.read_text(), output.read_text()
    git('init', '-q', '-b', 'base')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    put('README')
    commit('initial')
    git('checkout', '-qb', 'stale')
    put('unrelated.txt')
    stale = commit('unrelated')
    git('checkout', '-q', 'base')
    for name in required:
        put(name)
    base = commit('add forms')
    check(base, base, 0, 'run_forms=true')
    git('checkout', '-q', 'stale')
    check(base, stale, 0, 'run_forms=false')
    for index, name in enumerate(required):
        git('checkout', '-qB', f'delete-{index}', base)
        (root / name).unlink()
        missing = commit(f'delete {name}')
        check(base, missing, 1, '')
    # Notification-only edits on an incomplete checkout must fail, never skip.
    for index, name in enumerate(required[:7]):
        git('checkout', '-qB', f'notification-only-{index}', stale)
        put(name)
        changed = commit(f'notification-only {name}')
        check(base, changed, 1, '')
    git('checkout', '-qB', 'rename-helper', base)
    moved = root / 'moved-helper.ts'
    (root / required[0]).rename(moved)
    renamed = commit('move helper')
    check(base, renamed, 1, '')
    git('checkout', '-qB', 'legacy', stale)
    legacy = 'supabase/functions/form-submit/index.ts'
    put(legacy)
    legacy_base = commit('legacy submission function')
    (root / legacy).unlink()
    legacy_removed = commit('remove legacy function')
    check(legacy_base, legacy_removed, 1, '')
    print('PASS: complete runs; stale unrelated skips; required deletion, rename and legacy removal fail')
