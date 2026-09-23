import * as THREE from 'three'
import { Callout, el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { clamp, smoothstep } from '../../core/math'
import { BRAND, SERVICES } from '../../content'
import { COUNT, WORLDS, focusCenter } from './system'

interface Item {
  root: HTMLElement
  id: HTMLElement
  title: HTMLElement
  blurb: HTMLElement
  tags: HTMLElement[]
  idText: string
  titleText: string
  shown: boolean
}

const pad = (n: number) => String(n).padStart(2, '0')
const setText = (node: HTMLElement, s: string) => {
  if (node.textContent !== s) node.textContent = s
}

const _v = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _anchor = new THREE.Vector3()

export interface HudState {
  local: number
  /** continuous focus coordinate (k at the center of service k) */
  F: number
  introVis: number
  panelVis: number
  railVis: number
  /** 0..1 progress through the whole services run */
  progress: number
  /** per-world label visibility */
  labels: number[]
  /** telemetry: current orbital angle (degrees) of each world */
  theta: number[]
}

/** DOM overlay for the Orbit chapter: intro, service panel, index rail, callout, ring labels. */
export class ServicesHud {
  private intro: HTMLElement
  private introParts: HTMLElement[]
  private panel: HTMLElement
  private meter: HTMLElement
  private items: Item[] = []
  private rail: HTMLElement
  private railItems: HTMLButtonElement[] = []
  private active = -1
  private callout: Callout
  private coId: HTMLElement
  private coTel1: HTMLElement
  private coTel2: HTMLElement
  private labelWrap: HTMLElement
  private labels: HTMLElement[] = []
  private calloutWorld = 0
  private calloutVis = 0
  private labelVis: number[] = new Array(COUNT).fill(0)
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
    for (const s of SERVICES) {
      const l = el('span', 'svc-label', s.num, this.labelWrap)
      this.labels.push(l)
    }

    // callout pinned to the focused world
    this.callout = new Callout(stage, { side: 'right', offset: { x: 70, y: -92 } })
    this.callout.root.classList.add('svc-callout')
    this.callout.root.setAttribute('aria-hidden', 'true')
    this.coId = el('div', 'svc-co-id', '', this.callout.label)
    this.coTel1 = el('div', 'svc-co-tel', '', this.callout.label)
    this.coTel2 = el('div', 'svc-co-tel svc-co-tel--2', '', this.callout.label)

    // intro
    this.intro = el('div', 'svc-intro', undefined, stage)
    this.intro.setAttribute('aria-hidden', 'true')
    const eyebrow = el('p', 'hud-eyebrow', `Services · 01—${pad(COUNT)}`, this.intro)
    const title = el('h2', 'hud-title svc-intro-title', 'Services', this.intro)
    const body = el('p', 'hud-body svc-intro-body', BRAND.manifesto, this.intro)
    const meta = el('p', 'hud-label svc-intro-meta', `SYS_MAP // ${COUNT} BODIES // STAR HK-0`, this.intro)
    this.introParts = [eyebrow, title, body, meta]

    // service panel: all 11 stacked in one grid cell so the frame never resizes
    this.panel = el('div', 'svc-panel hud-panel', undefined, stage)
    this.panel.setAttribute('aria-hidden', 'true')
    const head = el('div', 'svc-meter', undefined, this.panel)
    this.meter = el('div', 'svc-meter-fill', undefined, head)
    const stack = el('div', 'svc-stack', undefined, this.panel)
    SERVICES.forEach((s, k) => {
      const root = el('div', 'svc-item', undefined, stack)
      const top = el('div', 'svc-item-head', undefined, root)
      const id = el('span', 'svc-id', '', top)
      el('span', 'svc-of', `${s.num} / ${pad(COUNT)}`, top)
      const t = el('h3', 'hud-h2 svc-title', s.title, root)
      el('div', 'hud-rule svc-rule', undefined, root)
      const blurb = el('p', 'hud-body svc-blurb', s.blurb, root)
      const ul = el('ul', 'hud-tags svc-tags', undefined, root)
      const tags = s.tags.map(tag => el('li', 'hud-tag', tag, ul))
      this.items.push({
        root,
        id,
        title: t,
        blurb,
        tags,
        idText: `SERVICE_${s.num}`,
        titleText: s.title,
        shown: true,
      })
      void k
    })

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
    // intro
    const iv = s.introVis
    reveal(this.intro, iv > 0.001 ? 1 : 0, 0)
    this.introParts.forEach((p, i) => reveal(p, clamp(iv * 1.6 - i * 0.18), 16))

    // panel frame + global meter
    reveal(this.panel, s.panelVis, 22)
    this.meter.style.transform = `scaleX(${s.progress.toFixed(4)})`

    // service items crossfade + decode, all derived from the focus coordinate
    for (let k = 0; k < COUNT; k++) {
      const it = this.items[k]
      const d = s.F - k
      const inV = smoothstep(-0.5, -0.26, d)
      const outV = 1 - smoothstep(0.3, 0.5, d)
      const vis = Math.min(inV, outV) * (s.panelVis > 0.01 ? 1 : 0)
      const shown = vis > 0.001
      if (shown !== it.shown) {
        // opacity (not visibility) so children revealed earlier can't leak through
        it.shown = shown
        it.root.style.opacity = shown ? '1' : '0'
      }
      if (!shown) continue
      const dec = Math.min(smoothstep(-0.5, -0.16, d), 1 - smoothstep(0.34, 0.5, d))
      setText(it.id, scrambleAt(it.idText, clamp(dec * 1.4)))
      setText(it.title, scrambleAt(it.titleText, dec))
      reveal(it.id, vis, 0)
      reveal(it.title, vis, 0)
      const bv = smoothstep(-0.42, -0.2, d) * (1 - smoothstep(0.28, 0.46, d))
      reveal(it.blurb, bv, 12)
      it.tags.forEach((tag, i) => {
        const o = i * 0.035
        reveal(tag, smoothstep(-0.38 + o, -0.18 + o, d) * (1 - smoothstep(0.26 - o * 0.5, 0.44 - o * 0.5, d)), 8)
      })
    }

    // rail
    reveal(this.rail, s.railVis, 0)
    const act = s.railVis > 0.01 ? clamp(Math.round(s.F), 0, COUNT - 1) : -1
    if (act !== this.active) {
      this.railItems.forEach((b, i) => {
        b.classList.toggle('is-active', i === act)
        if (i === act) b.setAttribute('aria-current', 'step')
        else b.removeAttribute('aria-current')
      })
      this.active = act
    }

    // callout: focused world + live, decoding telemetry
    const k = clamp(Math.round(s.F), 0, COUNT - 1)
    const d = s.F - k
    const cv = Math.min(smoothstep(-0.45, -0.22, d), 1 - smoothstep(0.26, 0.44, d)) * s.panelVis
    this.calloutWorld = k
    this.calloutVis = cv
    if (cv > 0.001) {
      const w = WORLDS[k]
      const dec = Math.min(smoothstep(-0.45, -0.1, d), 1 - smoothstep(0.3, 0.44, d))
      const inc = w.incl / (Math.PI / 180)
      const th = (((s.theta[k] + 12.84 + k * 29.3) % 360) + 360) % 360
      setText(this.coId, scrambleAt(`ORBIT_${SERVICES[k].num}`, clamp(dec * 1.3)))
      setText(
        this.coTel1,
        scrambleAt(`R ${(w.orbit * 0.74).toFixed(2)} AU · INC ${inc >= 0 ? '+' : '−'}${Math.abs(inc).toFixed(1)}°`, dec),
      )
      setText(this.coTel2, scrambleAt(`PER ${w.period.toFixed(1)}D · Θ ${th.toFixed(1)}°`, clamp(dec * 1.1 - 0.1)))
    }
    for (let i = 0; i < COUNT; i++) this.labelVis[i] = s.labels[i]
  }

  /** Screen-space placement; call with the final render camera. */
  project(camera: THREE.Camera, positions: THREE.Vector3[], w: number, h: number) {
    const cam = camera as THREE.PerspectiveCamera
    _right.setFromMatrixColumn(cam.matrixWorld, 0)
    _up.setFromMatrixColumn(cam.matrixWorld, 1)
    const tanV = Math.tan(((cam.fov ?? 45) * Math.PI) / 360)
    const camPos = cam.position

    // labels sit just outside each world's limb
    for (let k = 0; k < COUNT; k++) {
      const lab = this.labels[k]
      let vis = this.labelVis[k]
      if (vis > 0.001) {
        const P = positions[k]
        _v.copy(P).project(cam)
        const dist = P.distanceTo(camPos)
        const rPx = ((WORLDS[k].radius * WORLDS[k].vis * 0.85) / (dist * tanV)) * (h / 2)
        if (_v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05) vis = 0
        const x = (_v.x * 0.5 + 0.5) * w + rPx * 0.72 + 6
        const y = (-_v.y * 0.5 + 0.5) * h - rPx * 0.72 - 6
        lab.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      }
      reveal(lab, vis, 0)
    }

    // callout anchors on the upper-right limb of the focused world
    const k = this.calloutWorld
    const W = WORLDS[k]
    const R = W.radius * (1 + (W.vis - 1) * 0.35)
    _anchor
      .copy(positions[k])
      .addScaledVector(_right, R * 0.74)
      .addScaledVector(_up, R * 0.74)
    this.callout.side = 'right'
    if (this.compact) this.callout.offset = { x: 26, y: -64 }
    else this.callout.offset = { x: 64, y: -88 }
    this.callout.update(_anchor, cam, w, h, this.calloutVis)
  }
}
