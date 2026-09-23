import * as THREE from 'three'
import { Callout, el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { clamp, ease } from '../../core/math'
import { BRAND, SERVICES } from '../../content'
import { COUNT, WORLDS, focusCenter } from './system'

/*
 * DOM overlay for the Orbit chapter: intro, service panel, index rail,
 * callout and world labels.
 *
 * Scroll (local) decides WHAT is on screen — which service is focused, whether
 * the panel / intro / callout should be up. HOW it arrives (fade, decode,
 * stagger) runs on short time-based tweens that always settle, so whatever
 * position the scroll rests at, every piece of copy ends fully opaque and
 * exactly readable within ~0.8s, and a decode only re-runs when the focused
 * service actually changes.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const setText = (node: HTMLElement, s: string) => {
  if (node.textContent !== s) node.textContent = s
}
/** Opacity-only reveal for nodes whose transform is owned by layout / projection. */
const fade = (node: HTMLElement, v: number) => {
  const o = clamp(v).toFixed(3)
  if (node.style.opacity !== o) {
    node.style.opacity = o
    node.style.visibility = v < 0.002 ? 'hidden' : 'visible'
  }
}
/** 0..1 progress of a staggered step that starts at `delay` seconds and lasts `dur`. */
const step = (t: number, delay: number, dur: number) => clamp((t - delay) / dur)

/** A linear 0..1 tween toward on/off; read `.e` for an eased value. */
class Fade {
  v = 0
  /** seconds since this fade last started rising from 0 */
  t = 0
  constructor(
    private tin: number,
    private tout: number,
  ) {}
  update(on: boolean, dt: number, hold = false) {
    if (on) {
      if (!hold) {
        this.v = Math.min(1, this.v + dt / this.tin)
        this.t += dt
      }
    } else {
      this.v = Math.max(0, this.v - dt / this.tout)
      if (this.v === 0) this.t = 0
    }
    return this
  }
  get e() {
    return ease.outCubic(this.v)
  }
}

interface Item {
  root: HTMLElement
  id: HTMLElement
  titleLive: HTMLElement
  rule: HTMLElement
  blurb: HTMLElement
  tags: HTMLElement[]
  idText: string
  titleText: string
  fade: Fade
  height: number
}

const _v = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _anchor = new THREE.Vector3()

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}
/** does box [x0,x1]×[y0,y1] come within `m` px of rect r? */
const overlaps = (r: Rect | null, x0: number, y0: number, x1: number, y1: number, m: number) =>
  !!r && x1 > r.x0 - m && x0 < r.x1 + m && y1 > r.y0 - m && y0 < r.y1 + m

export interface HudState {
  local: number
  /** continuous focus coordinate (k at the center of service k) */
  F: number
  dt: number
  /** reduced motion: no decode, quicker fades */
  calm: boolean
  introOn: boolean
  panelOn: boolean
  railOn: boolean
  /** the camera is holding on the focused world (not mid-flight) */
  calloutOn: boolean
  labelsOn: boolean
  /** 0..1 progress through the whole services run */
  progress: number
  /** per-world scroll-driven label factor (hides the focused world's tag) */
  labels: number[]
  /** telemetry: current orbital angle (degrees) of each world */
  theta: number[]
}

export class ServicesHud {
  private intro: HTMLElement
  private introEyebrow: HTMLElement
  private introTitle: HTMLElement
  private introBody: HTMLElement
  private introMeta: HTMLElement
  private introFade = new Fade(0.35, 0.18)
  private panel: HTMLElement
  private panelFade = new Fade(0.3, 0.22)
  private stack: HTMLElement
  private meter: HTMLElement
  private items: Item[] = []
  private want = -1
  private stackH = 0
  private measureTick = 0
  private rail: HTMLElement
  private railFade = new Fade(0.45, 0.25)
  private railItems: HTMLButtonElement[] = []
  private active = -1
  private callout: Callout
  private coFade = new Fade(0.25, 0.16)
  private coWorld = 0
  private coId: HTMLElement
  private coTel1: HTMLElement
  private coTel2: HTMLElement
  private labelWrap: HTMLElement
  private labels: HTMLElement[] = []
  private labelFade = new Fade(0.6, 0.25)
  private labelVis: number[] = new Array(COUNT).fill(0)
  private theta: number[] = new Array(COUNT).fill(0)
  private calm = false
  private last = 0
  private rectTick = 0
  private blockers: (Rect | null)[] = [null, null, null]
  compact = false

  constructor(stage: HTMLElement) {
    // screen-reader copy of the whole chapter, in reading order
    const sr = el('div', 'sr-only', undefined, stage)
    el('h2', '', 'Services', sr)
    el('p', '', BRAND.manifesto, sr)
    const list = el('ol', '', undefined, sr)
    for (const s of SERVICES) {
      const li = el('li', '', undefined, list)
      el('h3', '', s.title, li)
      el('p', '', s.blurb, li)
      el('p', '', s.tags.join(', '), li)
    }

    // world labels (01…11) float with their worlds
    this.labelWrap = el('div', 'svc-labels', undefined, stage)
    this.labelWrap.setAttribute('aria-hidden', 'true')
    for (const s of SERVICES) this.labels.push(el('span', 'svc-label', s.num, this.labelWrap))

    // callout pinned to the focused world
    this.callout = new Callout(stage, { side: 'right', offset: { x: 64, y: -88 } })
    this.callout.root.classList.add('svc-callout')
    this.callout.root.setAttribute('aria-hidden', 'true')
    this.coId = el('div', 'svc-co-id', '', this.callout.label)
    this.coTel1 = el('div', 'svc-co-tel', '', this.callout.label)
    this.coTel2 = el('div', 'svc-co-tel svc-co-tel--2', '', this.callout.label)

    // intro
    this.intro = el('div', 'svc-intro', undefined, stage)
    this.intro.setAttribute('aria-hidden', 'true')
    this.introEyebrow = el('p', 'hud-eyebrow svc-intro-eyebrow', '', this.intro)
    this.introTitle = el('h2', 'hud-title svc-intro-title', 'Services', this.intro)
    this.introBody = el('p', 'hud-body svc-intro-body', BRAND.manifesto, this.intro)
    this.introMeta = el('p', 'hud-label svc-intro-meta', '', this.intro)

    // service panel: all 11 share one grid cell; the cell's height eases to the
    // focused item's so the frame breathes instead of jumping
    this.panel = el('div', 'svc-panel hud-panel', undefined, stage)
    this.panel.setAttribute('aria-hidden', 'true')
    const head = el('div', 'svc-meter', undefined, this.panel)
    this.meter = el('div', 'svc-meter-fill', undefined, head)
    this.stack = el('div', 'svc-stack', undefined, this.panel)
    for (const s of SERVICES) {
      const root = el('div', 'svc-item', undefined, this.stack)
      const top = el('div', 'svc-item-head', undefined, root)
      const id = el('span', 'svc-id', `SERVICE_${s.num}`, top)
      el('span', 'svc-of', `${s.num} / ${pad(COUNT)}`, top)
      // the sizer holds the exact title so decoding glyphs never reflow the panel
      const title = el('h3', 'hud-h2 svc-title', undefined, root)
      el('span', 'svc-title-size', s.title, title)
      const titleLive = el('span', 'svc-title-live', s.title, title)
      const rule = el('div', 'hud-rule svc-rule', undefined, root)
      const blurb = el('p', 'hud-body svc-blurb', s.blurb, root)
      const ul = el('ul', 'hud-tags svc-tags', undefined, root)
      const tags = s.tags.map(tag => el('li', 'hud-tag', tag, ul))
      root.style.opacity = '0'
      root.style.visibility = 'hidden'
      this.items.push({
        root,
        id,
        titleLive,
        rule,
        blurb,
        tags,
        idText: `SERVICE_${s.num}`,
        titleText: s.title,
        fade: new Fade(0.25, 0.15),
        height: 0,
      })
    }

    // index rail
    this.rail = el('nav', 'svc-rail', undefined, stage)
    this.rail.setAttribute('aria-label', 'Services index')
    SERVICES.forEach((s, k) => {
      const b = el('button', 'svc-rail-item', undefined, this.rail)
      b.type = 'button'
      b.setAttribute('aria-label', `Service ${s.num}: ${s.title}`)
      el('span', 'svc-rail-t', s.title, b).setAttribute('aria-hidden', 'true')
      el('span', 'svc-rail-n', s.num, b).setAttribute('aria-hidden', 'true')
      el('span', 'svc-rail-bar', undefined, b).setAttribute('aria-hidden', 'true')
      b.addEventListener('click', () => {
        window.__hark?.engine.gotoChapter('services', focusCenter(k), true)
      })
      this.railItems.push(b)
    })
  }

  update(s: HudState) {
    // HUD tweens run on wall-clock time (not the engine's clamped frame dt) so
    // copy settles on schedule even on a janky frame; a long gap just snaps it
    const now = performance.now() / 1000
    const dt = this.last ? clamp(now - this.last, 0, 0.25) : s.dt
    this.last = now
    this.calm = s.calm
    // with reduced motion there is no decode: everything is simply "done"
    const T = (t: number) => (s.calm ? 10 : t)

    /* ---- intro: rises in once the camera has cleared the core ---- */
    const iF = this.introFade.update(s.introOn, dt)
    const it = T(iF.t)
    reveal(this.intro, iF.v > 0.001 ? 1 : 0, 0)
    const iv = iF.e
    setText(this.introEyebrow, scrambleAt(`Services · 01—${pad(COUNT)}`, step(it, 0, 0.42)))
    const tIn = ease.outCubic(step(it, 0.05, 0.6))
    reveal(this.introTitle, iv * tIn, 26)
    reveal(this.introBody, iv * ease.outCubic(step(it, 0.16, 0.5)), 14)
    setText(this.introMeta, scrambleAt(`SYS_MAP // ${COUNT} BODIES // STAR HK-0`, step(it, 0.24, 0.42)))
    reveal(this.introEyebrow, iv, 0)
    reveal(this.introMeta, iv * step(it, 0.24, 0.2), 0)

    /* ---- panel frame (waits for the intro to clear: they share a corner) ---- */
    const pF = this.panelFade.update(s.panelOn, dt, this.introFade.v > 0.2)
    reveal(this.panel, pF.e, 22)
    this.meter.style.transform = `scaleX(${s.progress.toFixed(4)})`

    /* ---- focused service: fade the old one out, then decode the new one in ---- */
    const want = s.panelOn ? clamp(Math.round(s.F), 0, COUNT - 1) : -1
    if (want !== this.want) {
      this.want = want
      if (want >= 0) this.setStackHeight(this.measure(want))
    }
    let others = 0
    for (let k = 0; k < COUNT; k++) if (k !== want) others = Math.max(others, this.items[k].fade.v)
    for (let k = 0; k < COUNT; k++) {
      const item = this.items[k]
      const f = item.fade
      const was = f.v
      f.update(k === want, dt, k === want && (others > 0.04 || pF.v < 0.2))
      if (f.v === 0 && was === 0) continue
      const t = T(f.t)
      const o = f.v.toFixed(3)
      if (item.root.style.opacity !== o) {
        item.root.style.opacity = o
        item.root.style.visibility = f.v > 0.001 ? 'visible' : 'hidden'
      }
      if (k !== want) continue // leaving: keep the settled copy, just fade
      setText(item.id, scrambleAt(item.idText, step(t, 0, 0.32)))
      setText(item.titleLive, scrambleAt(item.titleText, step(t, 0.03, 0.46)))
      reveal(item.titleLive, ease.outCubic(step(t, 0, 0.25)), 10)
      item.rule.style.transform = `scaleX(${ease.outCubic(step(t, 0.06, 0.45)).toFixed(3)})`
      reveal(item.blurb, ease.outCubic(step(t, 0.1, 0.42)), 12)
      item.tags.forEach((tag, i) => reveal(tag, ease.outCubic(step(t, 0.18 + i * 0.05, 0.32)), 8))
    }
    // fonts can land late / widths change on resize: re-measure now and then
    if (++this.measureTick % 30 === 0 && want >= 0) {
      const h = this.measure(want)
      if (Math.abs(h - this.stackH) > 1) this.setStackHeight(h)
    }

    /* ---- rail ---- */
    const rF = this.railFade.update(s.railOn, dt)
    fade(this.rail, rF.e)
    const act = s.railOn ? clamp(Math.round(s.F), 0, COUNT - 1) : -1
    if (act !== this.active) {
      this.railItems.forEach((b, i) => {
        b.classList.toggle('is-active', i === act)
        if (i === act) b.setAttribute('aria-current', 'step')
        else b.removeAttribute('aria-current')
      })
      this.active = act
    }

    /* ---- callout: only while the camera holds on a world ---- */
    const kWant = clamp(Math.round(s.F), 0, COUNT - 1)
    const cF = this.coFade
    if (s.calloutOn && kWant !== this.coWorld) {
      cF.update(false, dt)
      if (cF.v === 0) this.coWorld = kWant
    } else cF.update(s.calloutOn, dt, pF.v < 0.1)
    if (cF.v > 0) {
      const k = this.coWorld
      const w = WORLDS[k]
      const ct = T(cF.t)
      const inc = w.incl / (Math.PI / 180)
      const th = (((s.theta[k] + 12.84 + k * 29.3) % 360) + 360) % 360
      setText(this.coId, scrambleAt(`ORBIT_${SERVICES[k].num}`, step(ct, 0, 0.3)))
      setText(
        this.coTel1,
        scrambleAt(
          `R ${(w.orbit * 0.74).toFixed(2)} AU · INC ${inc >= 0 ? '+' : '−'}${Math.abs(inc).toFixed(1)}°`,
          step(ct, 0.06, 0.4),
        ),
      )
      setText(this.coTel2, scrambleAt(`PER ${w.period.toFixed(1)}D · Θ ${th.toFixed(1)}°`, step(ct, 0.12, 0.4)))
    }

    /* ---- world labels ---- */
    const lF = this.labelFade.update(s.labelsOn, dt)
    for (let i = 0; i < COUNT; i++) {
      this.labelVis[i] = s.labels[i] * lF.e
      this.theta[i] = s.theta[i]
    }
  }

  private measure(k: number) {
    const item = this.items[k]
    item.height = item.root.offsetHeight
    return item.height
  }

  private setStackHeight(h: number) {
    if (!h) return
    // first time: snap; afterwards the CSS transition eases it
    if (!this.stackH) this.stack.style.transition = 'none'
    this.stack.style.height = `${h}px`
    if (!this.stackH) {
      void this.stack.offsetHeight
      this.stack.style.transition = ''
    }
    this.stackH = h
  }

  private refreshBlockers() {
    const r = (node: HTMLElement, on: boolean): Rect | null => {
      if (!on) return null
      const b = node.getBoundingClientRect()
      return { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom }
    }
    this.blockers[0] = r(this.intro, this.introFade.v > 0.01)
    this.blockers[1] = r(this.panel, this.panelFade.v > 0.01)
    this.blockers[2] = r(this.rail, this.railFade.v > 0.01)
  }

  /** Screen-space placement; call with the final render camera. */
  project(camera: THREE.Camera, positions: THREE.Vector3[], w: number, h: number) {
    const cam = camera as THREE.PerspectiveCamera
    _right.setFromMatrixColumn(cam.matrixWorld, 0)
    _up.setFromMatrixColumn(cam.matrixWorld, 1)
    const tanV = Math.tan(((cam.fov ?? 45) * Math.PI) / 360)
    const camPos = cam.position
    // mirrors --gutter / --safe-top / --safe-bottom in base.css
    const gutter = clamp(w * 0.034, 16, 44)
    const safeTop = clamp(h * 0.11, 84, 118)
    const safeBottom = clamp(h * 0.1, 76, 104)
    if (++this.rectTick % 6 === 0 || this.rectTick < 3) this.refreshBlockers()

    /* callout: anchored on the upper-right limb of the focused world, then
       nudged / flipped so the label always stays fully on screen */
    const k = this.coWorld
    const W = WORLDS[k]
    const R = W.radius * (1 + (W.vis - 1) * 0.35)
    _anchor
      .copy(positions[k])
      .addScaledVector(_right, R * 0.74)
      .addScaledVector(_up, R * 0.74)
    const cv = this.coFade.e
    let co: Rect | null = null
    if (cv > 0.001) {
      _v.copy(_anchor).project(cam)
      const ax = (_v.x * 0.5 + 0.5) * w
      const ay = (-_v.y * 0.5 + 0.5) * h
      const lw = this.callout.label.offsetWidth || 180
      const lh = this.callout.label.offsetHeight || 50
      const want = this.compact ? 26 : 64
      let oy = this.compact ? -60 : -88
      // horizontal room for the label on each side of the anchor (label kept inside the gutters)
      const maxR = w - gutter - lw - 8 - ax
      const maxL = ax - 8 - lw - gutter
      let side: 'left' | 'right' = 'right'
      let ox = Math.min(want, maxR)
      if (ox < 16 && maxL > ox) {
        side = 'left'
        ox = Math.min(want, maxL)
      }
      // neither side has room (narrow phones): stay right, sliding the label back on screen
      if (side === 'right') ox = Math.max(ox, gutter - 8 - ax)
      const top = safeTop + (this.compact ? 40 : 0)
      if (ay + oy - 10 < top) oy = Math.min(-16, top + 10 - ay)
      if (ay + oy - 10 < top) oy = top + 10 - ay
      const bottom = h - safeBottom
      if (ay + oy - 10 + lh > bottom) oy = bottom - lh + 10 - ay
      this.callout.side = side
      this.callout.offset = { x: ox, y: oy }
      const lx = side === 'right' ? ax + ox + 8 : ax - ox - 8 - lw
      co = { x0: lx, y0: ay + oy - 10, x1: lx + lw, y1: ay + oy - 10 + lh }
    }
    this.callout.update(_anchor, cam, w, h, cv)

    /* world labels sit just outside each world's limb; they bow out near the
       screen edges and wherever copy (intro, panel, rail, callout) is */
    for (let i = 0; i < COUNT; i++) {
      const lab = this.labels[i]
      let vis = this.labelVis[i]
      if (vis > 0.001) {
        const P = positions[i]
        _v.copy(P).project(cam)
        if (_v.z > 1) vis = 0
        else {
          const dist = P.distanceTo(camPos)
          const rPx = ((WORLDS[i].radius * WORLDS[i].vis * 0.85) / (dist * tanV)) * (h / 2)
          const x = (_v.x * 0.5 + 0.5) * w + rPx * 0.72 + 6
          const y = (-_v.y * 0.5 + 0.5) * h - rPx * 0.72 - 6
          const lw = 34
          const edge = Math.min(
            clamp((x - gutter) / 24),
            clamp((w - gutter - lw - x) / 24),
            clamp((y - safeTop) / 24),
            clamp((h - safeBottom - y) / 24),
          )
          vis *= edge
          for (const b of this.blockers) if (overlaps(b, x, y - 8, x + lw, y + 8, 14)) vis = 0
          if (overlaps(co, x, y - 8, x + lw, y + 8, 14)) vis = 0
          if (vis > 0.001) lab.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - 7).toFixed(1)}px, 0)`
        }
      }
      fade(lab, vis)
    }
  }
}
