import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal } from '../../core/dom'
import { scrambleAt } from '../../core/scramble'
import { clamp, ease, lerp, remap, segment, smoothstep, window01 } from '../../core/math'
import { TESTIMONIALS } from '../../content'
import { Pulsar } from './pulsar'
import { Waveform } from './waveform'
import './voices.css'

/*
 * VOICES — client testimonials arrive as decoded radio transmissions.
 *
 *   0.00–0.07  in-beat: camera rushes in, the signal line draws out of the pulsar
 *   0.07–0.93  eight equal beats, one per testimonial:
 *                0.00–0.26  a packet races down the waveform toward the viewer
 *                0.00–0.18  mono header + telemetry decode
 *                0.20–0.50  the quote decodes word by word, then settles
 *                0.42–0.52  name + company
 *                0.30–0.92  the waveform "speaks" (voice modulation)
 *                0.86–0.98  transmission fades out
 *   0.93–1.00  out-beat: the waveform collapses into the pulsar, a shock ring
 *              blooms (next chapter is the ring portal)
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
const DBG = new URLSearchParams(location.search).get('vxdbg') ?? '' // TEMP bisect

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
  shown: boolean
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
const L_PORT = { fov: 54, star: [0.14, 0.6, 150], p1: [-0.9, 0.75, 95], p2: [0.75, 0.05, 30], p3: [1.7, 0.32, 5] }

export default function create(): Chapter {
  const group = new THREE.Group()
  let pulsar: Pulsar
  let wave: Waveform
  const txs: Tx[] = []
  let head: HTMLElement
  let eyebrow: HTMLElement
  let meter: HTMLElement[] = []
  let status: HTMLElement
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
        shown: false,
      })
    })

    starCallout = new Callout(stage, { side: 'left', offset: { x: 70, y: -54 } })
    starCallout.root.setAttribute('aria-hidden', 'true')
    el('span', '', 'PSR J2016+HRK', starCallout.label)
    starSub = el('span', 'vx-sub', 'P 1.3370 S · DM 41.9', starCallout.label)
  }

  function updateTx(tx: Tx, ph: number, time: number) {
    const vis = Math.min(smoothstep(0, 0.035, ph), 1 - smoothstep(0.86, 0.98, ph))
    reveal(tx.root, vis, -12 * (ph > 0.5 ? 1 : -1))
    tx.shown = vis > 0
    if (!tx.shown) return

    setText(tx.inc, scrambleAt(tx.incText, segment(ph, 0.0, 0.1)))
    setText(tx.src, scrambleAt(tx.srcText, segment(ph, 0.03, 0.15)))
    const telT = segment(ph, 0.06, 0.2)
    const snr = (tx.snr + (telT >= 1 ? Math.sin(time * 3.1) * 0.25 : 0)).toFixed(1)
    const secs = Math.floor(time) % 60
    const mins = Math.floor(time / 60) % 60
    setText(tx.tel, scrambleAt(`FREQ ${tx.freq} MHZ · SNR ${snr} DB · T+00:${pad(mins)}:${pad(secs)}`, telT))
    const ruleK = ease.outCubic(segment(ph, 0.08, 0.26))
    tx.rule.style.transform = `scaleX(${ruleK.toFixed(3)})`
    reveal(tx.mark, segment(ph, 0.16, 0.24), 6)

    // word-by-word decode: a short window of glyph noise sweeps the quote
    const W = 2.6
    const words = tx.words
    const f = segment(ph, 0.2, 0.5) * (words.length + W)
    for (let j = 0; j < words.length; j++) {
      const w = words[j]
      const r = f - j
      const s = r <= 0 ? 0 : r < W ? 1 : 2
      if (s !== w.state) {
        w.state = s
        w.root.dataset.s = String(s)
      }
      if (s === 1) w.noise.textContent = noiseWord(w.len)
    }
    reveal(tx.by, segment(ph, 0.42, 0.52), 8)
  }

  return {
    id: 'voices',
    group,

    init(ctx: ChapterContext) {
      pulsar = new Pulsar(ctx.mobile)
      if (!DBG.includes('np')) group.add(pulsar.group)
      wave = new Waveform(ctx.mobile)
      if (!DBG.includes('nw')) group.add(wave.group)
      buildDom(ctx.stage)
    },

    update(local, frame, ctx) {
      const port = computeLayout(frame)
      const t = frame.time * (ctx.reducedMotion ? 0.4 : 1)
      const x = (local - B0) / SPAN
      const bi = Math.floor(x)
      const ph = x - bi
      const inBeat = bi >= 0 && bi < N
      const outBeat = ease.inCubic(segment(local, 0.93, 1))

      // ---- the signal line
      const drawOn = ease.outCubic(segment(local, 0.0, 0.075))
      const collapse = 1 - ease.inCubic(segment(local, 0.925, 0.985))
      const u = wave.u
      u.uTime.value = t
      u.uExtent.value = Math.max(0.0005, Math.min(drawOn, collapse))
      u.uAmp.value = 0.34 * collapse
      u.uPacket.value = inBeat ? ease.inQuad(segment(ph, 0.0, 0.26)) * 1.04 : -1
      u.uPacketAmp.value = inBeat ? window01(ph, 0.0, 0.3, 0.04) : 0
      u.uVoice.value = inBeat ? window01(ph, 0.28, 0.92, 0.1) : 0
      u.uGlow.value = 1 + (1 - drawOn) * 1.5 + outBeat * 1.2
      wave.setPath(layout.star, layout.p1, layout.p2, layout.p3)
      ctx.renderer.getDrawingBufferSize(res)
      wave.setView(res, ctx.renderer.getPixelRatio(), local * 0.8)
      pulsar.group.position.copy(layout.star)

      // ---- the pulsar
      const emit = inBeat ? Math.exp(-Math.pow(ph / 0.045, 2)) * 1.4 : 0
      const arrival = inBeat ? Math.exp(-Math.pow((ph - 0.25) / 0.022, 2)) : 0
      pulsar.update({
        time: t,
        angle: t * 0.32 + local * 7.5,
        pulse: emit + outBeat * 2.5 + (1 - drawOn) * 1.5,
        intensity: 1,
        beam: 0.26 * collapse,
        ring: segment(local, 0.945, 1),
        camPos: ctx.camera.position,
      })

      // ---- post + sky
      const p = DBG.includes('nq') ? { ...ctx.post.params } : ctx.post.params
      p.glitch = arrival * 0.14 + outBeat * 0.1
      p.flash = arrival * 0.035 + (1 - drawOn) * (1 - drawOn) * 0.08
      p.bloomStrength = 1.0 + arrival * 0.3 + outBeat * 0.7
      p.aberration = 0.0025 + arrival * 0.002 + outBeat * 0.004
      if (!DBG.includes('ns')) {
        ctx.sky.params.hue = -0.35
        ctx.sky.params.nebula = 0.75
        ctx.sky.params.warp = (1 - drawOn) * 0.7 + outBeat * 0.8
      }

      // ---- DOM
      const headVis = window01(local, 0.012, 0.955, 0.03)
      reveal(head, headVis, 0)
      if (headVis > 0) {
        setText(eyebrow, scrambleAt('Client transmissions', segment(local, 0.015, 0.07)))
        const active = inBeat ? bi : local >= B1 ? N : -1
        if (active !== lastMeter) {
          meter.forEach((m, i) => {
            m.classList.toggle('is-on', i === active)
            m.classList.toggle('is-done', i < active)
          })
          lastMeter = active
        }
        const st =
          local < B0 ? 'SCANNING · 1420 MHZ' : inBeat ? `RX ${pad(bi + 1)}/${pad(N)}` : `${pad(N)}/${pad(N)} DECODED`
        setText(status, scrambleAt(st, local < B0 ? segment(local, 0.02, 0.06) : 1))
      }

      for (let i = 0; i < N; i++) {
        const tx = txs[i]
        if (inBeat && i === bi) updateTx(tx, ph, t)
        else if (tx.shown || tx.root.style.visibility !== 'hidden') {
          reveal(tx.root, 0, 0)
          tx.shown = false
        }
      }

      // star label (short on portrait)
      const cam = ctx.camera
      cam.updateMatrixWorld()
      starSub.style.display = port > 0.5 ? 'none' : ''
      starCallout.side = port > 0.5 ? 'left' : 'left'
      starCallout.offset.x = port > 0.5 ? 40 : 76
      starCallout.offset.y = port > 0.5 ? -40 : -58
      starCallout.update(layout.star, cam, frame.width, frame.height, window01(local, 0.05, 0.925, 0.03))
    },

    camera(local, frame, out) {
      computeLayout(frame)
      const inT = ease.outExpo(segment(local, 0, 0.085))
      out.position.set(
        BASE.x + 0.7 * Math.sin(local * Math.PI),
        BASE.y - 0.4 * local,
        BASE.z - 3 * local + (1 - inT) * 26,
      )
      out.target.set(out.position.x * 0.4, out.position.y * 0.4, -100)
      const look = ease.inOutCubic(segment(local, 0.925, 0.99))
      const o = ease.inExpo(segment(local, 0.93, 1))
      if (look > 0) out.target.lerp(layout.star, look)
      if (o > 0) out.position.lerp(layout.star, o * 0.42)
      out.fov = layout.fov + (1 - inT) * 14 + o * 20
      out.roll = -(1 - inT) * 0.16 + o * 0.12
      out.parallax = 0.45 * (1 - look)
    },
  }
}
