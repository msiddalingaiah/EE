// The command line: its steps on the samples (runSteps), and the osprey script end to end.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseStep, runSteps, STEPS, UsageError, type StepEnv, type UserDirSub } from '../src/cli/steps';
import { readProject } from '../src/model/file';
import { unzip } from './unzip';

const ROOT = join(__dirname, '..');
const sample = (name: string) => readFileSync(join(ROOT, 'samples', 'osprey', name), 'utf8');

/** An environment in memory: a user directory, and what was written and saved. */
function memEnv(userDir: Partial<Record<UserDirSub, Record<string, string>>> = {}) {
  const written = new Map<string, string | Uint8Array>();
  const saves: string[] = [];
  const env: StepEnv = {
    listUserDir: (sub) => Object.keys(userDir[sub] ?? {}).sort(),
    readUserDir: (sub, name) => userDir[sub]![name]!,
    readPath: () => undefined,
    writeOutput: (name, data) => {
      written.set(name, data);
      return name;
    },
    save: (text) => {
      saves.push(text);
      return 'saved.osprey';
    },
  };
  return { env, written, saves };
}

describe('osprey steps', () => {
  it('runs the flow on a project: blocks, place, route, labels, LCSC, and saves once', () => {
    const p = readProject(sample('wwvbfind2.osprey'));
    const { env, saves } = memEnv();
    const r = runSteps(p, ['suggest', 'place', 'route', 'labels', 'lcsc'], env);
    expect(r.steps.map((s) => [s.step, s.id, s.ok])).toEqual([
      ['suggest', 'tools.suggest-blocks', true],
      ['place', 'tools.place', true],
      ['route', 'tools.autoroute', true],
      ['labels', 'tools.labels', true],
      ['lcsc', 'tools.lcsc', true],
    ]);
    expect(r.steps[1]!.summary).toMatch(/^Placed \d+ parts on a/);
    expect(r.saved).toBe('saved.osprey');
    expect(saves).toHaveLength(1);
    // What was saved is a valid project, routed and with LCSC numbers.
    const out = readProject(saves[0]!);
    expect(out.board!.footprints.length).toBe(p.board!.footprints.length);
    expect(out.parts.filter((x) => x.attributes?.LCSC).length).toBeGreaterThan(10);
  });

  it('checks whether a board is ready to order, without changing it', () => {
    const p = readProject(sample('wwvbfind2-hand.osprey'));
    const before = JSON.stringify(p);
    const { env, saves } = memEnv();
    const r = runSteps(p, ['check'], env);
    expect(r.ok).toBe(true); // warnings only
    // (The oscillator's four-way junction at U2A's output: a drafting warning.)
    expect(r.steps[0]!.problems.map((x) => `${x.severity} ${x.kind}`)).toEqual(['warning erc-drafting', 'warning lcsc-missing', 'warning lcsc-missing']);
    expect(JSON.stringify(p)).toBe(before);
    expect(saves).toEqual([]);
    // --strict: warnings fail it.
    expect(runSteps(p, ['check'], env, { strict: true }).ok).toBe(false);
  });

  it('stops at the first step that finds errors, keeping what came before', () => {
    const p = readProject(sample('wwvbfind2.osprey'));
    const { env, saves, written } = memEnv();
    const r = runSteps(p, ['place', 'drc', 'cam'], env);
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.step)).toEqual(['place', 'drc']); // unrouted after placing: cam never ran
    expect(r.steps[1]!.problems.some((x) => x.kind === 'drc-unrouted')).toBe(true);
    expect(written.size).toBe(0);
    expect(saves).toHaveLength(1); // the placement is kept
  });

  it('writes CAM and assembly files named after the project, as the app does', () => {
    const p = readProject(sample('wwvbfind2-hand.osprey'));
    p.project.name = 'wwvbfind2-hand';
    const { env, written } = memEnv();
    const r = runSteps(p, ['cam', 'assembly'], env);
    expect(r.steps.map((s) => [s.id, s.ok])).toEqual([['cam.default', true], ['cam.assembly', true]]);
    expect([...written.keys()]).toEqual(['wwvbfind2-hand_CAM.zip', 'wwvbfind2-hand_BOM.csv', 'wwvbfind2-hand_CPL.csv']);
    const cam = unzip(Buffer.from(written.get('wwvbfind2-hand_CAM.zip') as Uint8Array));
    const committed = unzip(readFileSync(join(ROOT, 'samples', 'osprey', 'wwvbfind2-hand_CAM.zip')));
    expect([...cam.keys()].sort()).toEqual([...committed.keys()].sort());
    expect(written.get('wwvbfind2-hand_BOM.csv')).toBe(sample('wwvbfind2-hand_BOM.csv'));
    expect(written.get('wwvbfind2-hand_CPL.csv')).toBe(sample('wwvbfind2-hand_CPL.csv'));
  });

  it('loads design rules and updates libraries from the user directory', () => {
    const dru = readFileSync(join(ROOT, 'samples', 'eagle', 'oshpark-2layer.dru'), 'utf8');
    const p = readProject(sample('wwvbfind.osprey'));
    const { env } = memEnv({ rules: { 'fab.dru': dru }, libraries: { 'madhu.ospreylib': sample('madhu.ospreylib') } });
    const r = runSteps(p, ['rules=fab', 'update', 'info'], env);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true]);
    expect(r.steps[0]!.summary).toBe('Loaded design rules fab.dru');
    expect(r.steps[1]!.summary).toMatch(/^Updated /);
    expect(r.steps[2]!.summary).toBe('63 parts, 20 nets, 7 blocks, 1 sheet, board 39.37 × 26.16 mm, 0 unrouted, LCSC 2/28');
    // A file that isn't there fails its step (and the run).
    const missing = runSteps(p, ['rules=nope.dru'], env);
    expect(missing.steps[0]!.ok).toBe(false);
    expect(missing.steps[0]!.summary).toMatch(/No nope.dru/);
  });

  it('refuses an unknown step before doing anything', () => {
    const p = readProject(sample('wwvbfind2.osprey'));
    expect(() => runSteps(p, ['place', 'teleport'], memEnv().env)).toThrow(UsageError);
    expect(parseStep('cam=jlc.cam')).toEqual({ name: 'cam', arg: 'jlc.cam' });
  });

  it("names menu commands that exist in the app's command list", () => {
    const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    const ids = new Set([...main.matchAll(/\bid: '([\w.-]+)'/g)].map((m) => m[1]));
    for (const [name, step] of Object.entries(STEPS)) {
      if (step.id) expect(ids.has(step.id), `${name}: ${step.id}`).toBe(true);
    }
  });
});

describe('the osprey script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osprey-cli-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Without $OSPREY_USERDIR, so only --userdir gives one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'OSPREY_USERDIR'));
  const osprey = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'osprey.mjs'), ...args], { encoding: 'utf8', timeout: 120000, env });

  it('runs steps on a file in place, reports JSON, and fails a check with problems', () => {
    const file = join(dir, 'board.osprey');
    copyFileSync(join(ROOT, 'samples', 'osprey', 'wwvbfind2.osprey'), file);
    const before = statSync(file).size;
    const run = osprey(file, 'place', 'route', '--json');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { ok: boolean; saved: string; steps: { step: string; id: string }[] };
    expect(out.ok).toBe(true);
    expect(out.steps.map((s) => s.id)).toEqual(['tools.place', 'tools.autoroute']);
    expect(statSync(file).size).not.toBe(before);
    // One connection is left unrouted (the sample's CLK): not ready to order.
    const check = osprey(file, 'check');
    expect(check.status).toBe(1);
    expect(check.stdout).toMatch(/^FAIL check: 1 error/m);
    expect(osprey(file, 'teleport').status).toBe(2);
  }, 120000);

  it('assigns LCSC numbers from the user directory parts tables, and none without one', () => {
    const file = join(dir, 'lcsc.osprey');
    copyFileSync(join(ROOT, 'samples', 'osprey', 'wwvbfind2.osprey'), file);
    const bare = osprey(file, 'lcsc', '--dry-run', '--json');
    const none = JSON.parse(bare.stdout) as { steps: { summary: string; problems: { message: string }[] }[] };
    expect(none.steps[0]!.summary).toMatch(/^Assigned 0 LCSC numbers/);
    expect(none.steps[0]!.problems.some((x) => /no JLCPCB parts table/.test(x.message))).toBe(true);

    const user = join(dir, 'user');
    mkdirSync(join(user, 'parts'), { recursive: true });
    copyFileSync(join(ROOT, 'samples', 'parts', 'lcsc-passives.json'), join(user, 'parts', 'lcsc-passives.json'));
    const run = osprey(file, 'lcsc', '--userdir', user);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^ok {3}lcsc: Assigned \d{2} LCSC numbers/m);

    writeFileSync(join(user, 'parts', 'broken.json'), '{');
    const broken = osprey(file, 'info', '--userdir', user);
    expect(broken.status).toBe(2);
    expect(broken.stderr).toMatch('parts/broken.json: not JSON');
  }, 120000);
});
