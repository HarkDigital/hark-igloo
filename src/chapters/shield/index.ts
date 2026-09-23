import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { clamp, ease, lerp, remap, segment, smoothstep, window01 } from '../../core/math'
import { Planet } from '../../world/Planet'
import { SECURITY, STATS } from '../../content'
import { HexShield } from './hexShield'
import { Threats } from './threats'
import { Shards } from './shards'
import './shield.css'

/*
 * SHIELD — "Hacked? Breathe."
 *
 *   0.00–0.07  in-beat: camera punches in from deep space, streaks rushing past
 *   0.07–0.35  ALERT: red hack attempts strike a damaged hex shield; a breach
 *              flickers; red HUD readout decodes (BREACH DETECTED / THREAT LEVEL)
 *   0.35–0.66  BREATHE: the shield flares green and seals cell-by-cell, threats
 *              dissolve on impact; SECURITY eyebrow/title/body
 *   0.66–0.92  CALM: shield breathes, slow scan band; 24/7 stat + CTA;
 *              callout "SHIELD 100% · MONITORING 24/7"
 *   0.90–1.00  out-beat: camera swings off into a field of glittering shards
 */

const PLANET_R = 2
const SHIELD_R = 2.5
const BREACH = new THREE.Vector3(-0.52, 0.44, 0.73).normalize()
const SHARD_CENTER = new THREE.Vector3(18, 1, -18)
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]

const fract = (v: number) => v - Math.floor(v)
const noise1 = (v: number) => fract(Math.sin(v * 12.9898 + 78.233) * 43758.5453)

function setText(node: HTMLElement, s: string) {
  if (node.textContent !== s) node.textContent = s
}

interface Dom {
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
  const parts = SECURITY.title.split(/(?<=[?.!])\s+/)
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

  // callouts
  const breach = new Callout(stage, { side: 'left', offset: { x: 96, y: -64 } })
  breach.root.classList.add('sh-callout-alert')
  breach.root.setAttribute('aria-hidden', 'true')
  el('span', '', 'BREACH · SECTOR 07-A', breach.label)
  const breachSub = el('span', 'sh-sub', '', breach.label)

  const status = new Callout(stage, { side: 'left', offset: { x: 92, y: -62 } })
  status.root.setAttribute('aria-hidden', 'true')
  status.label.innerHTML = `<span class="sh-live"></span>SHIELD <b class="sh-ok">100%</b> · MONITORING <b class="sh-ok">24/7</b><span class="sh-sub">ALL SECTORS SEALED · 0 ACTIVE THREATS</span>`

  return {
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
  }
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let planet: Planet | null = null
  let shield: HexShield
  let threats: Threats
  let shards: Shards
  let dom: Dom
  const res = new THREE.Vector2()
  const toCam = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const anchor = new THREE.Vector3()
  const camRight = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  let shake = 0
  let lastBars = -1

  /** 0 = landscape layout, 1 = portrait layout */
  const portrait = (f: Frame) => clamp(remap(f.width / f.height, 1.05, 0.62, 0, 1))

  function updateDom(local: number, frame: Frame, ctx: ChapterContext, pulse: number, sealed: number) {
    const t = frame.time
    const d = dom
    const alertVis = window01(local, 0.012, 0.47, 0.035)
    const safe = local > 0.36
    reveal(d.tint, (1 - smoothstep(0.3, 0.42, local)) * (0.55 + 0.45 * pulse), 0)

    // ---- ALERT readout
    reveal(d.alert, alertVis, 0)
    if (alertVis > 0) {
      d.alert.classList.toggle('is-safe', safe)
      const headText = safe ? 'BREACH CONTAINED' : 'BREACH DETECTED'
      const ht = safe ? segment(local, 0.36, 0.42) : segment(local, 0.02, 0.1)
      setText(d.alertHead, scrambleAt(headText, ht))
      d.rows.forEach((r, i) => setText(r.label, scrambleAt(r.text, segment(local, 0.04 + i * 0.018, 0.11 + i * 0.018))))
      const valT = segment(local, 0.07, 0.14)
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
    const copyVis = window01(local, 0.365, 0.665, 0.03)
    reveal(d.copy, copyVis, 18)
    if (copyVis > 0) {
      setText(d.eyebrow, scrambleAt(SECURITY.eyebrow, segment(local, 0.37, 0.45)))
      d.lines.forEach((ln, i) => {
        const k = ease.outCubic(segment(local, 0.38 + i * 0.03, 0.46 + i * 0.03))
        ln.style.transform = `translate3d(0, ${((1 - k) * 108).toFixed(1)}%, 0)`
        // drop the mask once risen so glows aren't cut into boxes
        const wrap = ln.parentElement!
        const done = k >= 0.999 ? 'is-done' : ''
        if (wrap.dataset.state !== done) {
          wrap.dataset.state = done
          wrap.classList.toggle('is-done', !!done)
        }
      })
      reveal(d.body, segment(local, 0.445, 0.5), 10)
    }

    // ---- CALM: 24/7 + CTA
    const calmVis = window01(local, 0.665, 0.9, 0.035)
    reveal(d.calm, calmVis, 18)
    if (calmVis > 0) {
      const eyebrowText = portrait(frame) > 0.5 ? 'Shield 100% · Monitoring 24/7' : 'Always on watch'
      setText(d.calmEyebrow, scrambleAt(eyebrowText, segment(local, 0.67, 0.73)))
      setText(d.statV, scrambleAt(STAT.value, segment(local, 0.68, 0.75)))
      reveal(d.statLabel, segment(local, 0.71, 0.76), 10)
      reveal(d.cta, segment(local, 0.735, 0.785), 10)
    }

    // ---- callouts (camera is last frame's pose; fine for HUD)
    const cam = ctx.camera
    cam.updateMatrixWorld()
    const w = frame.width
    const h = frame.height
    const port = portrait(frame)
    const breachVis = window01(local, 0.1, 0.345, 0.03)
    anchor.copy(BREACH).multiplyScalar(SHIELD_R)
    if (breachVis > 0) {
      const hex = Math.floor(noise1(Math.floor(t * 9)) * 0xffffff)
        .toString(16)
        .toUpperCase()
        .padStart(6, '0')
      const ip = `SRC 185.220.${Math.floor(noise1(Math.floor(t * 3)) * 200) + 20}.${Math.floor(noise1(Math.floor(t * 3) + 9) * 250) + 2}`
      setText(d.breachSub, port > 0.5 ? ip : `${ip} · 0x${hex}`)
    }
    d.breach.side = port > 0.5 ? 'right' : 'left'
    d.breach.offset.x = port > 0.5 ? 26 : 96
    d.breach.offset.y = port > 0.5 ? -70 : -64
    d.breach.update(anchor, cam, w, h, breachVis)

    // landscape only: on portrait the same status line becomes the calm eyebrow
    const statusVis = window01(local, 0.7, 0.885, 0.03) * (port > 0.5 ? 0 : 1)
    camRight.setFromMatrixColumn(cam.matrixWorld, 0)
    camUp.setFromMatrixColumn(cam.matrixWorld, 1)
    const a = 2.3 // upper-left rim, leader runs up-left into open space
    anchor
      .set(0, 0, 0)
      .addScaledVector(camRight, Math.cos(a) * SHIELD_R * 0.99)
      .addScaledVector(camUp, Math.sin(a) * SHIELD_R * 0.99)
    d.status.update(anchor, cam, w, h, statusVis)
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

      shards = new Shards(mobile ? 90 : 190, SHARD_CENTER, 10, 23)
      group.add(shards.mesh)

      dom = buildDom(ctx.stage)
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
      u.uFlare.value = flare
      u.uIntensity.value = 1 + inBeat * 0.6 + outBeat * 0.4
      u.uCamPos.value.copy(ctx.camera.position)

      const su = shards.material.uniforms
      su.uCamPos.value.copy(ctx.camera.position)
      su.uTime.value = frame.time
      su.uGlow.value = smoothstep(0.85, 0.93, local) * (1 + outBeat)

      const p = ctx.post.params
      p.glitch = alert * smoothstep(0.55, 1, pulse) * 0.22 + inBeat * 0.12
      p.aberration = 0.0025 + alert * 0.0022 + outBeat * 0.005
      p.bloomStrength = 0.95 + flare * 0.25 + outBeat * 0.4 + inBeat * 0.2
      p.flash = flare * 0.04 + inBeat * inBeat * 0.08
      p.exposure = 1 + outBeat * 0.12
      ctx.sky.params.hue = 0.7 * alert
      ctx.sky.params.nebula = lerp(0.65, 0.95, calm)
      ctx.sky.params.warp = inBeat * 0.6 + outBeat * 0.5

      updateDom(local, frame, ctx, pulse, sealed)
    },

    camera(local, frame, out) {
      const port = portrait(frame)
      const inT = ease.outExpo(segment(local, 0, 0.08))
      const shift = ease.inOutCubic(segment(local, 0.3, 0.47))
      const yaw = lerp(-0.2, 0.46, ease.inOutQuad(segment(local, 0.04, 0.96)))
      const pitch = lerp(0.16, 0.07, shift)
      let dist = lerp(lerp(9.8, 11.4, shift), lerp(14.6, 15.5, shift), port)
      dist += (1 - inT) * 17
      const cp = Math.cos(pitch)
      out.position.set(Math.sin(yaw) * cp * dist, Math.sin(pitch) * dist, Math.cos(yaw) * cp * dist)

      // push the planet aside for copy: right on landscape, up on portrait
      const side = lerp(2.75, 0, port) * shift
      const drop = lerp(0, lerp(-0.7, 2.2, shift), port)
      out.target.set(-Math.cos(yaw) * side, -drop, Math.sin(yaw) * side)

      if (shake > 0.01 && !frame.reducedMotion) {
        const s = shake * 0.035
        out.position.x += Math.sin(frame.time * 53) * s
        out.position.y += Math.cos(frame.time * 47) * s
      }

      // out-beat: swing toward the crystal field and punch in
      const o = ease.inCubic(segment(local, 0.87, 1))
      const look = ease.inOutCubic(segment(local, 0.86, 0.975))
      if (look > 0) {
        out.target.lerp(SHARD_CENTER, look)
        tmp.copy(SHARD_CENTER).sub(out.position).normalize()
        out.position.addScaledVector(tmp, o * 16)
      }
      out.fov = lerp(lerp(36, 47, port), 64, o) + (1 - inT) * 10
      out.roll = (1 - inT) * 0.22 - o * 0.3
      out.parallax = 0.35 * (1 - o)
    },
  }
}
