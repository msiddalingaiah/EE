// Derived lookup structures over a Scene: per-layer draw lists and per-owner bounds.

import { primBounds, union } from './builder';
import type { Bounds, Prim, Scene } from './types';
import { layerOrder } from '../view/palette';

export interface SceneIndex {
  scene: Scene;
  /** Bounds of each primitive, parallel to scene.prims. */
  primBounds: Bounds[];
  /** Layers in draw order, each with its primitive indices (drills excluded). */
  layers: { layer: number; prims: number[] }[];
  /** Drill primitive indices, drawn after everything else. */
  drills: number[];
  /** Primitive indices per owner. */
  ownerPrims: Map<string, number[]>;
  ownerBounds: Map<string, Bounds>;
  /** Layer numbers that have something drawn on them. */
  usedLayers: number[];
}

export function indexScene(scene: Scene): SceneIndex {
  const pb = scene.prims.map(primBounds);
  const byLayer = new Map<number, number[]>();
  const drills: number[] = [];
  const ownerPrims = new Map<string, number[]>();
  const ownerBounds = new Map<string, Bounds>();

  scene.prims.forEach((p: Prim, i) => {
    if (p.t === 'drill') drills.push(i);
    else {
      let list = byLayer.get(p.layer);
      if (!list) byLayer.set(p.layer, (list = []));
      list.push(i);
    }
    let op = ownerPrims.get(p.owner);
    if (!op) ownerPrims.set(p.owner, (op = []));
    op.push(i);
    const ob = ownerBounds.get(p.owner);
    ownerBounds.set(p.owner, ob ? union(ob, pb[i]!) : pb[i]!);
  });

  const layers = [...byLayer.entries()]
    .sort(([a], [b]) => layerOrder(a) - layerOrder(b))
    .map(([layer, prims]) => ({ layer, prims }));

  const used = new Set(layers.map((l) => l.layer));
  for (const d of drills) used.add(scene.prims[d]!.layer);

  return {
    scene, primBounds: pb, layers, drills, ownerPrims, ownerBounds,
    usedLayers: [...used].sort((a, b) => a - b),
  };
}
