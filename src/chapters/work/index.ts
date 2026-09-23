import * as THREE from 'three'
import './work.css'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { CONTACT, STATS, WORK, workImage, type WorkItem } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { Planet } from '../../world/Planet'
import {
  buildHull,
  createCrystal,
  createDust,
  createFlare,
  createOrbit,
  createShardField,
  crystalPoints,
  type Crystal,
  type Dust,
  type Field,
  type Flare,
  type Orbit,
} from './crystal'
import { Probe } from './probe'

/*
 * WORK — "Artifacts".
 *
 * Storyboard (local progress):
 *   0.00–0.06  in-beat: the camera punches into a drifting field of crystal
 *              debris (warp streaks, flash) and settles on the first artifact
 *   0.06–0.84  six featured projects, 0.13 each: the camera slaloms from
 *              crystal to crystal; each one rotates to present the site
 *              sealed inside it, the hologram boots (scan sweep), the HUD
 *              card decodes and telemetry probes lock on
 *   0.84–0.955 "Nine more, all live." — the other nine sites orbit a small
 *              planet as a ring of labelled shards
 *   0.955–1.0  out-beat: the ring, the planet and the debris collapse into a
 *              single bright point (next: incoming transmissions)
 */

const FEATURED = WORK.filter(w => w.featured).slice(0, 6)
const REST = WORK.filter(w => !w.featured)
const NF = FEATURED.length

// ---- timeline
const F0 = 0.06
const FW = (0.84 - F0) / NF
const HOLD = 0.26
const CREEP = 0.12
const FIN_ARRIVE = 0.885
const OUT0 = 0.955
const centerOf = (i: number) => F0 + FW * (i + 0.5)
/** a project's HUD is on while |l - center| < SHOW·FW (generous: ~72% of its slot) */
const SHOW = 0.36
const HYST = 0.015
const INTRO_END = centerOf(0) - SHOW * FW
const FIN_ON = 0.856

// ---- world layout
const PANEL = new THREE.Vector2(1.3, 0.8125) // half extents: a 16:10 screen 2.6 wide
const DEPTH = 0.5
const SPACING = 17
const LATERAL = 6
const DIR = new THREE.Vector3(0, -0.04, -1).normalize()
const FIN_DIR = new THREE.Vector3(0, -0.34, -1).normalize()
const FIN = new THREE.Vector3(0, -0.8, -(NF - 1) * SPACING - 28)
const RING_R = 5.4
const RING_TILT = 0.3
const CRYSTAL_Y = [0.4, -0.35, 0.3, -0.4, 0.45, -0.25]
const UP = new THREE.Vector3(0, 1, 0)
const TAU = Math.PI * 2

const sideOf = (i: number) => (i % 2 === 0 ? 1 : -1)
const crystalPos = (i: number) => new THREE.Vector3(sideOf(i) * LATERAL, CRYSTAL_Y[i % CRYSTAL_Y.length], -i * SPACING)
const outQuart = (t: number) => 1 - Math.pow(1 - t, 4)
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toUpperCase()
  } catch {
    return url.toUpperCase()
  }
}
const pad2 = (n: number) => String(n).padStart(2, '0')
const code = (i: number) => `ARTIFACT_${pad2(i + 1)}`

/**
 * A time-based HUD beat. Scroll decides *whether* a block should be showing;
 * the fade and the text decode then run on the clock, so every label settles
 * to fully readable text within ~0.8s of the scroll coming to rest.
 */
class Beat {
  on = false
  v = 0
  since = -1e9
  step(on: boolean, time: number, dt: number, tin: number, tout: number) {
    if (on && !this.on) this.since = time
    this.on = on
    this.v = on ? Math.min(1, this.v + dt / tin) : Math.max(0, this.v - dt / tout)
    return this.v
  }
  /** seconds since this beat last switched on */
  age(time: number) {
    return time - this.since
  }
  /** restart the decode clock (content changed while showing) */
  restart(time: number) {
    this.since = time
  }
  reset() {
    this.on = false
    this.v = 0
    this.since = -1e9
  }
}

/** Continuous "station" coordinate: -1 = entry, 0..NF-1 = crystals, NF = finale. */
function stationX(l: number): number {
  const c0 = centerOf(0)
  if (l < c0) {
    const t = l / c0
    return -1 + CREEP * t + (1 - CREEP) * outQuart(clamp(t / 0.66))
  }
  for (let i = 0; i < NF - 1; i++) {
    const b = centerOf(i + 1)
    if (l < b) {
      const t = (l - centerOf(i)) / FW
      return i + CREEP * t + (1 - CREEP) * ease.inOutCubic(segment(t, HOLD, 1 - HOLD))
    }
  }
  const a = centerOf(NF - 1)
  const span = FIN_ARRIVE - a
  const t = (l - a) / span
  if (t < 1) return NF - 1 + CREEP * t + (1 - CREEP) * ease.inOutCubic(segment(t, (HOLD * FW) / span, 0.9))
  return NF
}

interface Station {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
}

const _r = new THREE.Vector3()
const _u = new THREE.Vector3()

function frameAt(
  C: THREE.Vector3,
  D: THREE.Vector3,
  spanW: number,
  spanH: number,
  aspect: number,
  fov: number,
  coverW: number,
  coverH: number,
  ox: number,
  oy: number,
  out: Station,
) {
  const tanH = Math.tan((fov * Math.PI) / 360)
  const dist = Math.max(spanW / 2 / (coverW * tanH * aspect), spanH / 2 / (coverH * tanH))
  const hh = dist * tanH
  const hw = hh * aspect
  _r.crossVectors(D, UP).normalize()
  _u.crossVectors(_r, D).normalize()
  out.pos.copy(C).addScaledVector(D, -dist).addScaledVector(_r, -ox * hw).addScaledVector(_u, -oy * hh)
  out.tgt.copy(out.pos).addScaledVector(D, dist)
  out.fov = fov
}

function catmull(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number) {
  const t2 = t * t
  const t3 = t2 * t
  return out
    .set(0, 0, 0)
    .addScaledVector(a, -0.5 * t3 + t2 - 0.5 * t)
    .addScaledVector(b, 1.5 * t3 - 2.5 * t2 + 1)
    .addScaledVector(c, -1.5 * t3 + 2 * t2 + 0.5 * t)
    .addScaledVector(d, 0.5 * t3 - 0.5 * t2)
}

interface Layout {
  sheet: boolean
  aspect: number
  stations: Station[]
}

function computeLayout(w: number, h: number, spans: { w: number; h: number }[]): Layout {
  const aspect = w / h
  const sheet = w < 760 || aspect <= 1
  const stations: Station[] = []
  for (let i = 0; i < NF + 2; i++) stations.push({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 40 })
  for (let i = 0; i < NF; i++) {
    const s = sideOf(i)
    const span = { w: 5.6, h: 3.4 }
    if (sheet) frameAt(crystalPos(i), DIR, span.w, span.h, aspect, 48, 0.94, 0.33, 0, 0.33, stations[i + 1])
    else frameAt(crystalPos(i), DIR, span.w, span.h, aspect, 34, 0.46, 0.6, s * 0.27, 0.02, stations[i + 1])
  }
  // entry: far back along the path, looking at the first artifact
  const e = stations[0]
  e.pos.copy(stations[1].pos).addScaledVector(DIR, -38).add(new THREE.Vector3(-3.5, 2.6, 0))
  e.tgt.copy(stations[1].tgt)
  e.fov = stations[1].fov + 26
  // finale: the ring of nine around the planet
  const ringW = RING_R * 2 * 1.32 + 1.2
  if (sheet) frameAt(FIN, FIN_DIR, ringW, ringW * 0.62, aspect, 50, 0.98, 0.36, 0, 0.36, stations[NF + 1])
  else frameAt(FIN, FIN_DIR, ringW, ringW * 0.62, aspect, 38, 0.48, 0.52, 0.25, 0.13, stations[NF + 1])
  return { sheet, aspect, stations }
}

interface CamState {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  roll: number
  /** 0..1, how fast we're moving between stations (for aberration / fov) */
  travel: number
}

function evalPose(l: number, lay: Layout, out: CamState) {
  const S = lay.stations
  const u = stationX(l) + 1
  const k = Math.min(Math.floor(u), NF)
  const t = clamp(u - k)
  const a = S[Math.max(k - 1, 0)]
  const b = S[k]
  const c = S[Math.min(k + 1, NF + 1)]
  const d = S[Math.min(k + 2, NF + 1)]
  catmull(out.pos, a.pos, b.pos, c.pos, d.pos, t)
  catmull(out.tgt, a.tgt, b.tgt, c.tgt, d.tgt, t)
  const bump = Math.sin(Math.PI * t)
  out.fov = lerp(b.fov, c.fov, ease.inOutQuad(t)) + (k > 0 ? 7 * bump : 0)
  const dx = c.pos.x - b.pos.x
  out.roll = k > 0 ? -Math.sign(dx) * 0.06 * bump : 0
  out.travel = k > 0 ? bump : 1 - t
  // finale: slow push-in, then the collapse
  const creep = segment(l, FIN_ARRIVE, OUT0)
  if (creep > 0) out.pos.lerp(FIN, 0.07 * creep)
  const o = segment(l, OUT0, 1)
  if (o > 0) {
    out.pos.lerp(FIN, 0.6 * ease.inCubic(o))
    out.tgt.lerp(FIN, smoothstep(0, 0.7, o))
    out.fov += 24 * o * o
    out.travel = Math.max(out.travel, o)
  }
}

// ---------------------------------------------------------------- DOM

interface Card {
  root: HTMLDivElement
  shade: HTMLDivElement
  parts: HTMLElement[]
  code: HTMLElement
  name: HTMLElement
  tele: HTMLElement
}

function buildCard(stage: HTMLElement, item: WorkItem, i: number, facets: number): Card {
  const side = sideOf(i)
  const root = el('div', `wk-card ${side > 0 ? 'is-left' : 'is-right'}`, undefined, stage)
  // soft falloff behind the copy so drifting debris never fights the type
  const shade = el('div', 'wk-shade', undefined, root)
  shade.setAttribute('aria-hidden', 'true')
  const meta = el('div', 'wk-meta', undefined, root)
  meta.setAttribute('aria-hidden', 'true')
  const code = el('span', 'wk-code', '', meta)
  el('span', 'wk-line', undefined, meta)
  el('span', 'wk-count', `${pad2(i + 1)} / ${pad2(NF)}`, meta)
  const ticks = el('span', 'wk-ticks', undefined, meta)
  for (let k = 0; k < NF; k++) el('i', k === i ? 'on' : '', undefined, ticks)

  const h = el('h3', 'hud-h2 wk-name', undefined, root)
  // size the display type so the longest word never breaks mid-letter
  h.style.setProperty('--chars', String(Math.max(...item.name.split(/\s+/).map(w => w.length))))
  el('span', 'sr-only', item.name, h)
  const name = el('span', 'wk-name-vis', '', h)
  name.setAttribute('aria-hidden', 'true')

  const ind = el('p', 'hud-label wk-ind', item.industry, root)
  const blurb = el('p', 'hud-body wk-blurb', item.blurb, root)
  const tags = el('ul', 'hud-tags wk-tags', undefined, root)
  tags.setAttribute('aria-label', 'Services')
  for (const t of item.tags) el('li', 'hud-tag', t, tags)
  const row = el('div', 'wk-row', undefined, root)
  const a = el('a', 'hud-btn hud-btn--ghost wk-visit', undefined, row)
  a.href = item.url
  a.target = '_blank'
  a.rel = 'noopener'
  a.setAttribute('aria-label', `Visit ${item.name} (opens in a new tab)`)
  a.append('Visit site ')
  el('span', 'wk-arrow', '↗', a).setAttribute('aria-hidden', 'true')
  const tele = el('span', 'wk-tele', `SRC // ${host(item.url)} · FACETS ${facets}`, row)
  tele.setAttribute('aria-hidden', 'true')
  return { root, shade, parts: [meta, h, ind, blurb, tags, row], code, name, tele }
}

// ---------------------------------------------------------------- chapter

interface Feat {
  i: number
  item: WorkItem
  side: number
  C: THREE.Vector3
  crystal: Crystal
  anchors: THREE.Vector3[]
  card: Card
  probes: Probe[]
  probeText: ((time: number) => [string, string])[]
  beat: Beat
}

interface Mini {
  item: WorkItem
  k: number
  crystal: Crystal
  probe: Probe
  num: Probe
  dir: number
  dy: number
  appear: number
  beat: Beat
}

class WorkChapter implements Chapter {
  id = 'work'
  group = new THREE.Group()

  private feats: Feat[] = []
  private minis: Mini[] = []
  private field!: Field
  private dust!: Dust
  private flare!: Flare
  private orbit!: Orbit
  private planet: Planet | null = null
  private ring = new THREE.Group()
  private spans: { w: number; h: number }[] = []
  private lay!: Layout
  private layKey = ''
  private cam: CamState = { pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 40, roll: 0, travel: 0 }
  private projCam = new THREE.PerspectiveCamera()
  private dummy = new THREE.Object3D()
  private euler = new THREE.Euler()
  private quat = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private stage!: HTMLElement
  private scrim!: HTMLDivElement
  private intro!: HTMLDivElement
  private introText!: HTMLSpanElement
  private fin!: HTMLDivElement
  private finParts: HTMLElement[] = []
  private reduced = false
  private sheet = false
  private finRect: { left: number; top: number; right: number; bottom: number } | null = null
  // time-based HUD beats
  private introBeat = new Beat()
  private finBeat = new Beat()
  private trBeat = new Beat()
  private active = -1
  private trSeg = -1
  private tr!: {
    root: HTMLDivElement
    from: HTMLSpanElement
    to: HTMLSpanElement
    next: HTMLSpanElement
    track: HTMLSpanElement
    txt: [string, string, string]
  }

  async init(ctx: ChapterContext) {
    this.stage = ctx.stage
    this.reduced = ctx.reducedMotion
    const hq = !ctx.mobile
    const stage = ctx.stage

    // ---- textures (a failed image must never take the chapter down)
    const blank = new THREE.DataTexture(new Uint8Array([6, 10, 12, 255]), 1, 1)
    blank.needsUpdate = true
    const load = (id: string) =>
      ctx.assets.texture(workImage(id)).catch(err => {
        console.warn(`[work] missing screenshot for ${id}`, err)
        return blank as THREE.Texture
      })
    const [featTex, restTex] = await Promise.all([
      Promise.all(FEATURED.map(w => load(w.id))),
      Promise.all(REST.map(w => load(w.id).then(t => downscale(t, 512, 320)))),
    ])
    for (const t of [...featTex, ...restTex]) ctx.renderer.initTexture(t)

    // ---- DOM scaffolding
    el('h2', 'sr-only', 'Artifacts: selected work', stage)
    this.scrim = el('div', 'wk-scrim', undefined, stage)
    this.scrim.setAttribute('aria-hidden', 'true')
    const introWrap = el('div', 'wk-intro', undefined, stage)
    introWrap.setAttribute('aria-hidden', 'true')
    this.intro = el('div', 'wk-intro-in', undefined, introWrap)
    this.introText = el('span', 'wk-intro-text', '', this.intro)

    // transit readout: anchors every scroll position between two artifacts
    const trRoot = el('div', 'wk-transit', undefined, stage)
    trRoot.setAttribute('aria-hidden', 'true')
    const trRow = el('div', 'wk-tr-row', undefined, trRoot)
    const trFrom = el('span', 'wk-tr-id', '', trRow)
    const trTrack = el('span', 'wk-tr-track', undefined, trRow)
    el('i', 'wk-tr-fill', undefined, trTrack)
    el('i', 'wk-tr-dot', undefined, trTrack)
    const trTo = el('span', 'wk-tr-id is-to', '', trRow)
    const trNext = el('span', 'wk-tr-next', '', trRoot)
    this.tr = { root: trRoot, from: trFrom, to: trTo, next: trNext, track: trTrack, txt: ['', '', ''] }
    reveal(trRoot, 0, 0)

    // ---- featured crystals
    FEATURED.forEach((item, i) => {
      const side = sideOf(i)
      const hull = buildHull(crystalPoints(101 + i * 37, PANEL.x, PANEL.y, DEPTH))
      const box = hull.geometry.boundingBox!
      this.spans[i] = { w: box.max.x - box.min.x, h: box.max.y - box.min.y }
      const crystal = createCrystal(hull, featTex[i], PANEL, 3 + i * 5, hq)
      this.group.add(crystal.group)
      const girdle = hull.points.filter(p => Math.abs(p.z) < DEPTH * 0.7)
      const top = hull.points.reduce((m, p) => (p.y > m.y ? p : m))
      const bottom = hull.points.reduce((m, p) => (p.y < m.y ? p : m))
      // upper-outer shoulder: well clear of the top spike and of the far tip
      const shoulder = girdle.filter(p => p.y > 0.25 && p.y < top.y - 0.35)
      const tip = (shoulder.length ? shoulder : girdle).reduce((m, p) => (p.x * side > m.x * side ? p : m))
      const card = buildCard(stage, item, i, hull.facets)
      const probes = ctx.mobile ? [] : [new Probe(stage), new Probe(stage), new Probe(stage)]
      for (const p of probes) p.root.setAttribute('aria-hidden', 'true')
      const seedN = i * 13.7
      const probeText: Feat['probeText'] = [
        () => [`SRC // ${host(item.url)}`, '● LIVE · 200 OK'],
        () => [`FACETS ${hull.facets}`, 'IOR 1.46 · DISP 0.09'],
        t => {
          const n = Math.floor(t * 1.5)
          const sig = -41.2 - ((Math.sin(n * 12.9898 + seedN) * 43758.5453) % 1 + 1) % 1 * 2.4
          const temp = 2.72 + (((Math.sin(n * 78.233 + seedN) * 12543.21) % 1) + 1) % 1 * 0.019
          return [`SIG ${sig.toFixed(2)} DB`, `TEMP ${temp.toFixed(3)} K`]
        },
      ]
      for (let k = 0; k < probes.length; k++) {
        el('span', 'wk-pl1', '', probes[k].label)
        el('span', 'wk-pl2', '', probes[k].label)
      }
      this.feats.push({
        i,
        item,
        side,
        C: crystalPos(i),
        crystal,
        anchors: [top.clone(), tip.clone(), bottom.clone()],
        card,
        probes,
        probeText,
        beat: new Beat(),
      })
    })

    // ---- finale: nine more around a small planet
    this.ring.position.copy(FIN)
    this.ring.rotation.x = RING_TILT
    this.group.add(this.ring)
    this.orbit = createOrbit(RING_R)
    this.ring.add(this.orbit.object)
    try {
      this.planet = new Planet({
        radius: 1.35,
        seed: 23,
        atmosphere: 0x00ff85,
        atmosphereStrength: 1.1,
        cityLights: true,
        rings: false,
        sunDirection: new THREE.Vector3(-0.75, 0.45, -0.5).normalize(),
        spin: 0.05,
        mobile: ctx.mobile,
      })
      this.planet.group.position.copy(FIN)
      this.group.add(this.planet.group)
    } catch (err) {
      console.warn('[work] planet unavailable', err)
      this.planet = null
    }

    const finWrap = el('div', 'wk-fin', undefined, stage)
    this.fin = finWrap
    const eyebrow = el('p', 'hud-eyebrow', `Artifacts ${pad2(NF + 1)}—${pad2(WORK.length)}`, finWrap)
    const title = el('h3', 'hud-h2 wk-fin-title', 'Nine more,\nall live.', finWrap)
    const stat = STATS.find(s => /live sites/i.test(s.label)) ?? STATS[1]
    const body = el('p', 'hud-body wk-fin-body', `${stat.value} ${stat.label.charAt(0).toLowerCase()}${stat.label.slice(1)}.`, finWrap)
    const list = el('ul', 'wk-list', undefined, finWrap)
    list.setAttribute('aria-label', 'More live sites')
    const btn = el('button', 'hud-btn wk-hello', undefined, finWrap)
    btn.type = 'button'
    btn.append(CONTACT.title.replace(/\.$/, '') + ' ')
    el('span', 'wk-arrow', '→', btn).setAttribute('aria-hidden', 'true')
    btn.addEventListener('click', () => window.__hark?.gotoChapter('contact', 0))
    this.finParts = [eyebrow, title, body, list, btn]

    REST.forEach((item, k) => {
      const hull = buildHull(crystalPoints(401 + k * 29, PANEL.x, PANEL.y, DEPTH))
      const crystal = createCrystal(hull, restTex[k], PANEL, 50 + k * 3, false)
      crystal.back.visible = hq
      crystal.uniforms.uEdge.value = 1
      this.ring.add(crystal.group)
      const num = pad2(NF + k + 1)
      // desktop: labelled probe with a live link
      const probe = new Probe(stage, 'wk-mini')
      const a = el('a', 'wk-mini-link', undefined, probe.label)
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.setAttribute('aria-label', `${item.name} (opens in a new tab)`)
      el('span', 'wk-num', num, a).setAttribute('aria-hidden', 'true')
      a.append(item.name)
      el('span', 'wk-pl2', item.industry, probe.label).setAttribute('aria-hidden', 'true')
      // sheet: numbers only, names live in the list
      const numProbe = new Probe(stage, 'wk-mini-num')
      numProbe.root.setAttribute('aria-hidden', 'true')
      numProbe.label.textContent = num
      const li = el('li', '', undefined, list)
      const la = el('a', '', undefined, li)
      la.href = item.url
      la.target = '_blank'
      la.rel = 'noopener'
      la.setAttribute('aria-label', `${item.name} (opens in a new tab)`)
      el('span', 'wk-num', num, la).setAttribute('aria-hidden', 'true')
      la.append(item.name)
      // static label side from the ring angle mid-finale (no flip-flopping)
      const theta = this.ringAngle(k, 0.9)
      this.minis.push({
        item,
        k,
        crystal,
        probe,
        num: numProbe,
        dir: Math.cos(theta) >= 0 ? 1 : -1,
        dy: Math.sin(theta) >= 0 ? 26 : -26,
        appear: 0,
        beat: new Beat(),
      })
    })

    // ---- debris field + dust (keep the camera path and the hero shots clear)
    this.lay = computeLayout(1440, 900, this.spans)
    const lays = [this.lay, computeLayout(390, 844, this.spans)]
    const samples: THREE.Vector3[] = []
    const sightlines: [THREE.Vector3, THREE.Vector3][] = []
    const finLines: [THREE.Vector3, THREE.Vector3][] = []
    const st: CamState = { pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 40, roll: 0, travel: 0 }
    for (const lay of lays) {
      for (let l = 0; l <= 1.0001; l += 0.004) {
        evalPose(l, lay, st)
        samples.push(st.pos.clone())
      }
      for (let i = 0; i < NF; i++) sightlines.push([lay.stations[i + 1].pos.clone(), crystalPos(i)])
      finLines.push([lay.stations[NF + 1].pos.clone(), FIN.clone()])
    }
    const centers = FEATURED.map((_, i) => crystalPos(i))
    const seg = new THREE.Line3()
    const tmp = new THREE.Vector3()
    const accept = (p: THREE.Vector3, s: number) => {
      for (const c of centers) if (p.distanceToSquared(c) < (3.6 + s) ** 2) return false
      if (p.distanceToSquared(FIN) < (RING_R * 1.5 + 1.5) ** 2) return false
      for (const q of samples) if (p.distanceToSquared(q) < (0.9 + s * 1.4) ** 2) return false
      for (const [a, b] of sightlines) {
        seg.set(a, b)
        seg.closestPointToPoint(p, true, tmp)
        if (tmp.distanceToSquared(p) < (1.9 + s) ** 2) return false
      }
      for (const [a, b] of finLines) {
        seg.set(a, b)
        seg.closestPointToPoint(p, true, tmp)
        if (tmp.distanceToSquared(p) < (RING_R * 1.45 + s) ** 2) return false
      }
      return true
    }
    const bounds = new THREE.Box3(new THREE.Vector3(-24, -11, FIN.z - 26), new THREE.Vector3(24, 11, 52))
    this.field = createShardField(ctx.mobile ? 260 : 560, bounds, accept, 11)
    this.group.add(this.field.mesh)
    this.dust = createDust(ctx.mobile ? 1300 : 2800, bounds, 5)
    this.group.add(this.dust.points)

    this.flare = createFlare()
    this.flare.mesh.position.copy(FIN)
    this.group.add(this.flare.mesh)
  }

  private ringAngle(k: number, l: number) {
    return -Math.PI / 2 + 0.35 + (k / REST.length) * TAU + (l - 0.88) * 0.9
  }

  private ensureLayout(f: Frame) {
    const key = `${f.width}x${f.height}`
    if (key === this.layKey) return
    this.layKey = key
    this.lay = computeLayout(f.width, f.height, this.spans)
    this.sheet = this.lay.sheet
    this.finRect = null
    for (const c of this.feats) for (const p of c.probes) p.invalidate()
    for (const m of this.minis) {
      m.probe.invalidate()
      m.num.invalidate()
    }
  }

  onEnter() {
    // replay every HUD beat from scratch when the chapter comes back
    this.introBeat.reset()
    this.finBeat.reset()
    this.trBeat.reset()
    this.active = -1
    this.trSeg = -1
    for (const c of this.feats) c.beat.reset()
    for (const m of this.minis) m.beat.reset()
    this.finRect = null
  }

  /** Which featured project owns the HUD at this scroll position (-1 = none). */
  private pickActive(l: number): number {
    if (l >= FIN_ON) return -1
    for (const c of this.feats) {
      const ap = Math.abs((l - centerOf(c.i)) / FW)
      if (ap < SHOW || (c.i === this.active && ap < SHOW + HYST)) return c.i
    }
    return -1
  }

  update(l: number, f: Frame, ctx: ChapterContext) {
    this.ensureLayout(f)
    evalPose(l, this.lay, this.cam)
    const time = f.time
    const dt = Math.min(Math.max(f.dt, 0), 0.1)
    const calm = this.reduced ? 0.2 : 1
    if (!this.reduced) {
      this.cam.pos.x += Math.sin(time * 0.21) * 0.1
      this.cam.pos.y += Math.sin(time * 0.17 + 1.3) * 0.07
    }

    const inT = segment(l, 0, F0)
    const outT = segment(l, OUT0, 1)

    // ---- HUD beats (scroll picks the target, the clock animates it)
    const rm = this.reduced
    this.active = this.pickActive(l)
    const introOn = l < INTRO_END
    const finOn = l >= FIN_ON && l < OUT0
    const trOn = !introOn && this.active < 0 && l < FIN_ON
    this.introBeat.step(introOn, time, dt, rm ? 0.2 : 0.35, 0.25)
    this.finBeat.step(finOn, time, dt, rm ? 0.25 : 0.75, 0.22)
    this.trBeat.step(trOn, time, dt, rm ? 0.2 : 0.3, 0.2)
    for (const c of this.feats) c.beat.step(c.i === this.active, time, dt, rm ? 0.25 : 0.6, 0.28)

    // ---- sky + post
    const sky = ctx.sky.params
    sky.warp = Math.max(Math.pow(1 - inT, 2) * 0.5, outT * outT * 0.6)
    sky.nebula = 0.85
    sky.hue = -0.15
    sky.stars = 1
    const post = ctx.post.params
    post.bloomStrength = 0.95 + outT * 0.4
    post.bloomRadius = 0.62
    post.vignette = 0.62
    post.aberration = 0.0025 + this.cam.travel * 0.0035
    post.flash = Math.pow(1 - segment(l, 0, 0.035), 3) * 0.3 + smoothstep(0.99, 1, l) * 0.3
    post.exposure = 1 + Math.pow(1 - inT, 2) * 0.3 + outT * 0.12

    // ---- debris + dust
    const pull = ease.inCubic(outT) * 0.97
    this.field.uniforms.uTime.value = time * calm
    this.field.uniforms.uSing.value.copy(FIN)
    this.field.uniforms.uPull.value = pull
    this.dust.uniforms.uTime.value = time * calm
    this.dust.uniforms.uSing.value.copy(FIN)
    this.dust.uniforms.uPull.value = pull
    this.dust.uniforms.uScale.value = 22 * ctx.renderer.getPixelRatio() * (f.height / 900)

    // ---- featured crystals
    for (const c of this.feats) {
      const p = (l - centerOf(c.i)) / FW
      const ap = Math.abs(p)
      const on = p > -1.7 && p < 1.35 && l < FIN_ARRIVE + 0.02
      c.crystal.group.visible = on
      this.updateCard(c, time)
      if (!on) continue
      // the hologram stays fully live for as long as its HUD is up
      const focus = 1 - smoothstep(0.26, 0.55, ap)
      const active = 1 - smoothstep(SHOW - 0.02, 0.62, ap)
      const spin = -1.9 * Math.sign(p) * smoothstep(0.12, 1.3, ap) - 0.3 * p
      const g = c.crystal.group
      g.position.copy(c.C)
      g.position.y += Math.sin(time * 0.5 + c.i * 1.7) * 0.06 * calm
      this.dummy.position.copy(g.position)
      this.dummy.lookAt(this.lay.stations[c.i + 1].pos)
      const hover = focus * (this.reduced ? 0.3 : 1)
      this.euler.set(
        0.05 * Math.sin(time * 0.37 + c.i) * calm - f.pointer.y * 0.2 * hover,
        -c.side * 0.16 + spin + 0.04 * Math.sin(time * 0.29 + c.i) * calm + f.pointer.x * 0.3 * hover,
        c.side * 0.04,
      )
      g.quaternion.copy(this.dummy.quaternion).multiply(this.quat.setFromEuler(this.euler))
      const u = c.crystal.uniforms
      u.uActive.value = active
      u.uTime.value = time
      u.uGlow.value = 0.45 + 0.55 * focus
      u.uEdge.value = 0.5 + 0.6 * focus + 0.6 * inT * (1 - inT) * 4 * (c.i === 0 ? 1 : 0)
      const dist = g.position.distanceTo(this.cam.pos)
      // the last artifact passes right under the lens on the way to the ring:
      // let it dissolve instead of filling the frame
      const handoff = c.i === NF - 1 ? 1 - smoothstep(0.36, 0.56, p) : 1
      u.uFade.value = Math.max(smoothstep(44, 24, dist), focus) * handoff
      g.visible = handoff > 0.001
    }

    // ---- finale ring
    const ringOn = l > 0.8
    this.ring.visible = ringOn
    this.flare.mesh.visible = l > 0.9
    // the planet only rises once the last artifact has handed off (no photobomb)
    const planetIn = smoothstep(0.828, 0.858, l)
    if (this.planet) this.planet.group.visible = planetIn > 0.001
    const collapse = ease.inOutCubic(outT)
    if (ringOn) {
      this.orbit.uniforms.uFade.value = smoothstep(0.83, 0.89, l) * (1 - outT)
      this.orbit.uniforms.uTime.value = time * calm
      this.orbit.object.scale.setScalar(1 - collapse * 0.95)
      if (this.planet) {
        this.planet.group.scale.setScalar(Math.max(0.02, (0.55 + 0.45 * ease.outCubic(planetIn)) * (1 - collapse)))
        this.planet.update(f)
      }
      const camFin = this.lay.stations[NF + 1].pos
      for (const m of this.minis) {
        const appear = ease.outCubic(segment(l, 0.815 + m.k * 0.006, 0.868 + m.k * 0.006))
        m.appear = appear
        m.beat.step(finOn && appear > 0.5, time, dt, rm ? 0.2 : 0.4, 0.2)
        const theta = this.ringAngle(m.k, l) + collapse * 2.4
        const R = RING_R * (1 - collapse) * (0.8 + 0.2 * appear)
        const g = m.crystal.group
        g.visible = appear > 0.001
        g.position.set(Math.cos(theta) * R, Math.sin(time * 0.6 + m.k) * 0.08 * calm, Math.sin(theta) * R)
        g.scale.setScalar(0.34 * appear * (1 - collapse * 0.85))
        g.lookAt(camFin)
        g.rotateY(Math.sin(time * 0.4 + m.k * 1.3) * 0.22 * calm)
        g.rotateX(Math.sin(time * 0.33 + m.k) * 0.12 * calm)
        const u = m.crystal.uniforms
        u.uActive.value = smoothstep(0.3, 1, appear)
        u.uTime.value = time
        u.uGlow.value = 0.85
        u.uFade.value = 1 - outT * 0.3
      }
    } else {
      for (const m of this.minis) {
        m.appear = 0
        m.beat.step(false, time, dt, 0.4, 0.2)
      }
    }
    // the singularity: a hot pinpoint with an anamorphic streak that swallows the ring
    this.flare.uniforms.uSize.value = lerp(0.35, 2.2, outT)
    this.flare.uniforms.uIntensity.value = smoothstep(0, 0.35, outT) * (0.7 + 1.8 * outT)

    // ---- DOM: intro stamp
    const iv = ease.outCubic(this.introBeat.v)
    reveal(this.intro, iv, 0)
    if (iv > 0) {
      const txt = `ARTIFACTS  //  ${pad2(WORK.length)} LIVE SITES`
      const s = this.introBeat.on && !rm ? scrambleAt(txt, this.introBeat.age(time) / 0.6) : txt
      if (this.introText.textContent !== s) this.introText.textContent = s
    }

    // ---- DOM: transit readout
    this.updateTransit(l, time)

    // ---- DOM: finale card
    const fv = this.finBeat.v
    for (let k = 0; k < this.finParts.length; k++) reveal(this.finParts[k], ease.outCubic(smoothstep(k * 0.1, k * 0.1 + 0.6, fv)), 16)
    this.fin.style.visibility = fv > 0.002 ? 'visible' : 'hidden'
    let cardMax = fv
    for (const c of this.feats) cardMax = Math.max(cardMax, c.beat.v)
    reveal(this.scrim, this.sheet ? ease.inOutQuad(cardMax) : 0, 0)

    this.group.updateMatrixWorld(true)
  }

  private updateTransit(l: number, time: number) {
    const tr = this.tr
    const b = this.trBeat
    // the leg we're on: from the last artifact passed to the next stop
    let seg = 0
    for (let i = 0; i < NF; i++) if (l >= centerOf(i)) seg = i
    if (b.on && seg !== this.trSeg) {
      this.trSeg = seg
      b.restart(time)
      const last = seg >= NF - 1
      tr.txt = [
        code(seg),
        last ? `ARTIFACTS ${pad2(NF + 1)}—${pad2(WORK.length)}` : code(seg + 1),
        last ? `NEXT  //  ${pad2(REST.length)} MORE LIVE SITES` : `NEXT  //  ${FEATURED[seg + 1].name.toUpperCase()}`,
      ]
    }
    const v = ease.outCubic(b.v)
    reveal(tr.root, v, 8)
    if (v <= 0) return
    const a = b.on && !this.reduced ? b.age(time) : 99
    const set = (node: HTMLElement, s: string) => {
      if (node.textContent !== s) node.textContent = s
    }
    set(tr.from, scrambleAt(tr.txt[0], a / 0.4))
    set(tr.to, scrambleAt(tr.txt[1], (a - 0.08) / 0.45))
    set(tr.next, scrambleAt(tr.txt[2], (a - 0.15) / 0.55))
    // progress along the leg (scroll-driven, no text)
    const s0 = centerOf(seg) + SHOW * FW
    const s1 = seg >= NF - 1 ? FIN_ON : centerOf(seg + 1) - SHOW * FW
    tr.track.style.setProperty('--p', clamp((l - s0) / (s1 - s0)).toFixed(3))
  }

  private updateCard(c: Feat, time: number) {
    const card = c.card
    const vis = c.beat.v
    card.root.style.visibility = vis > 0.002 ? 'visible' : 'hidden'
    // always drive every part: reveal() writes inline visibility, which would
    // otherwise override the hidden parent after a jump
    reveal(card.shade, ease.inOutQuad(vis), 0)
    for (let k = 0; k < card.parts.length; k++) reveal(card.parts[k], ease.outCubic(smoothstep(k * 0.07, k * 0.07 + 0.5, vis)), 18)
    if (vis <= 0.002) return
    // decode on the clock; once resolved (or while fading out) the text is exact
    const a = c.beat.on && !this.reduced ? c.beat.age(time) : 99
    const cs = scrambleAt(code(c.i), a / 0.45)
    if (card.code.textContent !== cs) card.code.textContent = cs
    const ns = scrambleAt(c.item.name, (a - 0.1) / 0.6)
    if (card.name.textContent !== ns) card.name.textContent = ns
  }

  camera(l: number, f: Frame, out: CameraPose) {
    out.position.copy(this.cam.pos)
    out.target.copy(this.cam.tgt)
    out.fov = this.cam.fov
    out.roll = this.cam.roll
    const outT = segment(l, OUT0, 1)
    out.parallax = (this.sheet ? 0.12 : 0.3) * (1 - outT)
    this.syncProjection(out, f)
    this.placeProbes(f)
  }

  /** Mirror Engine.applyCamera so DOM probes land exactly on the rendered frame. */
  private syncProjection(pose: CameraPose, f: Frame) {
    const cam = this.projCam
    cam.aspect = f.width / f.height
    cam.fov = pose.fov
    cam.near = 0.1
    cam.far = 3000
    cam.position.copy(pose.position)
    cam.up.set(0, 1, 0)
    cam.lookAt(pose.target)
    const par = this.reduced ? 0 : pose.parallax
    if (par) {
      cam.updateMatrixWorld()
      const right = this.v.setFromMatrixColumn(cam.matrixWorld, 0).clone()
      const up = this.v.setFromMatrixColumn(cam.matrixWorld, 1).clone()
      cam.position.addScaledVector(right, f.pointer.x * par).addScaledVector(up, f.pointer.y * par * 0.6)
      cam.lookAt(pose.target)
    }
    if (pose.roll) cam.rotateZ(pose.roll)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
  }

  private project(world: THREE.Vector3, f: Frame): [number, number, boolean] {
    this.v.copy(world).project(this.projCam)
    return [(this.v.x * 0.5 + 0.5) * f.width, (-this.v.y * 0.5 + 0.5) * f.height, this.v.z < 1]
  }

  private placeProbes(f: Frame) {
    const w = f.width
    const h = f.height
    const padX = Math.max(16, Math.min(44, w * 0.034))
    const time = f.time
    // featured telemetry: reveal + decode ride the card's clock
    for (const c of this.feats) {
      if (!c.probes.length) continue
      const vis = c.beat.v
      const show = !this.sheet && c.crystal.group.visible && vis > 0.002
      const age = c.beat.on && !this.reduced ? c.beat.age(time) : 99
      for (let k = 0; k < c.probes.length; k++) {
        const pr = c.probes[k]
        const pv = show ? ease.outCubic(smoothstep(0.2 + k * 0.1, 0.6 + k * 0.1, vis)) : 0
        if (pv <= 0.002) {
          pr.place(0, 0, 0, 1, 0, 0, w, h)
          continue
        }
        this.v.copy(c.anchors[k]).applyMatrix4(c.crystal.group.matrixWorld)
        const [x, y, front] = this.project(this.v, f)
        if (!front) {
          pr.place(0, 0, 0, 1, 0, 0, w, h)
          continue
        }
        const [l1, l2] = c.probeText[k](this.reduced ? 0 : time)
        const t = ((age - 0.12 - k * 0.1) / 0.42) * 1.15
        const s1 = scrambleAt(l1, t)
        const s2 = scrambleAt(l2, t - 0.15)
        const e1 = pr.label.children[0] as HTMLElement
        const e2 = pr.label.children[1] as HTMLElement
        if (e1.textContent !== s1) e1.textContent = s1
        if (e2.textContent !== s2) e2.textContent = s2
        const s = c.side
        if (k === 0) pr.place(x, y, pv, -s, 74, -46, w, h, padX)
        else if (k === 1) pr.place(x, y, pv, s, 52, -38, w, h, padX)
        else pr.place(x, y, pv, s, 70, 42, w, h, padX)
      }
    }
    // the nine (labels steer clear of the finale card). The wrapper itself is
    // never transformed, so its box is the settled layout even mid-reveal.
    if (!this.finRect && this.finBeat.on && !this.sheet) {
      const b = this.fin.getBoundingClientRect()
      if (b.width && b.height) this.finRect = { left: b.left - 12, top: b.top - 20, right: b.right + 16, bottom: b.bottom + 8 }
    }
    for (const m of this.minis) {
      const base = m.beat.v
      const onDesk = !this.sheet && base > 0.002 && m.crystal.group.visible
      const onSheet = this.sheet && base > 0.002 && m.crystal.group.visible
      if (!onDesk) m.probe.place(0, 0, 0, 1, 0, 0, w, h)
      if (!onSheet) m.num.place(0, 0, 0, 1, 0, 0, w, h)
      if (!onDesk && !onSheet) continue
      m.crystal.group.getWorldPosition(this.v)
      const [x, y, front] = this.project(this.v, f)
      const vis = front ? ease.outCubic(base) : 0
      if (onDesk) m.probe.place(x, y, vis, m.dir, 58, m.dy, w, h, padX, this.finRect)
      if (onSheet) m.num.place(x, y, vis, m.dir, 20, m.dy * 0.6, w, h, 10)
    }
  }
}

/** Shrink a loaded image into a small canvas texture (for the nine minis). */
function downscale(tex: THREE.Texture, w: number, h: number): THREE.Texture {
  const img = tex.image as CanvasImageSource | undefined
  if (!img || !(img instanceof HTMLImageElement || img instanceof ImageBitmap || img instanceof HTMLCanvasElement)) return tex
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) return tex
  g.drawImage(img, 0, 0, w, h)
  const out = new THREE.CanvasTexture(canvas)
  out.colorSpace = THREE.SRGBColorSpace
  out.anisotropy = tex.anisotropy
  return out
}

export default function create(): Chapter {
  return new WorkChapter()
}
