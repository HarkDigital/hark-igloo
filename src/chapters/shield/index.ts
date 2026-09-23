import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { clamp, damp, ease, lerp, remap, segment, smoothstep } from '../../core/math'
import { Planet } from '../../world/Planet'
import { SECURITY, STATS } from '../../content'
import { Pulsar } from '../voices/pulsar'
import { Waveform } from '../voices/waveform'
import { HexShield } from './hexShield'
import { Threats } from './threats'
import { Placer, rectOf, type Rect, type Spot } from './place'
import './shield.css'

/*
 * SHIELD — "Hacked? Breathe."
 *
 *   0.00–0.07  in-beat: camera punches in from deep space, streaks rushing past
 *   0.07–0.35  ALERT: red hack attempts strike a damaged hex shield; a breach
 *              flickers; red HUD readout decodes (BREACH DETECTED / THREAT LEVEL)
 *   0.35–0.66  BREATHE: the shield flares green and seals cell-by-cell, threats
 *              dissolve on impact; SECURITY eyebrow/title/body
 *   0.66–0.86  CALM: shield breathes, slow scan band; 24/7 stat + CTA;
 *              callout "SHIELD 100% · MONITORING 24/7"
 *   0.77–0.85  a signal arrives: a green carrier line races in from off-screen
 *              and strikes the shield, which rings; the callout reads INBOUND
 *   0.86–1.00  out-beat: the camera swings back along the line to its source,
 *              a distant pulsar, and punches in as it flares (next: VOICES,
 *              the same pulsar decoding client transmissions)
 *
 * 3D is scroll-driven; HUD copy is picked by scroll but faded/decoded in time
 * (Beat/Decode below) so it always settles fully readable at rest.
 */

const PLANET_R = 2
const SHIELD_R = 2.5
const BREACH = new THREE.Vector3(-0.52, 0.44, 0.73).normalize()
/** the signal source the out-beat turns to (off-screen right during the calm) */
const PSR = new THREE.Vector3(40, 10, -72)
/**
 * Where the carrier strikes the shield: the upper-right limb as seen from the
 * calm pose, arriving along the diagonal toward the screen corner (the only
 * open sky on that side of the planet).
 */
const ARRIVE = new THREE.Vector3(0.54, 0.73, -0.42).normalize()
const HIT = ARRIVE.clone().multiplyScalar(SHIELD_R)
const LINE_P1 = PSR.clone().lerp(HIT, 0.3).add(new THREE.Vector3(0, 7, 0))
const LINE_P2 = HIT.clone().addScaledVector(ARRIVE, 3.2)
/** world-space length of the carrier's last stretch drawn during the arrival */
const ARRIVAL_LEN = 6

/** Parameter u on a cubic Bézier whose remaining arc length to the end is `d`. */
function bezierTail(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, n = 96) {
  const us: number[] = []
  const rem: number[] = []
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const it = 1 - u
    pts.push(
      new THREE.Vector3()
        .addScaledVector(p0, it * it * it)
        .addScaledVector(p1, 3 * it * it * u)
        .addScaledVector(p2, 3 * it * u * u)
        .addScaledVector(p3, u * u * u),
    )
    us.push(u)
  }
  let acc = 0
  rem[n] = 0
  for (let i = n - 1; i >= 0; i--) rem[i] = acc += pts[i].distanceTo(pts[i + 1])
  return (d: number) => {
    if (d <= 0) return 1
    for (let i = n - 1; i >= 0; i--) {
      if (rem[i] >= d) return lerp(us[i], us[i + 1], (rem[i] - d) / Math.max(1e-6, rem[i] - rem[i + 1]))
    }
    return 0
  }
}
const lineTail = bezierTail(PSR, LINE_P1, LINE_P2, HIT)
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]
/** landscape framing at 16:9, solved in NDC: disc radius and centre x */
const LAND_R = 0.379
const LAND_CX = 0.417
const TAN_LAND = Math.tan(THREE.MathUtils.degToRad(36 / 2))

const fract = (v: number) => v - Math.floor(v)
const noise1 = (v: number) => fract(Math.sin(v * 12.9898 + 78.233) * 43758.5453)

function setText(node: HTMLElement, s: string) {
  if (node.textContent !== s) node.textContent = s
}

/**
 * A HUD beat whose visibility is picked by scroll but eased and decoded in
 * time, so text never rests half-faded or half-scrambled.
 */
class Beat {
  vis = 0
  private since = -1
  update(on: boolean, now: number, dt: number) {
    if (on && this.since < 0) this.since = now
    const target = on ? 1 : 0
    this.vis = damp(this.vis, target, on ? 9 : 15, dt)
    if (Math.abs(this.vis - target) < 0.004) this.vis = target
    if (!on && this.vis === 0) this.since = -1
    return this.vis
  }
  reset() {
    this.vis = 0
    this.since = -1
  }
  /** seconds since this beat switched on */
  time(now: number) {
    return this.since < 0 ? 0 : now - this.since
  }
}

/** Replays a short decode whenever the text it shows changes. */
class Decode {
  private text = ''
  private since = 0
  at(now: number, text: string, dur: number, instant = false) {
    if (text !== this.text) {
      this.text = text
      this.since = now
    }
    return instant ? text : scrambleAt(text, (now - this.since) / dur)
  }
}

interface Dom {
  stage: HTMLElement
  tint: HTMLElement
  alert: HTMLElement
  alertHead: HTMLElement
  rows: { label: HTMLElement; text: string; value: HTMLElement }[]
  bars: HTMLElement[]
  level: HTMLElement
  count: HTMLElement
  integ: HTMLElement
  copy: HTMLElement
  eyebrow: HTMLElement
  lines: HTMLElement[]
  body: HTMLElement
  calm: HTMLElement
  calmEyebrow: HTMLElement
  statV: HTMLElement
  statLabel: HTMLElement
  cta: HTMLElement
  breach: Callout
  breachSub: HTMLElement
  status: Callout
  statusSub: HTMLElement
  source: Callout
}

function buildDom(stage: HTMLElement): Dom {
  const tint = el('div', 'sh-tint', undefined, stage)
  tint.setAttribute('aria-hidden', 'true')

  // ALERT readout (decorative telemetry)
  const alert = el('div', 'sh-alert', undefined, stage)
  alert.setAttribute('aria-hidden', 'true')
  const head = el('div', 'sh-alert-head', undefined, alert)
  el('span', 'sh-blip', undefined, head)
  const alertHead = el('span', '', '', head)
  const dl = el('dl', 'sh-rows', undefined, alert)
  const mkRow = (text: string) => {
    const r = el('div', 'sh-row', undefined, dl)
    const label = el('dt', '', '', r)
    const value = el('dd', '', undefined, r)
    return { label, text, value }
  }
  const r0 = mkRow('THREAT LEVEL')
  const bar = el('span', 'sh-bar', undefined, r0.value)
  const bars = Array.from({ length: 10 }, () => el('i', '', undefined, bar))
  const level = el('span', 'sh-hot', '', r0.value)
  const r1 = mkRow('INTRUSIONS / MIN')
  const count = el('span', '', '', r1.value)
  const r2 = mkRow('SHIELD INTEGRITY')
  const integ = el('span', 'sh-hot', '', r2.value)

  // copy column
  const col = el('div', 'sh-col', undefined, stage)
  const copy = el('div', 'sh-copy', undefined, col)
  const eyebrow = el('p', 'hud-eyebrow', '', copy)
  const title = el('h2', 'hud-title sh-title', undefined, copy)
  // split after sentence punctuation (no lookbehind: Safari < 16.4 can't parse it)
  const parts = SECURITY.title.match(/[^?.!]+[?.!]*/g)?.map(p => p.trim()).filter(Boolean) ?? [SECURITY.title]
  const lines: HTMLElement[] = []
  parts.forEach((part, i) => {
    const line = el('span', 'sh-line', undefined, title)
    lines.push(el('span', i === parts.length - 1 && parts.length > 1 ? 'sh-line-in sh-breathe' : 'sh-line-in', part, line))
    if (i < parts.length - 1) title.appendChild(document.createTextNode(' '))
  })
  const body = el('p', 'hud-body sh-body', SECURITY.body, copy)

  const calm = el('div', 'sh-calm', undefined, col)
  const calmEyebrow = el('p', 'hud-eyebrow', '', calm)
  const stat = el('p', 'sh-stat', undefined, calm)
  const statV = el('span', 'sh-stat-v', STAT.value, stat)
  const statLabel = el('p', 'hud-body', STAT.label, calm)
  const ctaRow = el('div', 'sh-cta-row', undefined, calm)
  const cta = el('a', 'hud-btn', SECURITY.cta, ctaRow)
  cta.href = SECURITY.href

  // callouts (plated labels: they often sit over the bright hex rim)
  const breach = new Callout(stage, { side: 'left', offset: { x: 96, y: -64 } })
  breach.root.classList.add('sh-callout', 'sh-callout-alert')
  breach.root.setAttribute('aria-hidden', 'true')
  el('span', '', 'BREACH · SECTOR 07-A', breach.label)
  const breachSub = el('span', 'sh-sub', '', breach.label)

  const status = new Callout(stage, { side: 'left', offset: { x: 92, y: -62 } })
  status.root.classList.add('sh-callout')
  status.root.setAttribute('aria-hidden', 'true')
  const st = el('span', '', undefined, status.label)
  st.innerHTML = `<span class="sh-live"></span>SHIELD <b class="sh-ok">100%</b> · MONITORING <b class="sh-ok">24/7</b>`
  const statusSub = el('span', 'sh-sub', '', status.label)

  const source = new Callout(stage, { side: 'right', offset: { x: 70, y: -58 } })
  source.root.classList.add('sh-callout', 'sh-callout-signal')
  source.root.setAttribute('aria-hidden', 'true')
  el('span', '', 'SIGNAL SOURCE · PSR J2016+HRK', source.label)
  el('span', 'sh-sub', '1420 MHZ · LOCKING ON', source.label)

  return {
    stage,
    tint,
    alert,
    alertHead,
    rows: [r0, r1, r2],
    bars,
    level,
    count,
    integ,
    copy,
    eyebrow,
    lines,
    body,
    calm,
    calmEyebrow,
    statV,
    statLabel,
    cta,
    breach,
    breachSub,
    status,
    statusSub,
    source,
  }
}

// leader directions, most preferred first (x = elbow reach, y = rise; px)
const BREACH_LAND: Spot[] = [
  { side: 'left', x: 96, y: -64 },
  { side: 'left', x: 120, y: 46 },
  { side: 'left', x: 150, y: 96 },
  { side: 'right', x: 96, y: -76 },
  { side: 'left', x: 60, y: -118 },
]
const BREACH_PORT: Spot[] = [
  { side: 'right', x: 26, y: -70 },
  { side: 'right', x: 40, y: -40 },
  { side: 'left', x: 26, y: -70 },
  { side: 'right', x: 40, y: 56 },
]
const STATUS_LAND: Spot[] = [
  { side: 'left', x: 92, y: -62 },
  { side: 'left', x: 60, y: -96 },
  { side: 'right', x: 70, y: -96 },
  { side: 'left', x: 130, y: -24 },
]
const SOURCE_SPOTS: Spot[] = [
  { side: 'right', x: 70, y: -58 },
  { side: 'left', x: 70, y: -58 },
  { side: 'right', x: 70, y: 58 },
  { side: 'left', x: 70, y: 58 },
]

export default function create(): Chapter {
  const group = new THREE.Group()
  let planet: Planet | null = null
  let shield: HexShield
  let threats: Threats
  let pulsar: Pulsar
  let wave: Waveform
  let dom: Dom
  let breachPl: Placer
  let statusPl: Placer
  let sourcePl: Placer
  const res = new THREE.Vector2()
  const toCam = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const anchor = new THREE.Vector3()
  const camRight = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  let shake = 0
  let lastBars = -1

  // HUD blocks the callouts must clear, re-measured only when layout changes
  const blocks = { alert: { l: 0, t: 0, r: 0, b: 0 } as Rect, copy: { l: 0, t: 0, r: 0, b: 0 } as Rect, calm: { l: 0, t: 0, r: 0, b: 0 } as Rect }
  let blocksDirty = true
  let lastW = 0
  let lastH = 0

  /** 0 = landscape layout, 1 = portrait layout */
  const portrait = (f: Frame) => clamp(remap(f.width / f.height, 1.05, 0.62, 0, 1))

  // time-settled HUD beats (scroll picks WHICH state; time plays the decode)
  const bAlert = new Beat()
  const bCopy = new Beat()
  const bCalm = new Beat()
  const bBreach = new Beat()
  const bStatus = new Beat()
  const bSource = new Beat()
  const alertHead = new Decode()
  const statusSub = new Decode()

  function updateDom(local: number, frame: Frame, ctx: ChapterContext, pulse: number, sealed: number) {
    const t = frame.time
    const dt = frame.dt
    const d = dom
    const w = frame.width
    const h = frame.height
    if (w !== lastW || h !== lastH) {
      lastW = w
      lastH = h
      blocksDirty = true
    }
    if (blocksDirty) {
      blocks.alert = rectOf(d.alert, d.stage)
      blocks.copy = rectOf(d.copy, d.stage)
      blocks.calm = rectOf(d.calm, d.stage)
      blocksDirty = false
    }
    // reduced motion: no glyph noise, text simply appears
    const dec = (v: number) => (ctx.reducedMotion ? (v > 0 ? 1 : 0) : v)
    const safe = local > 0.36
    reveal(d.tint, (1 - smoothstep(0.3, 0.42, local)) * (0.55 + 0.45 * pulse), 0)

    // ---- ALERT readout
    // portrait: the planet rises into the readout's space once the copy lands
    const alertEnd = portrait(frame) > 0.5 ? 0.35 : 0.46
    const alertVis = bAlert.update(local > 0.012 && local < alertEnd, t, dt)
    reveal(d.alert, alertVis, 0)
    if (alertVis > 0) {
      const at = bAlert.time(t)
      d.alert.classList.toggle('is-safe', safe)
      setText(d.alertHead, alertHead.at(t, safe ? 'BREACH CONTAINED' : 'BREACH DETECTED', 0.45, ctx.reducedMotion))
      d.rows.forEach((r, i) => setText(r.label, scrambleAt(r.text, dec((at - 0.08 - i * 0.07) / 0.4))))
      const valT = dec((at - 0.22) / 0.4)
      const jitter = noise1(Math.floor(t * 7))
      const lvl = safe ? Math.round(lerp(8, 0, sealed)) : 8 + (jitter > 0.55 ? 1 : 0)
      const nb = valT > 0 ? Math.round(lvl * Math.min(1, valT * 1.4)) : 0
      if (nb !== lastBars) {
        d.bars.forEach((b, i) => b.classList.toggle('on', i < nb))
        lastBars = nb
      }
      const levelText = sealed > 0.85 ? 'CONTAINED' : safe ? 'FALLING' : 'CRITICAL'
      setText(d.level, scrambleAt(levelText, valT))
      const perMin = Math.round(lerp(1284 + jitter * 180, 0, sealed))
      setText(d.count, scrambleAt(perMin.toLocaleString('en-US'), valT))
      const integ = Math.round(lerp(34 + noise1(Math.floor(t * 5) + 3) * 7, 100, sealed))
      setText(d.integ, scrambleAt(`${integ}%`, valT))
    }

    // ---- BREATHE copy
    const copyVis = bCopy.update(local > 0.375 && local < 0.66, t, dt)
    reveal(d.copy, copyVis, 18)
    if (copyVis > 0) {
      const ct = bCopy.time(t)
      setText(d.eyebrow, scrambleAt(SECURITY.eyebrow, dec(ct / 0.6)))
      d.lines.forEach((ln, i) => {
        const k = ctx.reducedMotion ? 1 : ease.outCubic(clamp((ct - 0.06 - i * 0.16) / 0.6))
        ln.style.transform = `translate3d(0, ${((1 - k) * 108).toFixed(1)}%, 0)`
        // drop the mask once risen so glows aren't cut into boxes
        const wrap = ln.parentElement!
        const done = k >= 0.999 ? 'is-done' : ''
        if (wrap.dataset.state !== done) {
          wrap.dataset.state = done
          wrap.classList.toggle('is-done', !!done)
        }
      })
      reveal(d.body, clamp((ct - 0.4) / 0.4), 10)
    }

    // ---- CALM: 24/7 + CTA
    // off before the out-beat swing slides the planet under the copy
    const calmVis = bCalm.update(local > 0.665 && local < 0.862, t, dt)
    reveal(d.calm, calmVis, 18)
    if (calmVis > 0) {
      const mt = bCalm.time(t)
      const eyebrowText = portrait(frame) > 0.5 ? 'Shield 100% · Monitoring 24/7' : 'Always on watch'
      setText(d.calmEyebrow, scrambleAt(eyebrowText, dec(mt / 0.55)))
      setText(d.statV, scrambleAt(STAT.value, dec((mt - 0.08) / 0.5)))
      reveal(d.statLabel, clamp((mt - 0.3) / 0.35), 10)
      reveal(d.cta, clamp((mt - 0.45) / 0.35), 10)
    }

    // ---- callouts (camera is last frame's pose; fine for HUD)
    const cam = ctx.camera
    cam.updateMatrixWorld()
    const port = portrait(frame)
    // labels live between the chrome bands and never on HUD copy
    const safeTop = clamp(h * 0.11, 84, 118)
    const safeBottom = clamp(h * 0.1, 76, 104)
    const bounds: Rect = { l: 0, t: safeTop - 6, r: w, b: h - safeBottom + 10 }
    const avoid: Rect[] = []
    if (alertVis > 0) avoid.push(blocks.alert)
    if (copyVis > 0) avoid.push(blocks.copy)
    if (calmVis > 0) avoid.push(blocks.calm)

    anchor.copy(BREACH).multiplyScalar(SHIELD_R)
    const breachOn = local > 0.1 && local < 0.345
    const breachFits = breachOn && breachPl.place(anchor, cam, w, h, port > 0.5 ? BREACH_PORT : BREACH_LAND, bounds, avoid)
    const breachVis = bBreach.update(breachOn && breachFits, t, dt)
    if (breachVis > 0) {
      const hex = Math.floor(noise1(Math.floor(t * 9)) * 0xffffff)
        .toString(16)
        .toUpperCase()
        .padStart(6, '0')
      const ip = `SRC 185.220.${Math.floor(noise1(Math.floor(t * 3)) * 200) + 20}.${Math.floor(noise1(Math.floor(t * 3) + 9) * 250) + 2}`
      setText(d.breachSub, port > 0.5 ? ip : `${ip} · 0x${hex}`)
    }
    d.breach.update(anchor, cam, w, h, breachVis)

    // landscape only: on portrait the same status line becomes the calm eyebrow
    camRight.setFromMatrixColumn(cam.matrixWorld, 0)
    camUp.setFromMatrixColumn(cam.matrixWorld, 1)
    const a = 2.3 // upper-left rim, leader runs up-left into open space
    anchor
      .set(0, 0, 0)
      .addScaledVector(camRight, Math.cos(a) * SHIELD_R * 0.99)
      .addScaledVector(camUp, Math.sin(a) * SHIELD_R * 0.99)
    const statusOn = local > 0.7 && local < 0.855 && port <= 0.5
    const statusFits = statusOn && statusPl.place(anchor, cam, w, h, STATUS_LAND, bounds, avoid)
    const statusVis = bStatus.update(statusOn && statusFits, t, dt)
    if (statusVis > 0) {
      const inbound = local > 0.79
      setText(
        d.statusSub,
        statusSub.at(t, inbound ? 'INBOUND SIGNAL · 1420 MHZ' : 'ALL SECTORS SEALED · 0 ACTIVE THREATS', 0.4, ctx.reducedMotion),
      )
      d.status.root.classList.toggle('is-inbound', inbound)
    }
    d.status.update(anchor, cam, w, h, statusVis)

    // the out-beat's target: name the source while the camera swings to it
    const sourceOn = local > 0.885 && local < 0.965
    const sourceFits = sourceOn && sourcePl.place(PSR, cam, w, h, SOURCE_SPOTS, bounds, [])
    const sourceVis = bSource.update(sourceOn && sourceFits, t, dt)
    d.source.update(PSR, cam, w, h, sourceVis)
  }

  return {
    id: 'shield',
    group,

    init(ctx) {
      const mobile = ctx.mobile
      try {
        planet = new Planet({
          radius: PLANET_R,
          seed: 7,
          colorA: 0x04070a,
          colorB: 0x1b2c30,
          atmosphere: 0x00ff85,
          atmosphereStrength: 0.9,
          cityLights: true,
          sunDirection: new THREE.Vector3(-0.75, 0.42, 0.52).normalize(),
          spin: 0.035,
          mobile,
        })
        group.add(planet.group)
      } catch (err) {
        console.warn('[shield] planet unavailable', err)
        planet = null
      }

      shield = new HexShield(SHIELD_R, mobile ? 9 : 13, BREACH)
      group.add(shield.mesh)

      threats = new Threats(mobile ? 9 : 14, SHIELD_R, BREACH, shield.impacts, shield.amps, mobile)
      group.add(threats.group)

      // the next chapter's signal: a distant pulsar and its carrier line
      pulsar = new Pulsar(mobile)
      pulsar.group.position.copy(PSR)
      pulsar.group.scale.setScalar(0.55)
      pulsar.group.visible = false
      group.add(pulsar.group)
      wave = new Waveform(mobile)
      wave.setPath(PSR, LINE_P1, LINE_P2, HIT)
      wave.group.visible = false
      group.add(wave.group)

      dom = buildDom(ctx.stage)
      breachPl = new Placer(dom.breach, -14)
      statusPl = new Placer(dom.status, -14)
      sourcePl = new Placer(dom.source, -14)
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => (blocksDirty = true))
        ro.observe(dom.alert)
        ro.observe(dom.copy)
        ro.observe(dom.calm)
      }
      document.fonts?.ready.then(() => (blocksDirty = true)).catch(() => {})
    },

    onEnter() {
      // replay every HUD decode on (re)entry
      for (const b of [bAlert, bCopy, bCalm, bBreach, bStatus, bSource]) b.reset()
      for (const p of [breachPl, statusPl, sourcePl]) p?.reset()
      blocksDirty = true
    },

    update(local, frame, ctx) {
      const tm = frame.time * (ctx.reducedMotion ? 0.4 : 1)
      const alert = 1 - smoothstep(0.32, 0.44, local)
      const activity = 1 - smoothstep(0.3, 0.6, local)
      const sealFront = remap(local, 0.365, 0.52, -0.05, 1.08)
      const sealed = smoothstep(0.37, 0.52, local)
      const calm = smoothstep(0.56, 0.7, local)
      const flare = Math.exp(-Math.pow((local - 0.39) / 0.03, 2))
      const inBeat = 1 - ease.outCubic(segment(local, 0, 0.07))
      const outBeat = ease.inCubic(segment(local, 0.87, 1))
      // the incoming carrier: draws in from the source, strikes, the shield rings
      const draw = segment(local, 0.79, 0.85)
      const hitRing = Math.exp(-Math.pow((local - 0.852) / 0.018, 2))
      const wake = smoothstep(0.74, 0.86, local)

      planet?.update(frame)

      toCam.copy(ctx.camera.position).normalize()
      ctx.renderer.getDrawingBufferSize(res)
      const pulse = threats.update(local, tm, activity, sealed, toCam, res, ctx.renderer.getPixelRatio())
      shake = pulse * alert

      const u = shield.material.uniforms
      u.uTime.value = tm
      u.uAlert.value = alert
      u.uSealFront.value = sealFront
      u.uSealed.value = sealed
      u.uCalm.value = calm
      u.uBreach.value = 1 - smoothstep(0.4, 0.5, local)
      u.uFlare.value = flare + hitRing * 0.4
      u.uIntensity.value = 1 + inBeat * 0.6 + outBeat * 0.4
      u.uCamPos.value.copy(ctx.camera.position)

      // ---- the signal (hidden until it matters: saves the draw calls)
      const live = local > 0.74
      pulsar.group.visible = live
      wave.group.visible = live && draw > 0
      if (live) {
        const wu = wave.u
        wu.uTime.value = tm
        // the far stretch is off-screen: spend the scroll on the last few
        // world units, drawn at constant speed (arc length, not Bézier u)
        const ext = lineTail(ARRIVAL_LEN * (1 - draw))
        wu.uExtent.value = ext
        wu.uAmp.value = 0.34
        // a bright packet rides the leading edge, then the line hums
        wu.uPacket.value = draw < 1 ? ext - 0.012 : -1
        wu.uPacketAmp.value = draw < 1 ? 1 : 0
        wu.uVoice.value = smoothstep(0.84, 0.9, local)
        wu.uGlow.value = 1 + hitRing * 0.8 + outBeat * 0.9
        wave.setView(res, ctx.renderer.getPixelRatio(), local * 0.8)
        pulsar.update({
          time: tm,
          angle: tm * 0.32 + local * 9,
          pulse: wake * 0.35 + hitRing * 0.5 + outBeat * 1.8,
          intensity: 1,
          size: 9 * (1 + outBeat * 0.6),
          beam: 0.3 * wake,
          ring: segment(local, 0.9, 1),
          camPos: ctx.camera.position,
        })
      }

      const p = ctx.post.params
      p.glitch = alert * smoothstep(0.55, 1, pulse) * 0.22 + inBeat * 0.12 + outBeat * 0.1
      p.aberration = 0.0025 + alert * 0.0022 + hitRing * 0.002 + outBeat * 0.005
      p.bloomStrength = 0.95 + flare * 0.25 + hitRing * 0.1 + outBeat * 0.45 + inBeat * 0.2
      p.flash = flare * 0.04 + hitRing * 0.03 + inBeat * inBeat * 0.08 + outBeat * outBeat * 0.06
      p.exposure = 1 + outBeat * 0.12
      // the sky drifts to the next chapter's cool green as the signal takes over
      ctx.sky.params.hue = lerp(0.7 * alert, -0.35, smoothstep(0.8, 0.97, local))
      ctx.sky.params.nebula = lerp(0.65, 0.95, calm)
      ctx.sky.params.warp = inBeat * 0.6 + outBeat * 0.6

      updateDom(local, frame, ctx, pulse, sealed)
    },

    camera(local, frame, out) {
      const port = portrait(frame)
      const inT = ease.outExpo(segment(local, 0, 0.08))
      const shift = ease.inOutCubic(segment(local, 0.28, 0.4))
      const yaw = lerp(-0.2, 0.46, ease.inOutQuad(segment(local, 0.04, 0.96)))
      const pitch = lerp(0.16, 0.07, shift)

      // Landscape framing, solved in NDC so the whole disc sits right of the
      // copy at any aspect: 16:9 keeps the original pose; squarer screens
      // (4:3, 5:4, iPad landscape) pull back and centre it in the free half
      // instead of letting the narrower view crop it.
      const a = Math.max(frame.width / Math.max(1, frame.height), 1.05)
      const sq = clamp(remap(a, 1.78, 1.33))
      const r = lerp(LAND_R, 0.4, sq)
      const cx = lerp(LAND_CX, 0.505, sq)
      const landDist = lerp(11.4, Math.max(11.4, SHIELD_R / (r * TAN_LAND * a)), 1 - port)
      const fit = landDist / 11.4
      const landSide = lerp(2.75, (cx * SHIELD_R) / r, 1 - port)

      let dist = lerp(lerp(9.8 * fit, landDist, shift), lerp(14.6, 15.5, shift), port)
      dist += (1 - inT) * 17
      const cp = Math.cos(pitch)
      out.position.set(Math.sin(yaw) * cp * dist, Math.sin(pitch) * dist, Math.cos(yaw) * cp * dist)

      // push the planet aside for copy: right on landscape, up on portrait
      const side = lerp(landSide, 0, port) * shift
      const drop = lerp(0, lerp(-0.7, 2.2, shift), port)
      out.target.set(-Math.cos(yaw) * side, -drop, Math.sin(yaw) * side)

      if (shake > 0.01 && !frame.reducedMotion) {
        const s = shake * 0.035
        out.position.x += Math.sin(frame.time * 53) * s
        out.position.y += Math.cos(frame.time * 47) * s
      }

      // out-beat: swing back along the carrier to its source and punch in
      const o = ease.inCubic(segment(local, 0.87, 1))
      const look = ease.inOutCubic(segment(local, 0.855, 0.97))
      if (look > 0) {
        out.target.lerp(PSR, look)
        tmp.copy(PSR).sub(out.position).normalize()
        out.position.addScaledVector(tmp, o * 38)
      }
      out.fov = lerp(lerp(36, 47, port), 64, o) + (1 - inT) * 10
      out.roll = (1 - inT) * 0.22 - o * 0.3
      out.parallax = 0.35 * (1 - o)
    },
  }
}
