// Pan/zoom state mapping world (mm, y-up) to CSS pixels (y-down).

import type { Point } from '../geom/transform';
import type { Bounds } from '../scene/types';

export class Viewport {
  /** World point shown at the centre of the canvas. */
  cx = 0;
  cy = 0;
  /** CSS pixels per mm. */
  zoom = 10;
  width = 1;
  height = 1;

  static readonly MIN_ZOOM = 0.05;
  static readonly MAX_ZOOM = 2000;

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  toScreen(x: number, y: number): Point {
    return {
      x: (x - this.cx) * this.zoom + this.width / 2,
      y: this.height / 2 - (y - this.cy) * this.zoom,
    };
  }

  toWorld(sx: number, sy: number): Point {
    return {
      x: (sx - this.width / 2) / this.zoom + this.cx,
      y: (this.height / 2 - sy) / this.zoom + this.cy,
    };
  }

  /** Zoom by `factor`, keeping the world point under screen (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(Viewport.MAX_ZOOM, Math.max(Viewport.MIN_ZOOM, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.cx -= dxScreen / this.zoom;
    this.cy += dyScreen / this.zoom;
  }

  fit(b: Bounds, marginPx = 32): void {
    const w = Math.max(b.maxX - b.minX, 1e-3);
    const h = Math.max(b.maxY - b.minY, 1e-3);
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    const zx = (this.width - 2 * marginPx) / w;
    const zy = (this.height - 2 * marginPx) / h;
    this.zoom = Math.min(Viewport.MAX_ZOOM, Math.max(Viewport.MIN_ZOOM, Math.min(zx, zy)));
  }

  /** World-space rectangle currently visible. */
  visibleBounds(): Bounds {
    const a = this.toWorld(0, this.height);
    const b = this.toWorld(this.width, 0);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
}
