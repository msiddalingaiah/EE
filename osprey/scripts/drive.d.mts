// Types for drive.mjs, for the UI tests.

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  /** DevTools modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  modifiers?: number;
}

export interface EditorState {
  loaded: boolean;
  sample?: string;
  view: 'schematic' | 'board' | 'library';
  mode?: 'place' | 'wire' | 'route' | 'pour' | 'via' | 'move' | 'corner' | 'line-end';
  layer?: string;
  selection: { kind: string; label: string; net?: string }[];
  status?: string;
  error?: string;
  dialog?: true;
  undo?: string;
  redo?: string;
  dirty: boolean;
  drc?: string[];
  erc?: string[];
  ercApproved?: string[];
  viewport: { cx: number; cy: number; zoom: number };
}

export interface Driver {
  url: string;
  problems: string[];
  send(method: string, params?: object): Promise<any>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  settle(): Promise<void>;
  goto(url: string): Promise<void>;
  open(sample: string, view?: 'schematic' | 'board'): Promise<void>;
  view(kind: 'schematic' | 'board'): Promise<void>;
  click(x: number, y: number, opts?: ClickOptions & { double?: boolean }): Promise<void>;
  dblclick(x: number, y: number, opts?: ClickOptions): Promise<void>;
  move(x: number, y: number, opts?: { steps?: number; modifiers?: number }): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, opts?: { steps?: number; modifiers?: number }): Promise<void>;
  key(spec: string): Promise<void>;
  type(field: string, text: string): Promise<void>;
  button(target: string): Promise<void>;
  choose(selector: string, value: string): Promise<void>;
  state(): Promise<EditorState>;
  shot(file: string): Promise<void>;
  close(): Promise<void>;
}

export function findChrome(): string | undefined;
export function launch(opts?: { url?: string; width?: number; height?: number; chrome?: string; headless?: boolean }): Promise<Driver>;
