import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'

/*
 * Generative ambient score — WebAudio only, no files.
 *
 *   pad      6 voices x 2 detuned oscillators → lowpass (slow LFO) → dry + reverb
 *            the chord glides to a new voicing on every chapter
 *   shimmer  sparse high sine notes from the current chord → ping-pong delay → reverb
 *   rumble   brown noise → lowpass that opens with |scroll velocity|
 *   swell    band-passed noise that rises as you scroll toward a chapter cut
 *   cut()    low sub hit + noise slam exactly on the boundary
 *   blip()   faint UI blips for nav hover
 *
 * Off by default. Audio only ever starts from a user gesture; a remembered
 * "on" preference waits for the first click / tap / key before starting.
 * Muted while the tab is hidden.
 */

const STORE_KEY = 'hark:sound'
const MASTER_LEVEL = 0.78

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

/** Chord voicings (MIDI) per chapter id. A-minor modal world, resolves to A major. */
const CHORDS: Record<string, number[]> = {
  hero: [45, 52, 55, 59, 60, 64], // Am9
  services: [41, 48, 52, 57, 59, 64], // Fmaj7#11
  shield: [38, 45, 48, 52, 53, 57], // Dm9 (darker)
  work: [36, 43, 47, 50, 52, 55], // Cmaj9
  voices: [40, 47, 50, 55, 57, 62], // Em11
  portal: [42, 48, 52, 57, 60, 63], // F#ø + tension
  contact: [45, 52, 56, 59, 61, 64], // Amaj9 — arrival
}
const DEFAULT_CHORD = CHORDS.hero

/** Pentatonic-ish offsets for shimmer notes above the chord root. */
const SHIMMER = [24, 27, 31, 34, 36, 39, 43]

interface Voice {
  a: OscillatorNode
  b: OscillatorNode
  gain: GainNode
}

function noiseBuffer(ctx: AudioContext, seconds: number, brown: boolean) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let last = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      if (brown) {
        last = (last + 0.02 * w) / 1.02
        d[i] = last * 3.5
      } else d[i] = w
    }
    // crossfade the loop seam
    const fade = Math.min(2048, len >> 3)
    for (let i = 0; i < fade; i++) {
      const t = i / fade
      d[i] = d[i] * t + d[len - fade + i] * (1 - t)
    }
  }
  return buf
}

/** Procedural stereo impulse response: darkened, exponentially decaying noise. */
function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / len
      const w = Math.random() * 2 - 1
      // high end dies faster than the low end
      const k = 0.18 + 0.7 * t
      lp += (w - lp) * (1 - k)
      d[i] = lp * Math.pow(1 - t, decay) * (i < 64 ? i / 64 : 1)
    }
  }
  return buf
}

/**
 * iOS routes Web Audio through the "ambient" session, which the ring/silent
 * switch mutes. Safari 16.4+ lets a page opt into "playback" (plays with the
 * switch on, like a video would); hand it back to "auto" when muted so we
 * never hold the session for nothing. Feature-detected; a no-op elsewhere.
 */
function setAudioSession(type: 'playback' | 'auto') {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session && session.type !== type) session.type = type
  } catch {
    /* unsupported type / locked down */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private padFilter!: BiquadFilterNode
  private padLfo!: OscillatorNode
  private voices: Voice[] = []
  private reverbIn!: GainNode
  private delayIn!: GainNode
  private rumbleFilter!: BiquadFilterNode
  private rumbleGain!: GainNode
  private swellFilter!: BiquadFilterNode
  private swellGain!: GainNode
  private white!: AudioBuffer
  private chordId = ''
  private lastHit = 0
  private lastBlip = 0
  private shimmerTimer = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  private mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  /** a remembered "on" preference waiting for the first user gesture */
  private armed = false
  private gestureBound = false

  constructor() {
    try {
      this.armed = localStorage.getItem(STORE_KEY) === '1'
    } catch {
      /* storage blocked — stay off */
    }
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
  }

  /** Flip sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
  }

  /** Faint UI blip (nav hover). No-op while sound is off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.06) return
    this.lastBlip = now
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = hz(88 + ([0, 3, 7, 10, 12][pitch % 5] ?? 0))
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.035, now + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)
    o.connect(g)
    g.connect(this.master)
    g.connect(this.delayIn)
    o.start(now)
    o.stop(now + 0.2)
  }

  /** called every frame */
  update(frame: Frame, state: EngineState) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const slot = state.slots[state.index]
    if (slot && slot.def.id !== this.chordId) this.setChord(slot.def.id, 1.6)

    const v = Math.min(1, Math.abs(frame.velocity) / 2.2)
    // sub rumble opens with scroll speed
    this.rumbleFilter.frequency.setTargetAtTime(48 + v * v * 420, now, 0.08)
    this.rumbleGain.gain.setTargetAtTime(0.16 + v * 0.55, now, 0.12)

    // pad brightens gently through the story and with motion
    this.padFilter.frequency.setTargetAtTime(420 + frame.progress * 520 + v * 380, now, 0.4)

    // swell toward the nearest chapter boundary (wider than the visual cut window)
    if (slot) {
      const pos = slot.start + state.local * slot.def.length
      let d = Infinity
      for (let i = 1; i < state.slots.length; i++) d = Math.min(d, Math.abs(pos - state.slots[i].start))
      const prox = Math.max(0, 1 - d / 0.7)
      const p2 = prox * prox
      const motion = Math.min(1, Math.abs(frame.velocity) / 1.2)
      this.swellGain.gain.setTargetAtTime(p2 * motion * 0.22, now, 0.05)
      this.swellFilter.frequency.setTargetAtTime(260 + p2 * 3200, now, 0.05)
    }
  }

  /** called when the story cuts from chapter `from` to `to` */
  cut(from: number, to: number) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const since = now - this.lastHit
    if (since < 0.28) return
    this.lastHit = now
    // rapid successive cuts (nav jumps) get quieter
    const level = since < 1.2 ? 0.55 : 1

    // sub hit: pitch-dropping sine
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(to > from ? 96 : 82, now)
    o.frequency.exponentialRampToValueAtTime(36, now + 0.55)
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.62 * level, now + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6)
    o.connect(g)
    g.connect(this.master)
    o.start(now)
    o.stop(now + 1.7)

    // noise slam through a sweeping bandpass, panned across the field
    const n = ctx.createBufferSource()
    n.buffer = this.white
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.9
    const up = to > from
    bp.frequency.setValueAtTime(up ? 2400 : 900, now)
    bp.frequency.exponentialRampToValueAtTime(up ? 180 : 3200, now + 0.9)
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0, now)
    ng.gain.linearRampToValueAtTime(0.3 * level, now + 0.02)
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 1.0)
    const pan = ctx.createStereoPanner()
    pan.pan.setValueAtTime(up ? -0.5 : 0.5, now)
    pan.pan.linearRampToValueAtTime(up ? 0.5 : -0.5, now + 0.9)
    n.connect(bp)
    bp.connect(ng)
    ng.connect(pan)
    pan.connect(this.master)
    pan.connect(this.reverbIn)
    n.start(now, Math.random() * 1.5)
    n.stop(now + 1.1)
  }

  // ------------------------------------------------------------------ internals

  /** The running context, or null when sound is off / suspended / hidden. */
  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    try {
      localStorage.setItem(STORE_KEY, on ? '1' : '0')
    } catch {
      /* ignore */
    }
    setAudioSession(on ? 'playback' : 'auto')
    if (on) this.ensureGraph()
    this.applyRunning()
    for (const fn of this.onChange) fn(on)
  }

  /** Resume + fade in, or fade out + suspend, based on enabled/hidden. */
  private applyRunning() {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      const p = ctx.resume()
      p.then(() => {
        // toggled off / hidden again while resume() was pending
        if (!this.enabled || this.hidden) return
        if (ctx.state !== 'running') this.waitForGesture()
        const t = ctx.currentTime
        this.master.gain.cancelScheduledValues(t)
        this.master.gain.setValueAtTime(this.master.gain.value, t)
        this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.9)
        this.scheduleShimmer()
      }).catch(() => this.waitForGesture())
    } else {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.08 : 0.35)
      window.clearTimeout(this.shimmerTimer)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 400 : 1800,
      )
    }
  }

  /** Start audio on the first real gesture (remembered preference / blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    const events = ['pointerdown', 'keydown', 'touchend'] as const
    const handler = (e: Event) => {
      if (e instanceof KeyboardEvent && (e.key === 'Escape' || e.metaKey || e.ctrlKey)) return
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click will switch it on
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, true)
  }

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx
    const now = ctx.currentTime

    // master → gentle glue compression → out
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 26
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.knee.value = 18
    comp.ratio.value = 3
    comp.attack.value = 0.02
    comp.release.value = 0.4
    this.master.connect(hp)
    hp.connect(comp)
    comp.connect(ctx.destination)

    // reverb: generated impulse response
    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, this.mobile ? 3.2 : 5.2, 2.6)
    this.reverbIn = ctx.createGain()
    this.reverbIn.gain.value = 1
    const verbOut = ctx.createGain()
    verbOut.gain.value = 0.62
    this.reverbIn.connect(verb)
    verb.connect(verbOut)
    verbOut.connect(this.master)

    // ping-pong feedback delay (feeds the reverb too)
    this.delayIn = ctx.createGain()
    const dl = ctx.createDelay(2)
    const dr = ctx.createDelay(2)
    dl.delayTime.value = 0.43
    dr.delayTime.value = 0.61
    const fb = ctx.createGain()
    fb.gain.value = 0.42
    const dlp = ctx.createBiquadFilter()
    dlp.type = 'lowpass'
    dlp.frequency.value = 2600
    const merger = ctx.createChannelMerger(2)
    this.delayIn.connect(dl)
    dl.connect(dr)
    dr.connect(dlp)
    dlp.connect(fb)
    fb.connect(dl)
    dl.connect(merger, 0, 0)
    dr.connect(merger, 0, 1)
    const delayOut = ctx.createGain()
    delayOut.gain.value = 0.5
    merger.connect(delayOut)
    delayOut.connect(this.master)
    delayOut.connect(this.reverbIn)

    // pad
    this.padFilter = ctx.createBiquadFilter()
    this.padFilter.type = 'lowpass'
    this.padFilter.frequency.value = 480
    this.padFilter.Q.value = 0.9
    this.padLfo = ctx.createOscillator()
    this.padLfo.frequency.value = 0.043
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 260
    this.padLfo.connect(lfoDepth)
    lfoDepth.connect(this.padFilter.frequency)
    this.padLfo.start(now)
    const padOut = ctx.createGain()
    padOut.gain.value = 0.5
    this.padFilter.connect(padOut)
    padOut.connect(this.master)
    const padSend = ctx.createGain()
    padSend.gain.value = 0.85
    padOut.connect(padSend)
    padSend.connect(this.reverbIn)

    const chord = DEFAULT_CHORD
    chord.forEach((m, i) => {
      const a = ctx.createOscillator()
      const b = ctx.createOscillator()
      a.type = 'sawtooth'
      b.type = i < 2 ? 'triangle' : 'sawtooth'
      a.frequency.value = b.frequency.value = hz(m)
      a.detune.value = -7 - i * 0.8
      b.detune.value = 6 + i * 1.1
      const gain = ctx.createGain()
      // low voices carry, upper voices breathe
      const base = i < 2 ? 0.075 : 0.042
      gain.gain.value = base
      // slow independent amplitude drift → evolving texture
      const drift = ctx.createOscillator()
      drift.frequency.value = 0.021 + i * 0.013
      const driftDepth = ctx.createGain()
      driftDepth.gain.value = base * 0.65
      drift.connect(driftDepth)
      driftDepth.connect(gain.gain)
      drift.start(now + i * 0.7)
      const pan = ctx.createStereoPanner()
      pan.pan.value = (i % 2 ? 1 : -1) * (0.15 + i * 0.09)
      a.connect(gain)
      b.connect(gain)
      gain.connect(pan)
      pan.connect(this.padFilter)
      a.start(now)
      b.start(now)
      this.voices.push({ a, b, gain })
    })
    this.chordId = 'hero'

    // rumble: looping brown noise through a velocity-driven lowpass
    const brown = ctx.createBufferSource()
    brown.buffer = noiseBuffer(ctx, 4, true)
    brown.loop = true
    this.rumbleFilter = ctx.createBiquadFilter()
    this.rumbleFilter.type = 'lowpass'
    this.rumbleFilter.frequency.value = 60
    this.rumbleFilter.Q.value = 0.6
    this.rumbleGain = ctx.createGain()
    this.rumbleGain.gain.value = 0.16
    brown.connect(this.rumbleFilter)
    this.rumbleFilter.connect(this.rumbleGain)
    this.rumbleGain.connect(this.master)
    brown.start(now)

    // swell: white noise band that rises into chapter cuts
    this.white = noiseBuffer(ctx, 3, false)
    const wn = ctx.createBufferSource()
    wn.buffer = this.white
    wn.loop = true
    this.swellFilter = ctx.createBiquadFilter()
    this.swellFilter.type = 'bandpass'
    this.swellFilter.Q.value = 1.4
    this.swellFilter.frequency.value = 300
    this.swellGain = ctx.createGain()
    this.swellGain.gain.value = 0
    wn.connect(this.swellFilter)
    this.swellFilter.connect(this.swellGain)
    this.swellGain.connect(this.master)
    this.swellGain.connect(this.reverbIn)
    wn.start(now)
  }

  private setChord(id: string, glide: number) {
    const ctx = this.ctx
    if (!ctx) return
    this.chordId = id
    const chord = CHORDS[id] ?? DEFAULT_CHORD
    const now = ctx.currentTime
    this.voices.forEach((v, i) => {
      const f = hz(chord[i % chord.length])
      // stagger voices so the change blooms instead of snapping
      const t = now + i * 0.12
      v.a.frequency.setTargetAtTime(f, t, glide * 0.5)
      v.b.frequency.setTargetAtTime(f, t, glide * 0.55)
    })
  }

  /** Sparse high notes from the current chord, each through delay + reverb. */
  private scheduleShimmer() {
    window.clearTimeout(this.shimmerTimer)
    const next = () => {
      const ctx = this.live()
      if (!ctx) return
      const chord = CHORDS[this.chordId] ?? DEFAULT_CHORD
      const note = chord[0] + SHIMMER[(Math.random() * SHIMMER.length) | 0]
      const now = ctx.currentTime
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = hz(note)
      const peak = 0.018 + Math.random() * 0.014
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(peak, now + 0.9)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 5.5)
      const pan = ctx.createStereoPanner()
      pan.pan.value = Math.random() * 1.4 - 0.7
      o.connect(g)
      g.connect(pan)
      pan.connect(this.master)
      pan.connect(this.delayIn)
      pan.connect(this.reverbIn)
      o.start(now)
      o.stop(now + 5.6)
      this.shimmerTimer = window.setTimeout(next, 2600 + Math.random() * 4200)
    }
    this.shimmerTimer = window.setTimeout(next, 1800)
  }
}
