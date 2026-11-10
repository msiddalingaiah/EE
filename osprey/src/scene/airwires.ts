// Showing or hiding airwires net by net (e.g. GND, which a pour will connect, or VCC while
// routing signals). A view choice: the airwires are still computed, counted and checked.

import { AIRWIRES_LAYER } from './builder';
import type { Scene } from './types';

export interface AirwireNet {
  net: string;
  /** Airwires the net has (shown or not). */
  count: number;
}

/** The nets that have airwires in a board scene, with how many each. */
export function airwireNets(scene: Scene): AirwireNet[] {
  const counts = new Map<string, number>();
  for (const o of scene.owners.values()) {
    if (o.kind === 'airwire' && o.net) counts.set(o.net, (counts.get(o.net) ?? 0) + 1);
  }
  return [...counts].map(([net, count]) => ({ net, count }));
}

/**
 * The scene without the airwires of hidden nets: they aren't drawn or picked, but stay listed
 * (their owners remain), so they can be shown again.
 */
export function hideAirwires(scene: Scene, hidden: ReadonlySet<string>): Scene {
  if (!hidden.size) return scene;
  const prims = scene.prims.filter((p) => p.layer !== AIRWIRES_LAYER || !hidden.has(scene.owners.get(p.owner)?.net ?? ''));
  return { ...scene, prims };
}
