// Loading design rules (an Eagle .dru file) into a project, as an undoable edit.

import { boardGroup, designRules, rulesNode, type DruFile } from '../model/rules';
import type { JsonML, Project } from '../model/types';
import { insert, remove, set, type Transaction } from './ops';

/** Load a .dru file's rules into the board (one undoable step). */
export function applyDru(project: Project, name: string, dru: DruFile, tx: Transaction): void {
  // The file's values win; parameters it doesn't mention (e.g. check flags newer than the file)
  // keep the board's values, in the board's order, with new ones after them.
  const values = new Map(dru.params);
  const params: [string, string][] = [];
  for (const [n, v] of designRules(project)) {
    if (n.startsWith('@')) continue;
    params.push([n, values.has(n) ? values.get(n)! : v]);
    values.delete(n);
  }
  params.push(...values);

  const node: JsonML = ['designrules', { name }];
  if (dru.description !== undefined) node.push(['description', { language: 'en' }, dru.description]);
  for (const [n, v] of params) node.push(['param', { name: n, value: v }]);

  let group = boardGroup(project);
  if (!group) {
    if (!project.eagle) tx.run(set(project, { eagle: {} }));
    if (!project.eagle!.board) tx.run(set(project.eagle!, { board: [] }));
    group = ['board'];
    tx.run(insert(project.eagle!.board!, group));
  }
  const old = rulesNode(project);
  const at = old ? group.indexOf(old) : group.length;
  if (old) tx.run(remove(group as unknown[], old));
  tx.run(insert(group as unknown[], node, at));
}
