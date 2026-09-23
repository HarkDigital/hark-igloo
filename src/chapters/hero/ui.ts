import * as THREE from 'three'
import { BRAND, CONTACT } from '../../content'
import { Callout, el, reveal } from '../../core/dom'
import { Scramble, scrambleAt } from '../../core/scramble'
import { clamp, segment, smoothstep } from '../../core/math'
import type { BrickInfo } from './bricks'
import { T } from './shared'

const pad = (n: number, w: number) => String(Math.max(0, Math.round(n))).padStart(w, '0')
const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(3)}`

interface HeroCallout {
  callout: Callout
  brick: BrickInfo
  num: string
  l1: HTMLElement
  l2: HTMLElement
  numEl: HTMLElement
  sideBase: 'left' | 'right'
  world: THREE.Vector3
}

/**
 * All of the hero's DOM: manifesto, scroll hint, coordinates, assembly/resolve
 * status readout, brick callouts and the payoff headline + CTAs.
 */
export class HeroUI {
  root: HTMLDivElement
  private introWraps: HTMLElement[] = []
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
  private lines: { el: HTMLElement; text: string }[] = []
  private ctas: HTMLElement
  callouts: HeroCallout[] = []
  private lastPhase = ''
  private revealed = false

  constructor(stage: HTMLElement) {
    this.root = el('div', 'hero-root', undefined, stage)

    // --- manifesto (top right) ---
    const mWrap = el('div', 'hero-in hero-manifesto', undefined, this.root)
    this.introWraps.push(mWrap)
    this.manifesto = el('div', 'hero-manifesto__inner', undefined, mWrap)
    el('p', 'hud-eyebrow', 'Manifesto', this.manifesto)
    const mText = el('p', 'hero-manifesto__text', undefined, this.manifesto)
    el('span', 'sr-only', BRAND.manifesto, mText)
    const mScr = el('span', '', undefined, mText)
    mScr.setAttribute('aria-hidden', 'true')
    this.manifestoScr = new Scramble(mScr, BRAND.manifesto)

    // --- scroll hint (bottom left, inside the safe area) ---
    const sWrap = el('div', 'hero-in hero-scroll-wrap', undefined, this.root)
    this.introWraps.push(sWrap)
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
      this.lines.push({ el: line, text })
    })
    this.ctas = el('div', 'hero-ctas', undefined, this.payoff)
    const work = el('button', 'hud-btn', undefined, this.ctas)
    work.type = 'button'
    work.append('See the work ')
    el('span', 'hero-arrow', '→', work).setAttribute('aria-hidden', 'true')
    work.addEventListener('click', () => window.__hark?.gotoChapter('work', 0))
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
      const callout = new Callout(this.root, {
        side: w.side,
        offset: { x: mobile ? 26 : 84, y: (mobile ? 118 : 58) * -w.up },
      })
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
        l1,
        l2,
        numEl,
        sideBase: w.side,
        world: new THREE.Vector3(),
      })
    }
  }

  /** Loader finished: play the intro decode. */
  playIntro(reducedMotion: boolean) {
    if (this.revealed) return
    this.revealed = true
    this.root.classList.add('is-on')
    if (!reducedMotion) this.manifestoScr.play(BRAND.manifesto, { duration: 1.6, delay: 0.55 })
  }

  update(local: number, landed: number, total: number, surface: number) {
    // intro block
    const intro = 1 - smoothstep(0.035, 0.075, local)
    reveal(this.manifesto, intro, -10)
    reveal(this.scroll, 1 - smoothstep(0.008, 0.035, local), 10)

    // status readout
    const sVis = Math.min(smoothstep(0.065, 0.1, local), 1 - smoothstep(T.resolveB - 0.02, T.resolveB + 0.01, local))
    reveal(this.status, sVis, 8)
    if (sVis > 0) {
      const resolving = local >= T.resolveA
      const phase = resolving ? 'RESOLVE' : 'ASSEMBLY'
      if (phase !== this.lastPhase) {
        this.lastPhase = phase
        this.statusSeq.textContent = resolving ? 'SEQ 03' : 'SEQ 02'
        this.statusPhase.textContent = phase
      }
      const count = resolving
        ? `SURFACE  ${pad(surface * 100, 3)}%`
        : `${pad(landed, 4)} / ${pad(total, 4)}  BLOCKS LOCKED`
      if (this.statusCount.textContent !== count) this.statusCount.textContent = count
      const p = resolving ? surface : landed / Math.max(1, total)
      this.statusBar.style.transform = `scaleX(${clamp(p).toFixed(4)})`
    }

    // payoff
    const out = 1 - smoothstep(T.outA - 0.012, T.outA + 0.01, local)
    const pa = T.payoffA
    const inV = smoothstep(pa + 0.005, pa + 0.035, local)
    const pv = Math.min(inV, out)
    reveal(this.payoff, pv, 0)
    if (pv > 0) {
      reveal(this.eyebrow, segment(local, pa + 0.005, pa + 0.035), 8)
      this.lines.forEach((l, i) => {
        const t = segment(local, pa + 0.012 + i * 0.016, pa + 0.05 + i * 0.016)
        const s = scrambleAt(l.text, t)
        if (l.el.textContent !== s) l.el.textContent = s
      })
      reveal(this.ctas, segment(local, pa + 0.055, pa + 0.09), 14)
    }
  }

  /** Callouts: project each pinned brick; decode while its brick locks in. */
  updateCallouts(local: number, camera: THREE.Camera, w: number, h: number, toWorld: (v: THREE.Vector3, out: THREE.Vector3) => void) {
    const tmp = new THREE.Vector3()
    for (const c of this.callouts) {
      const t0 = c.brick.landT
      const vis = Math.min(smoothstep(t0 - 0.012, t0 + 0.004, local), 1 - smoothstep(t0 + 0.11, t0 + 0.14, local))
      const outOfPhase = local > T.resolveA
      const v = outOfPhase ? 0 : vis
      toWorld(c.brick.target, c.world)
      // flip the label inward if it would leave the screen
      tmp.copy(c.world).project(camera)
      const sx = (tmp.x * 0.5 + 0.5) * w
      const room = w < 600 ? 150 : 190
      c.callout.side = c.sideBase === 'right' ? (sx + room > w - 12 ? 'left' : 'right') : sx - room < 12 ? 'right' : 'left'
      c.callout.update(c.world, camera, w, h, v)
      if (v <= 0) continue
      const d = segment(local, t0 - 0.006, t0 + 0.03)
      const lock = segment(local, t0 - 0.01, t0 + 0.004)
      c.numEl.textContent = scrambleAt(c.num, d * 1.6)
      c.l1.textContent = scrambleAt(lock >= 1 ? `BLOCK_${pad(c.brick.index, 4)} · LOCKED` : `BLOCK_${pad(c.brick.index, 4)} · ${pad(lock * 100, 3)}%`, d * 1.3)
      const tel = `X${signed(c.brick.target.x)}  Y${signed(c.brick.target.y)}  Z${signed(c.brick.target.z)}`
      c.l2.textContent = scrambleAt(tel, segment(local, t0, t0 + 0.04))
    }
  }
}
