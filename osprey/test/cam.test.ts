// CAM output (Gerber, Excellon) compared with Eagle's CAM output for the same board, by geometry:
// both are rasterised (10 µm pixels) and the area that differs is measured.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB, parseCamJob, runCam } from '../src/cam/job';
import { zip } from '../src/cam/zip';
import { readProject } from '../src/model/file';
import { compare, diffPng, plotGerber, raster, readExcellon } from './gerber-raster';
import { unzip } from './unzip';

const SAMPLES = join(__dirname, '..', 'samples');
const project = () => readProject(readFileSync(join(SAMPLES, 'osprey', 'TA7358A.osprey'), 'utf8'));
const eagle = unzip(readFileSync(join(SAMPLES, 'eagle', 'TA7358A_2026-06-12.zip')));
/** Set OSPREY_CAM_DIFF to a folder for a PNG per comparison: grey both, red Osprey only, blue Eagle only. */
const DIFF_DIR = process.env.OSPREY_CAM_DIFF;

const RES = 0.01;
const mm2 = (n: number) => n * RES * RES;

/** Areas (mm²): each image, and what only ours or only Eagle's covers. */
function diff(file: string, ours: string, opts: Parameters<typeof plotGerber>[2] = {}, tag = '') {
  const a = raster(-1, -1, 38, 38, RES);
  const b = raster(-1, -1, 38, 38, RES);
  plotGerber(ours, a, opts);
  plotGerber(eagle.get(file)!, b, opts);
  if (DIFF_DIR) {
    mkdirSync(DIFF_DIR, { recursive: true });
    writeFileSync(join(DIFF_DIR, `${file}${tag}.png`), diffPng(a, b));
  }
  const c = compare(a, b);
  return { ours: mm2(c.a), eagle: mm2(c.b), onlyOurs: mm2(c.onlyA), onlyEagle: mm2(c.onlyB) };
}

describe('CAM output for TA7358A, against Eagle', () => {
  const { files, warnings } = runCam(project());
  const file = (ext: string) => files.get(`TA7358A.${ext}`)!;

  it('writes every file of the job', () => {
    expect([...files.keys()].sort()).toEqual([...eagle.keys()].filter((n) => !n.includes('/')).sort());
  });

  it('board outline: the same lines and hole circles', () => {
    // Eagle draws the outline twice (zero width, then 0.254 mm); compare centre lines.
    const d = diff('TA7358A.GKO', file('GKO'), { lineWidth: 0.05 });
    expect(d.onlyOurs).toBeLessThan(0.02);
    expect(d.onlyEagle).toBeLessThan(0.02);
  });

  for (const ext of ['GTL', 'GBL']) {
    it(`${ext}: pads, SMDs, vias and traces are identical`, () => {
      const d = diff(`TA7358A.${ext}`, file(ext), { only: 'other' });
      expect(d.ours).toBeGreaterThan(50);
      expect(d.onlyOurs).toBeLessThan(0.005);
      expect(d.onlyEagle).toBeLessThan(0.005);
    });

    it(`${ext}: with poured copper, within 1% of Eagle's`, () => {
      // Known differences, in the pour computation (not CAM): Eagle removes copper narrower than
      // the pour's width (necks between close pads, slivers between holes and the board edge),
      // and its thermal spokes are a little wider. (Eagle's spokes also run on under the pad,
      // so pours alone aren't compared: only what shows.)
      const d = diff(`TA7358A.${ext}`, file(ext));
      expect(d.eagle).toBeGreaterThan(1000);
      expect(d.onlyOurs + d.onlyEagle).toBeLessThan(0.01 * d.eagle);
    });
  }

  for (const ext of ['GTS', 'GBS', 'GTP', 'GBP']) {
    it(`${ext}: solder mask / paste identical`, () => {
      const d = diff(`TA7358A.${ext}`, file(ext));
      expect(d.onlyOurs).toBe(0);
      expect(d.onlyEagle).toBe(0);
    });
  }

  it('silkscreen: identical but for the text, which is left out (and reported)', () => {
    const top = diff('TA7358A.GTO', file('GTO'));
    expect(top.onlyOurs).toBeLessThan(0.01);
    expect(top.ours).toBeGreaterThan(80);
    const bottom = diff('TA7358A.GBO', file('GBO'));
    expect(bottom.eagle + bottom.ours).toBe(0);
    expect(warnings).toEqual(["Silkscreen Top: 51 texts left out (text isn't plotted yet)"]);
  });

  it('drills the same holes, with the same tools', () => {
    const key = (h: { d: string; x: number; y: number }) => `${h.d}@${h.x.toFixed(3)},${h.y.toFixed(3)}`;
    const ours = readExcellon(file('XLN')).map(key).sort();
    const theirs = readExcellon(eagle.get('TA7358A.XLN')!).map(key).sort();
    expect(ours).toEqual(theirs);
    const tools = (t: string) => t.split('\n').filter((l) => /^T\d+C/.test(l));
    expect(tools(file('XLN'))).toEqual(tools(eagle.get('TA7358A.XLN')!));
  });

  it('flashes pads with Eagle\'s apertures', () => {
    const apertures = (t: string) => new Set(t.split('\n').filter((l) => l.startsWith('%ADD')).map((l) => l.replace(/^%ADD\d+/, '')));
    for (const ext of ['GTL', 'GTS', 'GTP']) expect(apertures(file(ext))).toEqual(apertures(eagle.get(`TA7358A.${ext}`)!));
  });
});

describe('CAM jobs', () => {
  it('reads an Eagle .cam job: the same outputs as the default job', () => {
    const job = parseCamJob(readFileSync(join(SAMPLES, 'eagle', 'jlcpcb_2_layer_v9.cam'), 'utf8'));
    expect(job.gerbers.map((g) => [g.file, g.layers, g.function])).toEqual(DEFAULT_JOB.gerbers.map((g) => [g.file, g.layers, g.function]));
    expect(job.drill).toBe('%N.XLN');
  });

  it('rejects files that are not CAM jobs', () => {
    expect(() => parseCamJob('<xml/>')).toThrow(/Not an Eagle CAM job/);
    expect(() => parseCamJob('{"outputs": []}')).toThrow(/no Gerber or Excellon/);
  });

  it('zips the files', () => {
    const files = new Map([['a.txt', 'hello'], ['b/c.txt', 'wörld']]);
    expect(unzip(Buffer.from(zip(files)))).toEqual(files);
  });
});
