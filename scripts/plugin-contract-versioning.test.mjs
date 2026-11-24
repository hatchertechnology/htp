import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './plugin-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const v1 = readJson(new URL('../docs/plugin-contract/v1/capabilities.json', import.meta.url));
const readProfile = readJson(new URL('../docs/plugin-contract/v1.3/audit-reads.json', import.meta.url));
const readConformance = readJson(new URL('../docs/plugin-contract/v1.3/conformance.json', import.meta.url));
const ADDITIVE = ['website_audit_events', 'website_operational_episodes'];

test('additive reads are absent from the frozen 1.0.0 inventory', () => {
  const bindings = new Set(v1.operations.map(o => o.binding));
  for (const binding of ADDITIVE) assert.ok(!bindings.has(binding), binding + ' must not be added to the frozen v1.0.0 inventory');
});

test('1.3.0 is the additive minor profile that names both new reads', () => {
  assert.equal(readProfile.contractVersion, '1.3.0');
  assert.deepEqual(readProfile.extends, ['1.0.0', '1.1.0', '1.2.0']);
  assert.deepEqual(readProfile.operations.map(o => o.binding).sort(), [...ADDITIVE].sort());
  for (const op of readProfile.operations) {
    assert.equal(op.effect, 'read');
    assert.equal(op.collection, false);
    assert.equal(op.authorization, 'htp-owner-oauth');
    assert.ok(op.inputs.website_id && op.inputs.limit && op.inputs.before && op.inputs.before_id);
  }
  assert.equal(readProfile.availability.disabledValue, 'producer_unavailable');
});

test('profile conformance covers support, discovery, denial and producer semantics', () => {
  assert.equal(readConformance.contractVersion, readProfile.contractVersion);
  assert.equal(readConformance.evidenceKind, 'synthetic');
  const ids = readConformance.scenarios.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate scenario id');
  for (const operation of readProfile.operations.map(o => o.id)) {
    assert.ok(readConformance.scenarios.some(s => s.operation === operation), operation + ' scenarios');
    for (const suffix of ['.owner.page', '.owner.producer_unavailable', '.anonymous', '.non_owner', '.missing_capability', '.unpaired_cursor', '.limit_out_of_range']) {
      assert.ok(ids.includes(operation + suffix), operation + suffix);
    }
  }
});

test('the accepted1.2 source lock and its archive are frozen together', () => {
  const lock = readJson(new URL('../docs/plugin-contract/v1.2/skills.lock.json', import.meta.url));
  assert.equal(lock.contractVersion, '1.2.0');
  const archiveRoot = join(root, 'docs/plugin-contract/v1.3/historical-v1.2-source');
  for (const file of lock.files) {
    const sha = createHash('sha256').update(readFileSync(join(archiveRoot, file.path))).digest('hex');
    assert.equal(sha, file.sha256, file.path);
  }
});

test('canonical checker enforces frozen bytes, current-source lock and active inventory parity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htp-versioning-'));
  try {
    for (const p of ['scripts', 'docs/plugin-contract', 'plugins/htp/skills']) cpSync(join(root, p), join(dir, p), { recursive: true });
    mkdirSync(join(dir, 'apps/api/src'), { recursive: true });
    cpSync(join(root, 'apps/api/src/mcp.rs'), join(dir, 'apps/api/src/mcp.rs'));
    const run = () => spawnSync(process.execPath, [join(dir, 'scripts/check-plugin-contract.mjs')], { encoding: 'utf8', timeout: 10000 });
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stderr);

    // The old incorrect fix (adding the reads to the frozen v1 inventory) must fail.
    const capsPath = join(dir, 'docs/plugin-contract/v1/capabilities.json');
    const capsOld = readFileSync(capsPath, 'utf8');
    const caps = JSON.parse(capsOld);
    const template = caps.operations.find(o => o.binding === 'website_audit_history');
    caps.operations.push({ ...structuredClone(template), id: 'htp.website_audit_events', binding: 'website_audit_events' });
    caps.operations.push({ ...structuredClone(template), id: 'htp.website_operational_episodes', binding: 'website_operational_episodes' });
    writeFileSync(capsPath, JSON.stringify(caps, null, 2));
    assert.notEqual(run().status, 0, 'frozen v1 inventory drift');
    writeFileSync(capsPath, capsOld);

    // Active parity: dropping an additive operation from the profile must fail.
    const profilePath = join(dir, 'docs/plugin-contract/v1.3/audit-reads.json');
    const profileOld = readFileSync(profilePath, 'utf8');
    const profile = JSON.parse(profileOld);
    profile.operations = profile.operations.filter(o => o.binding !== 'website_operational_episodes');
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    assert.notEqual(run().status, 0, 'missing additive operation');
    writeFileSync(profilePath, profileOld);

    // Frozen archived conformance must not be rewritten.
    const exportPath = join(dir, 'docs/plugin-contract/v1.2/audit-exports.json');
    const exportOld = readFileSync(exportPath);
    writeFileSync(exportPath, Buffer.concat([exportOld, Buffer.from('drift')]));
    assert.notEqual(run().status, 0, 'accepted1.2 contract drift');
    writeFileSync(exportPath, exportOld);

    // Archived source snapshot must not be rewritten.
    const archivePath = join(dir, 'docs/plugin-contract/v1.3/historical-v1.2-source/plugins/htp/skills/website-management/SKILL.md');
    const archiveOld = readFileSync(archivePath);
    writeFileSync(archivePath, Buffer.concat([archiveOld, Buffer.from('drift')]));
    assert.notEqual(run().status, 0, 'accepted1.2 source drift');
    writeFileSync(archivePath, archiveOld);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
