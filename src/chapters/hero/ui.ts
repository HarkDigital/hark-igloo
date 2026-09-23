import * as THREE from 'three'
import { BRAND, CONTACT } from '../../content'
import { Callout, el, reveal } from '../../core/dom'
import { Scramble, scrambleAt } from '../../core/scramble'
import { clamp, ease } from '../../core/math'
import type { BrickInfo } from './bricks'
import { T } from './shared'

const pad = (n: number, w: number) => String(Math.max(0, Math.round(n))).padStart(w, '0')
const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(3)}`

/**
 * A 0..1 visibility that is *triggered* by scroll position but runs on time,
 * so UI always settles fully in (or out) when scrolling stops — never parked
 * half-faded or half-decoded. `t` counts seconds since it switched on (for
 * sequencing) and only resets once the element is fully hidden again, so a
 * quick back-and-forth does not re-garble text that is already readable.
 */
class Gate {
  v = 0
  t = 0
  constructor(
    private inS = 0.5,
    private outS = 0.3,
  ) {}
  step(on: boolean, dt: number) {
    if (on) this.t += dt
    this.v = clamp(this.v + (on ? dt / this.inS : -dt / this.outS))
    if (this.v <= 0) this.t = 0
    return this.v
  }
}

/** Decoding text: glyph noise refreshes at ~20 fps; the resolved text is written once and left alone. */
class Decode {
  private tick = -1
  private target = ''
  constructor(public node: HTMLElement) {}
  show(text: string, p: number, clock: number) {
    if (p >= 1) {
      if (this.node.textContent !== text) this.node.textContent = text
      this.target = text
      return
    }
    const k = Math.floor(clock * 20)
    if (k === this.tick && text === this.target) return
    this.tick = k
    this.target = text
    this.node.textContent = scrambleAt(text, clamp(p))
  }
}

interface HeroCallout {
  callout: Callout
  brick: BrickInfo
  num: string
  gate: Gate
  numD: Decode
  l1D: Decode
  l2D: Decode
  tel: string
  sideBase: 'left' | 'right'
  baseX: number
  baseY: number
  flipped: boolean
  world: THREE.Vector3
}

/**
 * All of the hero's DOM: manifesto, scroll hint, assembly/resolve status
 * readout, brick callouts and the payoff headline + CTAs.
 */
export class HeroUI {
  root: HTMLDivElement
  private manifesto: HTMLElement
  private manifestoScr: Scramble
  private scroll: HTMLElement
  private status: HTMLElement
  private statusSeq: HTMLElement
  private statusPhase: HTMLElement
  private statusCount: HTMLElement
  private statusBar: HTMLElement
  private payoff: HTMLElement
  private eyebrow: HTMLElement
  private lines: { d: Decode; text: string }[] = []
  private ctas: HTMLElement
  callouts: HeroCallout[] = []
  private lastPhase = ''
  private revealed = false
  private reduced = false

  private gManifesto = new Gate(0.6, 0.35)
  private gScroll = new Gate(0.6, 0.3)
  private gStatus = new Gate(0.45, 0.3)
  private gPayoff = new Gate(0.4, 0.28)

  constructor(stage: HTMLElement) {
    this.root = el('div', 'hero-root', undefined, stage)

    // --- manifesto (top right) ---
    const mWrap = el('div', 'hero-in hero-manifesto', undefined, this.root)
    this.manifesto = el('div', 'hero-manifesto__inner', undefined, mWrap)
    el('p', 'hud-eyebrow', 'Manifesto', this.manifesto)
    const mText = el('p', 'hero-manifesto__text', undefined, this.manifesto)
    el('span', 'sr-only', BRAND.manifesto, mText)
    // sizer keeps the block's height fixed while the visible copy decodes
    const mBox = el('span', 'hero-manifesto__box', undefined, mText)
    mBox.setAttribute('aria-hidden', 'true')
    el('span', 'hero-manifesto__sizer', BRAND.manifesto, mBox)
    const mScr = el('span', 'hero-manifesto__live', '', mBox)
    this.manifestoScr = new Scramble(mScr, '')

    // --- scroll hint (bottom left, inside the safe area) ---
    const sWrap = el('div', 'hero-in hero-scroll-wrap', undefined, this.root)
    this.scroll = el('div', 'hero-scroll', undefined, sWrap)
    const tick = el('span', 'hero-scroll__tick', undefined, this.scroll)
    tick.setAttribute('aria-hidden', 'true')
    el('i', '', undefined, tick)
    el('span', 'hud-label hero-scroll__label', 'Scroll down to discover', this.scroll)

    // --- status readout (bottom left) ---
    this.status = el('div', 'hero-status', undefined, this.root)
    this.status.setAttribute('aria-hidden', 'true')
    const row = el('div', 'hero-status__row', undefined, this.status)
    this.statusSeq = el('span', 'hero-status__seq', 'SEQ 02', row)
    this.statusPhase = el('span', 'hero-status__phase', 'ASSEMBLY', row)
    const bar = el('div', 'hero-status__bar', undefined, this.status)
    this.statusBar = el('i', '', undefined, bar)
    this.statusCount = el('div', 'hero-status__count', '', this.status)

    // --- payoff ---
    this.payoff = el('div', 'hero-payoff', undefined, this.root)
    this.eyebrow = el('p', 'hud-eyebrow hero-payoff__eyebrow', BRAND.name, this.payoff)
    const h1 = el('h1', 'hud-title hero-title', undefined, this.payoff)
    h1.setAttribute('aria-label', BRAND.tagline)
    const words = BRAND.tagline.split(' ')
    const last = words.pop() ?? ''
    const second = words.pop() ?? ''
    const texts = [words.join(' '), second, last].filter(Boolean)
    texts.forEach((text, i) => {
      const line = el('span', `hero-title__line${i === texts.length - 1 ? ' hero-title__accent' : ''}`, text, h1)
      line.setAttribute('aria-hidden', 'true')
      this.lines.push({ d: new Decode(line), text })
    })
    this.ctas = el('div', 'hero-ctas', undefined, this.payoff)
    const work = el('button', 'hud-btn', undefined, this.ctas)
    work.type = 'button'
    work.append('See the work ')
    el('span', 'hero-arrow', '→', work).setAttribute('aria-hidden', 'true')
    work.addEventListener('click', () => window.__hark?.land('work'))
    const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', this.ctas)
    start.href = CONTACT.href
  }

  /** Pin callouts to a few landing bricks. */
  addCallouts(bricks: BrickInfo[], mobile: boolean) {
    const layer = Math.max(...bricks.map(b => b.layer))
    const front = bricks.filter(b => b.layer === layer)
    const wants: { at: number; side: 'left' | 'right'; up: number }[] = mobile
      ? [
          { at: 0.22, side: 'right', up: 1 },
          { at: 0.55, side: 'left', up: -1 },
          { at: 0.86, side: 'right', up: -1 },
        ]
      : [
          { at: 0.18, side: 'right', up: 1 },
          { at: 0.42, side: 'left', up: 1 },
          { at: 0.66, side: 'right', up: -1 },
          { at: 0.9, side: 'left', up: -1 },
        ]
    for (const w of wants) {
      const s = w.side === 'right' ? 1 : -1
      const cands = front.filter(b => Math.abs(b.order - w.at) < 0.06 && Math.sign(b.target.x + b.target.y * 0.2) === s)
      if (!cands.length) continue
      cands.sort((a, b) => s * (b.target.x - a.target.x) + (b.target.y - a.target.y) * w.up * 0.5)
      const brick = cands[0]
      const baseX = mobile ? 26 : 84
      const baseY = (mobile ? 118 : 58) * -w.up
      const callout = new Callout(this.root, { side: w.side, offset: { x: baseX, y: baseY } })
      callout.root.classList.add('hero-co')
      callout.root.setAttribute('aria-hidden', 'true')
      callout.label.textContent = ''
      const numEl = el('span', 'hero-co__num', '', callout.label)
      const l1 = el('span', 'hero-co__l1', '', callout.label)
      const l2 = el('span', 'hero-co__l2', '', callout.label)
      this.callouts.push({
        callout,
        brick,
        num: pad(Math.round(brick.order * 99), 2),
        gate: new Gate(0.28, 0.32),
        numD: new Decode(numEl),
        l1D: new Decode(l1),
        l2D: new Decode(l2),
        tel: `X${signed(brick.target.x)}  Y${signed(brick.target.y)}  Z${signed(brick.target.z)}`,
        sideBase: w.side,
        baseX,
        baseY,
        flipped: false,
        world: new THREE.Vector3(),
      })
    }
  }

  /** Loader finished: power on (once). */
  playIntro(reducedMotion: boolean) {
    if (this.revealed) return
    this.revealed = true
    this.reduced = reducedMotion
    this.root.classList.add('is-on')
    if (reducedMotion) this.manifestoScr.at(BRAND.manifesto, 1)
    else this.manifestoScr.play(BRAND.manifesto, { duration: 1.15, delay: 0.45 })
  }

  update(local: number, landed: number, total: number, surface: number, dt: number, clock: number, reduced: boolean) {
    this.reduced = reduced
    const instant = reduced ? 1e3 : 1

    // intro block (scroll-triggered, time-settled)
    reveal(this.manifesto, ease.outCubic(this.gManifesto.step(local < 0.045, dt * instant)), -12)
    reveal(this.scroll, ease.outCubic(this.gScroll.step(local < 0.03, dt * instant)), 10)

    // status readout
    const sv = this.gStatus.step(local >= 0.07 && local < T.resolveB - 0.004, dt * instant)
    reveal(this.status, ease.outCubic(sv), 8)
    if (sv > 0) {
      const resolving = local >= T.resolveA
      const phase = resolving ? 'RESOLVE' : 'ASSEMBLY'
      if (phase !== this.lastPhase) {
        this.lastPhase = phase
        this.statusSeq.textContent = resolving ? 'SEQ 03' : 'SEQ 02'
        this.statusPhase.textContent = phase
      }
      const count = resolving ? `SURFACE  ${pad(surface * 100, 3)}%` : `${pad(landed, 4)} / ${pad(total, 4)}  BLOCKS LOCKED`
      if (this.statusCount.textContent !== count) this.statusCount.textContent = count
      const p = resolving ? surface : landed / Math.max(1, total)
      this.statusBar.style.transform = `scaleX(${clamp(p).toFixed(4)})`
    }

    // payoff: eyebrow → staggered line decode → CTAs, all settled < 0.8s
    const g = this.gPayoff
    const pv = g.step(local >= T.payoffA + 0.016 && local < T.outA, dt * instant)
    reveal(this.payoff, ease.outCubic(pv), 0)
    if (pv > 0) {
      const t = reduced ? 10 : g.t
      reveal(this.eyebrow, ease.outCubic(clamp(t / 0.4)), 8)
      this.lines.forEach((l, i) => l.d.show(l.text, (t - 0.05 - i * 0.1) / 0.42, clock))
      reveal(this.ctas, ease.outCubic(clamp((t - 0.32) / 0.45)), 14)
    }
  }

  /** Callouts: project each pinned brick, keep the label on screen, decode as its brick locks in. */
  updateCallouts(
    local: number,
    camera: THREE.Camera,
    w: number,
    h: number,
    toWorld: (v: THREE.Vector3, out: THREE.Vector3) => void,
    dt: number,
    clock: number,
  ) {
    const tmp = new THREE.Vector3()
    const gut = clamp(w * 0.034, 16, 44)
    const top = clamp(h * 0.11, 84, 118)
    const bottom = h - clamp(h * 0.1, 76, 104) - 44
    for (const c of this.callouts) {
      const t0 = c.brick.landT
      const on = local >= t0 - 0.004 && local < t0 + 0.12 && local < T.resolveA
      const v = c.gate.step(on, this.reduced ? dt * 1e3 : dt)
      toWorld(c.brick.target, c.world)

      if (v > 0) {
        // --- keep the label inside the gutters / safe area ---
        tmp.copy(c.world).project(camera)
        const sx = (tmp.x * 0.5 + 0.5) * w
        const sy = (-tmp.y * 0.5 + 0.5) * h
        const lw = c.callout.label.offsetWidth || 200
        const lh = c.callout.label.offsetHeight || 32
        const need = c.baseX + 8 + lw
        const room = (side: 'left' | 'right') => (side === 'right' ? w - gut - sx : sx - gut)
        const other = c.sideBase === 'right' ? 'left' : 'right'
        // hysteresis so idle camera sway never makes a label flip back and forth
        if (!c.flipped && room(c.sideBase) < need && room(other) >= need) c.flipped = true
        else if (c.flipped && room(c.sideBase) >= need + 24) c.flipped = false
        let side: 'left' | 'right' = c.flipped ? other : c.sideBase
        let ox = c.baseX
        if (room(side) < need) {
          // neither side fits at full reach: use the roomier side and shorten the leader
          side = room('right') >= room('left') ? 'right' : 'left'
          ox = Math.max(10, room(side) - 8 - lw)
        }
        let oy = c.baseY
        if (sy + oy - 10 < top) oy = Math.abs(oy)
        if (sy + oy - 10 + lh > bottom) oy = -Math.abs(oy)
        c.callout.side = side
        c.callout.offset.x = ox
        c.callout.offset.y = oy
      }
      c.callout.update(c.world, camera, w, h, ease.outCubic(v))
      if (v <= 0) continue

      const t = this.reduced ? 10 : c.gate.t
      const lock = clamp((local - (t0 - 0.01)) / 0.014)
      // same width either way so the label never jumps
      const l1 = `BLOCK_${pad(c.brick.index, 4)} · ${lock >= 1 ? 'LOCKED' : `${pad(lock * 100, 3)}%  `}`
      c.numD.show(c.num, t / 0.28, clock)
      c.l1D.show(l1, (t - 0.05) / 0.4, clock)
      c.l2D.show(c.tel, (t - 0.14) / 0.46, clock)
    }
  }
}
