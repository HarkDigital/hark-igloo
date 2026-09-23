import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { clamp, damp, ease, lerp, remap, segment, window01 } from '../../core/math'
import { TESTIMONIALS } from '../../content'
import { Pulsar } from './pulsar'
import { Waveform } from './waveform'
import './voices.css'

/*
 * VOICES — client testimonials arrive as decoded radio transmissions.
 *
 * 3D (scroll-driven by local):
 *   0.00–0.07  in-beat: camera rushes in, the signal line draws out of the pulsar
 *   0.07–0.93  eight equal beats, one per testimonial:
 *                0.00–0.26  a packet races down the waveform toward the viewer
 *                0.28–0.92  the waveform "speaks" (voice modulation)
 *   0.93–1.00  out-beat: the waveform retracts into the pulsar, which flares
 *              into a bright point and a shock ring blooms (next: ring portal)
 *
 * DOM (time-driven so it always settles): the beat under the scroll position
 * picks WHICH transmission is shown; entering a beat cross-fades to it and
 * plays a ~0.7 s decode (header → telemetry → quote word sweep → name). At
 * rest the text is always fully resolved and fully opaque.
 */

const B0 = 0.07
const B1 = 0.93
const N = TESTIMONIALS.length
const SPAN = (B1 - B0) / N
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+=/<>_-'
const noiseWord = (n: number) => {
  let s = ''
  for (let i = 0; i < n; i++) s += GLYPHS[(Math.random() * GLYPHS.length) | 0]
  return s
}
const pad = (n: number) => String(n).padStart(2, '0')

/** decode timeline of one transmission, in seconds after it starts to show */
const T_WORDS0 = 0.14
const T_WORDS1 = 0.62
const T_DONE = 0.9

function setText(node: HTMLElement, s: string) {
  if (node.textContent !== s) node.textContent = s
}

interface Word {
  root: HTMLElement
  noise: HTMLElement
  len: number
  state: number
}

interface Tx {
  root: HTMLElement
  inc: HTMLElement
  incText: string
  src: HTMLElement
  srcText: string
  tel: HTMLElement
  freq: string
  snr: number
  rule: HTMLElement
  mark: HTMLElement
  words: Word[]
  by: HTMLElement
  /** 0..1 damped opacity */
  vis: number
  /** frame time the decode started, -1 when idle */
  start: number
  /** decode fully resolved (no more per-frame DOM writes except telemetry) */
  settled: boolean
  /** scroll-coupled drift (px) kept while fading out */
  drift: number
  lastStyle: string
}

interface Layout {
  fov: number
  star: THREE.Vector3
  p1: THREE.Vector3
  p2: THREE.Vector3
  p3: THREE.Vector3
}

/** camera base: looking down -Z from here; the scene is laid out in its NDC */
const BASE = new THREE.Vector3(0, 0, 12)

// [ndcX, ndcY, depth] for landscape / portrait
const L_LAND = { fov: 42, star: [0.52, 0.44, 150], p1: [0.02, 0.66, 100], p2: [0.8, -0.42, 34], p3: [1.35, -1.4, 6] }
const L_PORT = { fov: 54, star: [0.3, 0.44, 150], p1: [-0.75, 0.62, 95], p2: [0.85, 0.08, 30], p3: [1.7, 0.3, 5] }

export default function create(): Chapter {
  const group = new THREE.Group()
  let pulsar: Pulsar
  let wave: Waveform
  const txs: Tx[] = []
  let head: HTMLElement
  let eyebrow: HTMLElement
  let meter: HTMLElement[] = []
  let status: HTMLElement
  let scrim: HTMLElement
  let starCallout: Callout
  let starSub: HTMLElement
  const res = new THREE.Vector2()
  const layout: Layout = {
    fov: 42,
    star: new THREE.Vector3(),
    p1: new THREE.Vector3(),
    p2: new THREE.Vector3(),
    p3: new THREE.Vector3(),
  }
  let lastMeter = -2

  // time-driven DOM state
  let active = -1
  let kickAt = -10
  let headVis = 0
  let headStart = -1
  let statusText = ''
  let statusStart = 0
  let calloutVis = 0
  let scrimVis = 0

  const portrait = (f: Frame) => clamp(remap(f.width / f.height, 1.05, 0.62, 0, 1))

  function computeLayout(frame: Frame) {
    const k = portrait(frame)
    const aspect = frame.width / Math.max(1, frame.height)
    layout.fov = lerp(L_LAND.fov, L_PORT.fov, k)
    const tv = Math.tan(THREE.MathUtils.degToRad(layout.fov / 2))
    const put = (out: THREE.Vector3, a: number[], b: number[]) => {
      const x = lerp(a[0], b[0], k)
      const y = lerp(a[1], b[1], k)
      const d = lerp(a[2], b[2], k)
      return out.set(BASE.x + x * tv * aspect * d, BASE.y + y * tv * d, BASE.z - d)
    }
    put(layout.star, L_LAND.star, L_PORT.star)
    put(layout.p1, L_LAND.p1, L_PORT.p1)
    put(layout.p2, L_LAND.p2, L_PORT.p2)
    put(layout.p3, L_LAND.p3, L_PORT.p3)
    return k
  }

  function buildDom(stage: HTMLElement) {
    scrim = el('div', 'vx-scrim', undefined, stage)
    scrim.setAttribute('aria-hidden', 'true')

    head = el('div', 'vx-head', undefined, stage)
    head.setAttribute('aria-hidden', 'true')
    eyebrow = el('p', 'hud-eyebrow', '', head)
    const row = el('div', 'vx-meter-row', undefined, head)
    const m = el('div', 'vx-meter', undefined, row)
    meter = TESTIMONIALS.map(() => el('i', '', undefined, m))
    status = el('span', 'vx-status', '', row)

    const deck = el('div', 'vx-deck', undefined, stage)
    TESTIMONIALS.forEach((t, i) => {
      const root = el('article', 'vx-tx', undefined, deck)
      root.setAttribute('aria-label', `Testimonial ${i + 1} of ${N}: ${t.name}, ${t.company}`)
      const meta = el('div', 'vx-meta', undefined, root)
      meta.setAttribute('aria-hidden', 'true')
      const incText = `INCOMING TRANSMISSION ${pad(i + 1)}/${pad(N)}`
      const srcText = `SOURCE: ${t.company.toUpperCase()}`
      const inc = el('span', 'vx-inc', '', meta)
      const src = el('span', 'vx-src', '', meta)
      const tel = el('div', 'vx-tel', '', root)
      tel.setAttribute('aria-hidden', 'true')
      const rule = el('div', 'vx-rule', undefined, root)
      rule.setAttribute('aria-hidden', 'true')

      const bq = el('blockquote', 'vx-quote', undefined, root)
      const mark = el('span', 'vx-mark', '“', bq)
      mark.setAttribute('aria-hidden', 'true')
      const p = el('p', '', undefined, bq)
      const words: Word[] = []
      t.quote.split(/\s+/).forEach((w, j, arr) => {
        const wr = el('span', 'vx-w', undefined, p)
        wr.dataset.s = '0'
        el('span', 'vx-w-r', w, wr)
        const noise = el('span', 'vx-w-n', '', wr)
        noise.setAttribute('aria-hidden', 'true')
        words.push({ root: wr, noise, len: Math.max(2, Math.min(w.length, 12)), state: 0 })
        if (j < arr.length - 1) p.appendChild(document.createTextNode(' '))
      })

      const by = el('footer', 'vx-by', undefined, root)
      el('cite', 'vx-name', t.name, by)
      el('span', 'vx-co', t.company, by)

      root.style.visibility = 'hidden'
      root.style.opacity = '0'
      txs.push({
        root,
        inc,
        incText,
        src,
        srcText,
        tel,
        freq: (1420.405 + ((i * 0.1373) % 0.9)).toFixed(3),
        snr: 31.4 + ((i * 3.7) % 8.5),
        rule,
        mark,
        words,
        by,
        vis: 0,
        start: -1,
        settled: false,
        drift: 0,
        lastStyle: '',
      })
    })

    starCallout = new Callout(stage, { side: 'left', offset: { x: 70, y: -54 } })
    starCallout.root.setAttribute('aria-hidden', 'true')
    starCallout.root.classList.add('vx-star')
    el('span', '', 'PSR J2016+HRK', starCallout.label)
    starSub = el('span', 'vx-sub', 'P 1.3370 S · DM 41.9', starCallout.label)
  }

  function setWord(w: Word, s: number) {
    if (s === w.state) return
    w.state = s
    w.root.dataset.s = String(s)
    if (s !== 1) w.noise.textContent = ''
  }

  /** Put a transmission back to its undecoded state (while invisible). */
  function resetTx(tx: Tx) {
    tx.start = -1
    tx.settled = false
    for (const w of tx.words) setWord(w, 0)
    setText(tx.inc, '')
    setText(tx.src, '')
    setText(tx.tel, '')
    tx.rule.style.transform = 'scaleX(0)'
    reveal(tx.mark, 0, 6)
    reveal(tx.by, 0, 8)
  }

  function telemetry(tx: Tx, time: number) {
    // live readout, ticks at 4 Hz so it reads as telemetry, not flicker
    const q = Math.floor(time * 4)
    const snr = (tx.snr + Math.sin(q * 1.7) * 0.2).toFixed(1)
    const secs = Math.floor(time) % 60
    const mins = Math.floor(time / 60) % 60
    return `FREQ ${tx.freq} MHZ · SNR ${snr} DB · T+00:${pad(mins)}:${pad(secs)}`
  }

  /** Time-based decode. `tau` = seconds since the transmission began showing. */
  function decodeTx(tx: Tx, tau: number, time: number, calm: boolean) {
    if (tx.settled) {
      setText(tx.tel, telemetry(tx, time))
      return
    }
    const k = calm ? 2.2 : 1 // reduced motion: faster, no glyph noise
    const tt = tau * k
    const at = (a: number, b: number) => clamp((tt - a) / (b - a))
    setText(tx.inc, scrambleAt(tx.incText, calm ? 1 : at(0, 0.34)))
    setText(tx.src, scrambleAt(tx.srcText, calm ? 1 : at(0.06, 0.42)))
    setText(tx.tel, scrambleAt(telemetry(tx, time), calm ? 1 : at(0.1, 0.46)))
    tx.rule.style.transform = `scaleX(${ease.outCubic(at(0.04, 0.5)).toFixed(3)})`
    reveal(tx.mark, at(0.08, 0.3), 6)

    // word sweep: a short window of glyph noise runs across the quote
    const W = calm ? 0 : 2.4
    const words = tx.words
    const f = at(T_WORDS0, T_WORDS1) * (words.length + W)
    for (let j = 0; j < words.length; j++) {
      const r = f - j
      const s = r <= 0 ? 0 : r < W ? 1 : 2
      setWord(words[j], s)
      if (s === 1) words[j].noise.textContent = noiseWord(words[j].len)
    }
    reveal(tx.by, at(0.48, 0.72), 8)
    if (tt >= T_DONE) {
      // snap everything to its final state once
      setText(tx.inc, tx.incText)
      setText(tx.src, tx.srcText)
      tx.rule.style.transform = 'scaleX(1)'
      reveal(tx.mark, 1, 6)
      for (const w of words) setWord(w, 2)
      reveal(tx.by, 1, 8)
      tx.settled = true
    }
  }

  function updateDeck(bi: number, ph: number, inBeat: boolean, frame: Frame, calm: boolean) {
    const now = frame.time
    const dt = frame.dt
    const want = inBeat ? bi : -1
    if (want !== active) {
      active = want
      if (want >= 0) kickAt = now
    }
    let others = 0
    for (let i = 0; i < N; i++) if (i !== active) others = Math.max(others, txs[i].vis)

    for (let i = 0; i < N; i++) {
      const tx = txs[i]
      const on = i === active && others < 0.3
      if (on && tx.start < 0) {
        resetTx(tx)
        tx.start = now
      }
      const target = on ? 1 : 0
      tx.vis = damp(tx.vis, target, on ? 10 : 18, dt)
      if (Math.abs(tx.vis - target) < 0.004) tx.vis = target
      if (i === active) tx.drift = (0.5 - ph) * 12
      if (!on && tx.vis === 0 && tx.start >= 0 && i !== active) tx.start = -1

      const o = tx.vis
      const dy = (1 - o) * (i === active ? 16 : -16) + (calm ? 0 : tx.drift)
      const style = `${o.toFixed(3)}|${dy.toFixed(1)}`
      if (style !== tx.lastStyle) {
        tx.lastStyle = style
        tx.root.style.opacity = o.toFixed(3)
        tx.root.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`
        tx.root.style.visibility = o < 0.002 ? 'hidden' : 'visible'
      }
      if (o > 0 && tx.start >= 0) decodeTx(tx, now - tx.start, now, calm)
    }
    return others
  }

  return {
    id: 'voices',
    group,

    init(ctx: ChapterContext) {
      pulsar = new Pulsar(ctx.mobile)
      group.add(pulsar.group)
      wave = new Waveform(ctx.mobile)
      group.add(wave.group)
      buildDom(ctx.stage)
    },

    onEnter() {
      // replay the header + transmission decode every time the chapter is entered
      headStart = -1
      headVis = 0
      calloutVis = 0
      active = -1
      for (const tx of txs) {
        tx.vis = 0
        tx.start = -1
        tx.lastStyle = ''
      }
    },

    update(local, frame, ctx) {
      const port = computeLayout(frame)
      const calm = ctx.reducedMotion
      const t = frame.time * (calm ? 0.4 : 1)
      const x = (local - B0) / SPAN
      const bi = Math.floor(x)
      const ph = x - bi
      const inBeat = bi >= 0 && bi < N
      const outBeat = ease.inCubic(segment(local, 0.93, 1))
      // brief time-based punch whenever a new transmission locks on; decays
      // to nothing so nothing glitches at rest
      const kick = calm ? 0 : Math.exp(-Math.max(0, frame.time - kickAt) * 7) * (inBeat ? 1 : 0)

      // ---- the signal line
      const drawOn = ease.outCubic(segment(local, 0.0, 0.075))
      const collapse = 1 - ease.inCubic(segment(local, 0.925, 0.975))
      const u = wave.u
      u.uTime.value = t
      u.uExtent.value = Math.max(0.0005, Math.min(drawOn, collapse))
      u.uAmp.value = 0.34 * Math.sqrt(collapse)
      u.uPacket.value = inBeat ? ease.inQuad(segment(ph, 0.0, 0.26)) * 1.04 : -1
      u.uPacketAmp.value = inBeat ? window01(ph, 0.0, 0.3, 0.04) : 0
      u.uVoice.value = inBeat ? window01(ph, 0.28, 0.92, 0.1) : 0
      u.uGlow.value = 1 + (1 - drawOn) * 1.2 + outBeat * 0.8 + kick * 0.4
      wave.setPath(layout.star, layout.p1, layout.p2, layout.p3)
      ctx.renderer.getDrawingBufferSize(res)
      wave.setView(res, ctx.renderer.getPixelRatio(), local * 0.8)
      pulsar.group.position.copy(layout.star)

      // ---- the pulsar
      const emit = inBeat ? Math.exp(-Math.pow(ph / 0.045, 2)) * 0.8 : 0
      const flare = window01(local, 0.925, 1.02, 0.05)
      pulsar.update({
        time: t,
        angle: t * 0.32 + local * 7.5,
        pulse: emit + kick * 0.9 + flare * 0.45 + (1 - drawOn) * 1.2,
        intensity: lerp(1, 0.8, port),
        size: lerp(20, 11, port) * (1 - 0.6 * outBeat),
        beam: 0.26 * collapse,
        ring: segment(local, 0.94, 1),
        camPos: ctx.camera.position,
      })

      // ---- post + sky
      const p = ctx.post.params
      p.glitch = kick * 0.12 + outBeat * 0.12
      p.flash = kick * 0.03 + (1 - drawOn) * (1 - drawOn) * 0.08
      p.bloomStrength = 1.0 + kick * 0.25 + outBeat * 0.15
      p.aberration = 0.0025 + kick * 0.002 + outBeat * 0.004
      ctx.sky.params.hue = -0.35
      ctx.sky.params.nebula = 0.75
      ctx.sky.params.warp = (1 - drawOn) * 0.7 + outBeat * 0.8

      // ---- DOM: header (time-damped so it never rests half-faded)
      const dt = frame.dt
      const headOn = local > 0.018 && local < 0.945
      headVis = damp(headVis, headOn ? 1 : 0, headOn ? 8 : 14, dt)
      if (Math.abs(headVis - (headOn ? 1 : 0)) < 0.004) headVis = headOn ? 1 : 0
      reveal(head, headVis, 0)
      if (headOn && headStart < 0) headStart = frame.time
      if (!headOn && headVis === 0) headStart = -1
      if (headVis > 0) {
        const hs = headStart < 0 ? 1 : (frame.time - headStart) / 0.6
        setText(eyebrow, scrambleAt('Client transmissions', calm ? 1 : hs))
        const on = inBeat ? bi : local >= B1 ? N : -1
        if (on !== lastMeter) {
          meter.forEach((m, i) => {
            m.classList.toggle('is-on', i === on)
            m.classList.toggle('is-done', i < on)
          })
          lastMeter = on
        }
        const st =
          local < B0 ? 'SCANNING · 1420 MHZ' : inBeat ? `RX ${pad(bi + 1)}/${pad(N)}` : `${pad(N)}/${pad(N)} DECODED`
        if (st !== statusText) {
          statusText = st
          statusStart = frame.time
        }
        setText(status, scrambleAt(st, calm ? 1 : (frame.time - statusStart) / 0.4))
      }

      // ---- DOM: the transmissions
      updateDeck(bi, ph, inBeat, frame, calm)
      let any = 0
      for (const tx of txs) any = Math.max(any, tx.vis)
      scrimVis = damp(scrimVis, Math.max(any, headVis * 0.6), 8, dt)
      reveal(scrim, scrimVis, 0)

      // ---- star label
      const cam = ctx.camera
      cam.updateMatrixWorld()
      const tall = port > 0.5
      starSub.style.display = tall ? 'none' : ''
      starCallout.side = 'left'
      starCallout.offset.x = tall ? 54 : 150
      starCallout.offset.y = tall ? 46 : -96
      const cOn = local > 0.06 && local < 0.925
      calloutVis = damp(calloutVis, cOn ? 1 : 0, cOn ? 6 : 14, dt)
      if (Math.abs(calloutVis - (cOn ? 1 : 0)) < 0.004) calloutVis = cOn ? 1 : 0
      starCallout.update(layout.star, cam, frame.width, frame.height, calloutVis)
    },

    camera(local, frame, out) {
      computeLayout(frame)
      const inT = ease.outExpo(segment(local, 0, 0.085))
      // a slow, continuous drift along the signal so each transmission is seen
      // from a slightly different vantage (scroll-driven, no time)
      const drift = ease.inOutQuad(segment(local, 0.05, 0.93))
      out.position.set(
        BASE.x + 1.3 * Math.sin(drift * Math.PI) - 0.5 * drift,
        BASE.y - 0.9 * drift + 0.35 * Math.sin(drift * Math.PI * 2),
        BASE.z - 4.5 * drift + (1 - inT) * 26,
      )
      out.target.set(out.position.x * 0.55 + 1.2 * drift, out.position.y * 0.55, -100)
      const look = ease.inOutCubic(segment(local, 0.925, 0.99))
      const o = ease.inExpo(segment(local, 0.93, 1))
      if (look > 0) out.target.lerp(layout.star, look)
      if (o > 0) out.position.lerp(layout.star, o * 0.42)
      out.fov = layout.fov + (1 - inT) * 14 + o * 20
      out.roll = -(1 - inT) * 0.16 + 0.035 * Math.sin(drift * Math.PI * 1.5) + o * 0.12
      out.parallax = 0.45 * (1 - look)
    },
  }
}
