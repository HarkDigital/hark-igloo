import * as THREE from 'three'
import type { Callout } from '../../core/dom'

/*
 * Collision-aware placement for a 3D-anchored Callout. core/dom.ts only keeps
 * labels on screen; this picks a leader direction whose label box clears the
 * chapter's HUD blocks (ALERT panel, copy column) and the chrome bands, and
 * hides the callout when nothing fits. Pure math on cached sizes: no layout
 * reads per frame.
 */

export interface Rect {
  l: number
  t: number
  r: number
  b: number
}

/** A leader direction: which side the label hangs on and the elbow offset (px). */
export interface Spot {
  side: 'left' | 'right'
  x: number
  y: number
}

const MARGIN = 12 // Callout's own edge margin (core/dom.ts)
const PAD = 10 // breathing room around every avoided block
const _v = new THREE.Vector3()

const hit = (a: Rect, b: Rect) => a.l < b.r + PAD && a.r > b.l - PAD && a.t < b.b + PAD && a.b > b.t - PAD

export class Placer {
  /** label box size (border box), kept current by a ResizeObserver */
  lw = 0
  lh = 0
  private pick = -1

  constructor(
    private callout: Callout,
    /** vertical offset of the label box top relative to the leader line (CSS: translate y-10, margin-top) */
    private boxTop = -10,
  ) {
    const label = callout.label
    const measure = () => {
      this.lw = label.offsetWidth
      this.lh = label.offsetHeight
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(label)
    else measure()
  }

  /** Mirror of Callout.update's label math: where the box lands for this spot. */
  private box(px: number, py: number, s: Spot, w: number): Rect {
    const lw = this.lw
    let side = s.side
    if (side === 'right' && px + s.x + 8 + lw > w - MARGIN) side = 'left'
    else if (side === 'left' && px - s.x - 8 - lw < MARGIN) side = 'right'
    const lx = side === 'right' ? px + s.x : px - s.x
    const ly = py + s.y
    const x = Math.max(MARGIN, Math.min(w - MARGIN - lw, side === 'right' ? lx + 8 : lx - 8 - lw))
    return { l: x, t: ly + this.boxTop, r: x + lw, b: ly + this.boxTop + this.lh }
  }

  /**
   * Choose the first spot (in preference order) whose label clears `avoid`
   * and stays inside `bounds`; the previous choice wins while it still fits,
   * so labels don't flip back and forth. Returns false when nothing fits.
   */
  place(
    world: THREE.Vector3,
    camera: THREE.Camera,
    w: number,
    h: number,
    spots: Spot[],
    bounds: Rect,
    avoid: Rect[],
  ): boolean {
    if (!this.lw) {
      // not measured yet (first frame / hidden): let Callout draw its default
      const s = spots[0]
      this.callout.side = s.side
      this.callout.offset.x = s.x
      this.callout.offset.y = s.y
      return true
    }
    _v.copy(world).project(camera)
    const px = (_v.x * 0.5 + 0.5) * w
    const py = (-_v.y * 0.5 + 0.5) * h
    if (!Number.isFinite(px) || !Number.isFinite(py) || _v.z > 1) return false
    const fits = (i: number) => {
      const s = spots[i]
      if (!s) return false
      const b = this.box(px, py, s, w)
      if (b.l < bounds.l || b.r > bounds.r || b.t < bounds.t || b.b > bounds.b) return false
      for (const a of avoid) if (hit(b, a)) return false
      return true
    }
    let pick = fits(this.pick) ? this.pick : -1
    if (pick < 0) for (let i = 0; i < spots.length && pick < 0; i++) if (fits(i)) pick = i
    this.pick = pick
    if (pick < 0) return false
    const s = spots[pick]
    this.callout.side = s.side
    this.callout.offset.x = s.x
    this.callout.offset.y = s.y
    return true
  }

  reset() {
    this.pick = -1
  }
}

/**
 * Layout box of `node` in `stage` coordinates, ignoring transforms (so a
 * block mid-reveal measures where it rests). Layout read: call only when
 * sizes change, never per frame.
 */
export function rectOf(node: HTMLElement, stage: HTMLElement): Rect {
  let x = 0
  let y = 0
  for (let e: HTMLElement | null = node; e && e !== stage; e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft
    y += e.offsetTop
  }
  return { l: x, t: y, r: x + node.offsetWidth, b: y + node.offsetHeight }
}
