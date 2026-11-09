// A project: a schematic and its board (Eagle keeps them as NAME.sch + NAME.brd and
// annotates changes between them), or a library on its own.

import type { FileHandle } from '../app/files';
import { parseEagle } from '../eagle/parse';
import type { EagleFile } from '../eagle/types';

export type ViewKind = 'schematic' | 'board' | 'library';

export interface ProjectFile {
  file: EagleFile;
  /** File name, e.g. "TA7358A.brd". */
  name: string;
  /** Where to save, when the file came from the native open dialog. */
  handle?: FileHandle;
}

export interface SourceFile {
  name: string;
  text: string;
  handle?: FileHandle;
}

export class ProjectError extends Error {}

export class Project {
  schematic?: ProjectFile;
  board?: ProjectFile;
  library?: ProjectFile;
  /** Notes about how the project was assembled (e.g. a missing counterpart). */
  readonly notes: string[] = [];

  /**
   * Build a project from opened files: a .sch and/or .brd (ideally sharing a base name),
   * or a single .lbr. Throws ProjectError if the files don't make a sensible project.
   */
  static fromFiles(sources: SourceFile[]): Project {
    const p = new Project();
    for (const src of sources) {
      const file = parseEagle(src.text);
      const pf: ProjectFile = { file, name: src.name, ...(src.handle ? { handle: src.handle } : {}) };
      const slot = file.schematic ? 'schematic' : file.board ? 'board' : 'library';
      if (p[slot]) throw new ProjectError(`Open one ${slot} at a time (got ${p[slot]!.name} and ${src.name})`);
      p[slot] = pf;
    }
    if (p.library && (p.schematic || p.board)) {
      throw new ProjectError('Open a library on its own, or a schematic and its board');
    }
    if (p.schematic && p.board && baseName(p.schematic.name) !== baseName(p.board.name)) {
      p.notes.push(`${p.schematic.name} and ${p.board.name} have different names; treating them as a pair anyway.`);
    }
    if (p.schematic && !p.board) p.notes.push(`Only the schematic is open: open ${baseName(p.schematic.name)}.brd with it to keep the board in sync.`);
    if (p.board && !p.schematic) p.notes.push(`Only the board is open: open ${baseName(p.board.name)}.sch with it to keep the schematic in sync.`);
    return p;
  }

  get name(): string {
    const f = this.schematic ?? this.board ?? this.library;
    return f ? (this.library ? f.name : baseName(f.name)) : '';
  }

  get files(): ProjectFile[] {
    return [this.schematic, this.board, this.library].filter((f): f is ProjectFile => !!f);
  }

  /** The views this project offers, in toolbar order. */
  get views(): ViewKind[] {
    return this.files.map((f) => (f === this.schematic ? 'schematic' : f === this.board ? 'board' : 'library'));
  }

  fileFor(view: ViewKind): ProjectFile | undefined {
    return this[view];
  }

  /** True when edits can be annotated between schematic and board. */
  get paired(): boolean {
    return !!(this.schematic && this.board);
  }
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '');
}
