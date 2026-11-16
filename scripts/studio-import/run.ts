/**
 * Command line for the Scene Pack import. NOTHING here runs by itself and nothing is applied unless you say so twice
 * (the `apply` command and --yes).
 *
 *   # 1. check the manifest against the source files only (no database, no R2, always safe)
 *   npx tsx scripts/studio-import/run.ts check --source "/Users/priyansh/Downloads/Scene Packs "
 *
 *   # 2. dry run: also reads the database and R2 and reports what WOULD happen. Writes nothing.
 *   npx tsx --env-file=.env.local scripts/studio-import/run.ts plan --source "/Users/priyansh/Downloads/Scene Packs " [--verify-r2]
 *
 *   # 3. apply (production only after the approved steps: backup, migration 0027, then this)
 *   npx tsx --env-file=.env.local scripts/studio-import/run.ts apply --source "..." --owner <user uuid> --yes
 *
 *   # 4. retire the legacy "Cafe" test pack (soft archive; checks first; nothing is deleted)
 *   npx tsx --env-file=.env.local scripts/studio-import/run.ts archive-legacy --pack-id <id> [--yes]
 *
 * Options: --manifest <file> (default: next to this script)  --state <file> (default: import-state.json next to this script)
 *          --only IMG-001,IMG-002   --json (machine-readable report)
 * The database is whichever DATABASE_URL points at; the command prints its host before it does anything that writes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImportManifest, ImportState, StateStore } from '../../src/lib/studio/import/manifest';
import { emptyState } from '../../src/lib/studio/import/manifest';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg: string): never => { console.error(msg); process.exit(1); };

const manifestPath = val('manifest') ?? path.join(__dirname, 'manifest.json');
const statePath = val('state') ?? path.join(__dirname, 'import-state.json');
const source = val('source');

class FileStateStore implements StateStore {
  load(): ImportState { return fs.existsSync(statePath) ? (JSON.parse(fs.readFileSync(statePath, 'utf8')) as ImportState) : emptyState(); }
  save(s: ImportState) { const tmp = `${statePath}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`); fs.renameSync(tmp, statePath); }
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (d.name === '.DS_Store') continue;
    if (d.isDirectory()) for (const f of fs.readdirSync(path.join(root, d.name), { withFileTypes: true })) { if (f.isFile() && f.name !== '.DS_Store') out.push(`${d.name}/${f.name}`); }
  }
  return out;
}
const reader = (root: string) => async (rel: string) => { const p = path.join(root, rel); return fs.existsSync(p) ? fs.readFileSync(p) : null; };

async function main() {
  if (!cmd || !['check', 'plan', 'apply', 'archive-legacy'].includes(cmd)) die('Usage: run.ts <check|plan|apply|archive-legacy> [options]. See the header of this file.');
  if (!fs.existsSync(manifestPath)) die(`Manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ImportManifest;

  if (cmd === 'check') {
    if (!source || !fs.existsSync(source)) die('--source <folder> is required and must exist.');
    const { checkSourceOffline } = await import('../../src/lib/studio/import/importer');
    const rep = await checkSourceOffline(manifest, reader(source!), async () => listFiles(source!));
    if (flag('json')) return void console.log(JSON.stringify(rep, null, 2));
    const bad = rep.images.filter((i) => i.status !== 'ok');
    console.log(`Manifest: ${manifest.images.length} images, ${manifest.packs.length} packs. Source OK: ${rep.images.length - bad.length}. Problems: ${bad.length}.`);
    for (const b of bad) console.log(`  ${b.importKey} ${b.status}: ${b.detail}`);
    process.exitCode = bad.length || rep.manifestIssues.length ? 2 : 0;
    for (const m of rep.manifestIssues) console.log(`  manifest: ${m}`);
    for (const u of rep.unexpected) console.log(`  unexpected file: ${u}`);
    for (const d of rep.duplicateHashes) console.log(`  identical content: ${d.join(', ')}`);
    return;
  }

  // Everything below reads the database (and R2).
  const { db } = await import('../../src/db');
  void db;
  const dbHost = (() => { try { return new URL(process.env.DATABASE_URL ?? '').hostname; } catch { return '(DATABASE_URL not set)'; } })();
  const { getStorage } = await import('../../src/lib/object-store');
  const storage = getStorage();
  const writes = cmd === 'apply' || (cmd === 'archive-legacy' && flag('yes'));
  console.log(`Database host: ${dbHost}   R2: ${storage.r2Configured() ? 'configured' : 'NOT configured'}   Mode: ${writes ? 'WRITES' : 'read-only'}`);
  if (writes && !flag('yes')) die('Refusing to write without --yes.');

  if (cmd === 'archive-legacy') {
    const id = Number(val('pack-id'));
    if (!Number.isInteger(id) || id <= 0) die('--pack-id <number> is required.');
    const { archiveLegacyTestPack } = await import('../../src/lib/studio/import/importer');
    const r = await archiveLegacyTestPack(manifest, { packId: id, expectedName: 'Cafe', duplicateOf: 'IMG-018', apply: flag('yes') });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  if (!source || !fs.existsSync(source)) die('--source <folder> is required and must exist.');
  const apply = cmd === 'apply';
  const owner = val('owner');
  if (apply && !(owner && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner))) die('--owner <user uuid> is required for apply: it becomes created_by on the imported records.');
  if (!storage.r2Configured() && (apply || flag('verify-r2'))) die('R2 is not configured here (R2_* variables), so originals cannot be uploaded or verified.');
  const { runImport, exitCodeFor } = await import('../../src/lib/studio/import/importer');
  const only = val('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const rep = await runImport(manifest, {
    storage: storage.r2Configured() ? storage : { r2Configured: () => false, headR2: async () => null, downloadR2Only: async () => { throw new Error('R2 not configured'); }, putR2Only: async () => { throw new Error('R2 not configured'); } },
    readSource: reader(source!), listSource: async () => listFiles(source!), userId: owner ?? '00000000-0000-0000-0000-000000000000', state: apply ? new FileStateStore() : undefined,
  }, { apply, verifyR2: flag('verify-r2'), only });
  if (flag('json')) return void console.log(JSON.stringify(rep, null, 2));
  console.log(`\n${rep.mode.toUpperCase()}  ${Object.entries(rep.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  for (const p of rep.packs) console.log(`  pack ${p.key}: ${p.action}${p.detail ? ` (${p.detail})` : ''}`);
  for (const i of rep.images) console.log(`  ${i.importKey} ${i.action}${i.version ? ` v${i.version}` : ''}${i.detail ? `: ${i.detail}` : ''}${i.thumbnail === 'failed' ? ' [thumbnail failed]' : ''}${i.notes?.length ? ` (${i.notes.join('; ')})` : ''}`);
  for (const m of rep.manifestIssues) console.log(`  manifest: ${m}`);
  for (const u of rep.unexpected) console.log(`  unexpected file: ${u}`);
  for (const d of rep.duplicateHashes) console.log(`  identical content: ${d.join(', ')}`);
  for (const w of rep.stateWarnings) console.log(`  state: ${w}`);
  if (apply) console.log(`State written to ${statePath}`);
  process.exit(exitCodeFor(rep));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
