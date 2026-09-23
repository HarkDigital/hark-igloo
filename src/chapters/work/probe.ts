import { el, reveal } from '../../core/dom'

/**
 * A 3D-anchored HUD tag in the shared .callout vocabulary (dot, elbow leader,
 * mono label), with two extras the stock Callout lacks: labels are clamped
 * inside the viewport gutters, and the leader can point up or down.
 */
export class Probe {
  root: HTMLDivElement
  label: HTMLDivElement
  private path: SVGPathElement
  private dot: HTMLDivElement
  private width = 0
  private height = 0

  constructor(parent: HTMLElement, cls = '') {
    this.root = el('div', `callout wk-probe ${cls}`.trim(), undefined, parent)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'callout-svg')
    svg.setAttribute('aria-hidden', 'true')
    this.path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    svg.appendChild(this.path)
    this.root.appendChild(svg)
    this.dot = el('div', 'callout-dot', undefined, this.root)
    this.dot.setAttribute('aria-hidden', 'true')
    this.label = el('div', 'callout-label', undefined, this.root)
    reveal(this.root, 0, 0)
  }

  /** Forget the cached label size (after a resize or a content change). */
  invalidate() {
    this.width = 0
  }

  /** The label's box (measured once, then cached until invalidate()). */
  size() {
    if (!this.width) {
      this.width = this.label.offsetWidth
      this.height = this.label.offsetHeight
    }
    return { w: this.width, h: this.height }
  }

  /**
   * x,y: anchor in CSS px. dir: +1 label to the right, -1 to the left.
   * dx/dy: leader length. pad: min distance to the viewport edge.
   */
  place(
    x: number,
    y: number,
    vis: number,
    dir: number,
    dx: number,
    dy: number,
    w: number,
    h: number,
    pad = 16,
    avoid?: { left: number; top: number; right: number; bottom: number } | null,
  ) {
    // degenerate projections (first frames) would write NaN into the SVG path
    if (!Number.isFinite(x) || !Number.isFinite(y)) vis = 0
    reveal(this.root, vis, 0)
    if (vis <= 0.002) return
    const lw = this.size().w
    if (avoid) {
      // steer clear of a HUD block: first lift the label above the anchor,
      // and only if that still collides, flip it to the other side
      const hits = (d: number, yy: number) => {
        const ly0 = y + yy - 9
        const tx0 = d > 0 ? x + dx + 8 : x - dx - 8 - lw
        return tx0 < avoid.right && tx0 + lw > avoid.left && ly0 < avoid.bottom && ly0 + this.height > avoid.top
      }
      if (hits(dir, dy)) {
        if (dy > 0 && !hits(dir, -dy)) dy = -dy
        else dir = -dir
      }
    }
    const ex = x + dir * dx * 0.38
    const ly = Math.min(Math.max(y + dy, pad + 10), h - pad - this.height)
    let lx = x + dir * dx
    let tx = dir > 0 ? lx + 8 : lx - 8 - lw
    const minX = pad
    const maxX = w - pad - lw
    if (tx < minX) {
      lx += minX - tx
      tx = minX
    } else if (tx > maxX) {
      lx -= tx - maxX
      tx = maxX
    }
    this.path.setAttribute('d', `M${x.toFixed(1)},${y.toFixed(1)} L${ex.toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`)
    this.dot.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
    this.label.style.transform = `translate3d(${tx.toFixed(1)}px, ${(ly - 9).toFixed(1)}px, 0)`
  }
}
