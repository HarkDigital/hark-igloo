import * as THREE from 'three'
import Lenis from 'lenis'
import { Post } from './post'
import { Assets } from './assets'
import { Sky } from '../world/Sky'
import { clamp, damp } from './math'
import { buildChapterCopy } from './srContent'
import type { CameraPose, Chapter, ChapterContext, ChapterDef, Frame } from './types'

export interface ChapterSlot {
  def: ChapterDef
  chapter: Chapter
  ctx: ChapterContext
  /** scroll range in viewport heights */
  start: number
  end: number
  section: HTMLElement
  stage: HTMLElement
  failed: boolean
}

export interface EngineState {
  index: number
  local: number
  slots: ChapterSlot[]
  /** total scroll length in viewport heights */
  total: number
}

/** Scroll distance (in vh) on each side of a cut where the glitch ramps. */
const CUT_WINDOW = 0.22
/** Render-pixel budget: 4K/5K windows would otherwise push 15+ MP through bloom. */
const PIXEL_BUDGET = 6e6

/**
 * Yield to the browser between heavy boot steps so the loader can paint.
 * rAF never fires in a hidden/background tab, so there we yield with a
 * macrotask instead (and a timeout guards a tab hidden mid-wait).
 */
const nextFrame = () =>
  new Promise<void>(resolve => {
    let done = false
    const r = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    if (document.hidden) {
      const ch = new MessageChannel()
      ch.port1.onmessage = r
      ch.port2.postMessage(0)
      return
    }
    requestAnimationFrame(r)
    setTimeout(r, 150)
  })

function emptyChapter(id: string): Chapter {
  return {
    id,
    group: new THREE.Group(),
    init() {},
    update() {},
    camera(_l, _f, out) {
      out.position.set(0, 0, 10)
      out.target.set(0, 0, 0)
    },
  }
}

export class Engine {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000)
  post: Post
  sky: Sky
  assets: Assets
  lenis: Lenis
  slots: ChapterSlot[] = []
  state: EngineState = { index: 0, local: 0, slots: this.slots, total: 1 }
  frame: Frame
  pose: CameraPose = {
    position: new THREE.Vector3(0, 0, 10),
    target: new THREE.Vector3(),
    fov: 45,
    roll: 0,
    parallax: 0,
  }
  /** Listeners run after each frame's chapter update (HUD chrome, sound…). */
  onFrame: ((frame: Frame, state: EngineState) => void)[] = []
  onCut: ((from: number, to: number) => void)[] = []

  /** scroll-track viewport height (keyed on innerHeight so mobile URL bars don't relayout) */
  private vh = window.innerHeight
  private vw = window.innerWidth
  /** drawing size = the canvas's CSS box (100lvh on phones, stable while toolbars slide) */
  private cw = 0
  private ch = 0
  private dpr = 0
  private timer = new THREE.Timer()
  private lastScrollVh = 0
  private running = false
  private mobile: boolean
  private reducedMotion: boolean
  /** adaptive resolution: multiplier on the device pixel ratio, lowered when frames run long */
  private dprScale = 1
  private perfEma = 1 / 60
  private cadence: number[] = []
  private baseline = 1 / 60
  private slowFor = 0
  private fastFor = 0
  private perfCooldown = 0
  /** time-driven cut used for long nav jumps (so we never scrub through five chapters) */
  private jump: { t: number; id: string; local: number; swapped: boolean } | null = null
  private tmpRight = new THREE.Vector3()
  private tmpUp = new THREE.Vector3()

  constructor(
    private canvas: HTMLCanvasElement,
    private track: HTMLElement,
    private stages: HTMLElement,
  ) {
    this.mobile = matchMedia('(pointer: coarse)').matches || window.innerWidth < 768
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    })
    this.renderer.setClearColor(0x020304, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.info.autoReset = false
    this.renderer.debug.checkShaderErrors = !import.meta.env.PROD

    this.scene.background = new THREE.Color(0x020304)
    this.sky = new Sky(this.mobile)
    this.scene.add(this.sky.object)
    this.assets = new Assets(this.renderer)
    // MSAA only where it pays: 1x desktop screens. Retina is already supersampled,
    // and multisampled half-float ping-pong targets cost ~1 GB of VRAM there.
    const msaa = !this.mobile && (window.devicePixelRatio || 1) < 1.5
    this.post = new Post(this.renderer, this.scene, this.camera, !msaa)

    this.frame = {
      time: 0,
      dt: 0.016,
      progress: 0,
      velocity: 0,
      pointer: new THREE.Vector2(),
      pointerRaw: new THREE.Vector2(),
      width: this.vw,
      height: this.vh,
      mobile: this.mobile,
      reducedMotion: this.reducedMotion,
    }

    this.lenis = new Lenis({
      autoRaf: false,
      lerp: this.reducedMotion ? 1 : 0.09,
      wheelMultiplier: 0.85,
      touchMultiplier: 1.4,
      smoothWheel: !this.reducedMotion,
    })

    this.resize(true)
    window.addEventListener('resize', () => this.resize())
    const toNdc = (e: PointerEvent) =>
      this.frame.pointerRaw.set((e.clientX / this.cw) * 2 - 1, -(e.clientY / this.ch) * 2 + 1)
    window.addEventListener('pointermove', toNdc)
    window.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement
      if (t.closest('a, button, input, textarea, select, label')) return
      toNdc(e)
      const slot = this.slots[this.state.index]
      slot?.chapter.onPointerDown?.(this.frame, slot.ctx)
    })

    // A lost context takes every baked texture/PMREM with it; a reload is the
    // only honest recovery.
    canvas.addEventListener('webglcontextlost', e => e.preventDefault())
    canvas.addEventListener('webglcontextrestored', () => location.reload())
  }

  /** Is WebGL2 available at all? */
  static supported() {
    try {
      const c = document.createElement('canvas')
      return !!c.getContext('webgl2')
    } catch {
      return false
    }
  }

  /**
   * Import and init every chapter. A chapter that throws is replaced with an
   * empty placeholder so one bad scene can never take the whole site down.
   * Inits run one per frame so the loader keeps animating.
   * `only` (debug) inits a single chapter and stubs the rest.
   */
  async load(defs: ChapterDef[], only?: string | null) {
    let cursor = 0
    for (const def of defs) {
      // the accessible, linear copy of the chapter lives in its scroll section;
      // the stage is the visual layer only
      const section = document.createElement('section')
      section.className = 'chapter'
      section.id = def.id
      section.dataset.chapter = def.id
      const copy = buildChapterCopy(def.id)
      if (copy) {
        section.appendChild(copy)
        const heading = copy.querySelector<HTMLElement>('h1, h2')
        if (heading) {
          heading.id ||= `${def.id}-title`
          section.setAttribute('aria-labelledby', heading.id)
        }
      }
      section.addEventListener('focusin', () => {
        if (this.slots[this.state.index]?.def.id !== def.id) this.land(def.id)
      })
      this.track.appendChild(section)

      const stage = document.createElement('div')
      stage.className = `stage stage-${def.id}`
      stage.dataset.chapter = def.id
      stage.setAttribute('aria-hidden', 'true')
      stage.inert = true
      this.stages.appendChild(stage)

      const ctx: ChapterContext = {
        renderer: this.renderer,
        camera: this.camera,
        sky: this.sky,
        post: this.post,
        assets: this.assets,
        stage,
        mobile: this.mobile,
        reducedMotion: this.reducedMotion,
      }
      const slot: ChapterSlot = {
        def,
        chapter: emptyChapter(def.id),
        ctx,
        start: cursor,
        end: cursor + def.length,
        section,
        stage,
        failed: false,
      }
      cursor += def.length
      this.slots.push(slot)
    }
    // one extra viewport so the last chapter can reach local = 1
    const tail = document.createElement('div')
    tail.className = 'track-tail'
    this.track.appendChild(tail)
    this.state.total = cursor
    this.layoutTrack()

    const active = this.slots.filter(s => !only || s.def.id === only)
    const modules = active.map(s => this.assets.track(s.def.load()).catch(err => err as Error))
    for (let i = 0; i < active.length; i++) {
      const slot = active[i]
      try {
        const mod = await modules[i]
        if (mod instanceof Error) throw mod
        slot.chapter = mod.default()
        await this.assets.track(Promise.resolve(slot.chapter.init(slot.ctx)))
      } catch (err) {
        console.error(`[hark] chapter "${slot.def.id}" failed to load`, err)
        slot.failed = true
        slot.chapter = emptyChapter(slot.def.id)
        slot.stage.replaceChildren()
      }
      slot.chapter.group.visible = false
      this.scene.add(slot.chapter.group)
      this.keyboardViaCopyLayer(slot.stage)
      await nextFrame()
    }
    for (const slot of this.slots) if (!slot.chapter.group.parent) this.scene.add(slot.chapter.group)

    await this.prewarm()
  }

  /**
   * Stages are aria-hidden visuals; keyboard and screen-reader users drive the
   * story through the linear copy in #track instead. Keep stage controls out
   * of the tab order (mouse/touch still work), including ones added later.
   */
  private keyboardViaCopyLayer(stage: HTMLElement) {
    const sweep = () =>
      stage
        .querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
        .forEach(el => {
          if (el.tabIndex !== -1) el.tabIndex = -1
        })
    sweep()
    new MutationObserver(sweep).observe(stage, { childList: true, subtree: true })
  }

  /**
   * Compile shaders against the REAL render target (HDR, linear, no tone
   * mapping) in parallel, then render each chapter at a few points so lazily
   * built materials, geometry and textures upload before the reveal.
   */
  private async prewarm() {
    for (const slot of this.slots) {
      try {
        slot.chapter.update(0.5, this.frame, slot.ctx)
      } catch {
        /* reported below */
      }
      slot.chapter.group.visible = true
    }
    this.renderer.setRenderTarget(this.post.composer.renderTarget1)
    try {
      await this.renderer.compileAsync(this.scene, this.camera)
    } catch {
      /* best-effort */
    }
    for (const slot of this.slots) slot.chapter.group.visible = false

    const rt = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType })
    for (const slot of this.slots) {
      try {
        slot.chapter.group.visible = true
        for (const l of [0.04, 0.92, 0.5]) {
          slot.chapter.update(l, this.frame, slot.ctx)
          slot.chapter.camera(l, this.frame, this.pose)
          this.applyCamera(0)
          this.renderer.setRenderTarget(rt)
          this.renderer.render(this.scene, this.camera)
        }
      } catch (err) {
        console.error(`[hark] chapter "${slot.def.id}" failed during prewarm`, err)
      } finally {
        slot.chapter.group.visible = false
      }
      await nextFrame()
    }
    this.renderer.setRenderTarget(null)
    rt.dispose()
    // one full pass through the composer so its passes compile too
    this.post.render(0.016, 0)
  }

  private layoutTrack() {
    for (const slot of this.slots) slot.section.style.height = `${slot.def.length * this.vh}px`
    const tail = this.track.querySelector<HTMLElement>('.track-tail')
    if (tail) tail.style.height = `${this.vh}px`
  }

  private resize(force = false) {
    const iw = window.innerWidth
    const ih = window.innerHeight
    // mobile URL bars change innerHeight constantly; only relayout the scroll
    // track on real changes so the page doesn't jump
    if (force || iw !== this.vw || Math.abs(ih - this.vh) > this.vh * 0.25) {
      this.vw = iw
      this.vh = ih
      this.layoutTrack()
      this.lenis?.resize()
    }

    const w = this.canvas.clientWidth || iw
    const h = this.canvas.clientHeight || ih
    const base = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2)
    const budget = Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h))
    const dpr = Math.max(this.mobile ? 1 : 0.75, Math.min(base, budget) * this.dprScale)
    if (!force && w === this.cw && h === this.ch && Math.abs(dpr - this.dpr) < 1e-3) return
    this.cw = w
    this.ch = h
    this.dpr = dpr
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h, dpr)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.frame.width = w
    this.frame.height = h
  }

  /** Where a nav jump should land inside a chapter: just past its cut, on settled copy. */
  landingFor(id: string) {
    const slot = this.slots.find(s => s.def.id === id)
    if (!slot) return 0
    return slot.def.landing ?? Math.min(0.2, Math.max(0.06, 0.34 / slot.def.length))
  }

  /**
   * Navigate to a chapter the way a visitor should see it. Neighbours scroll
   * smoothly; longer jumps cut (flash out, jump, flash in) instead of scrubbing
   * through every chapter in between.
   */
  land(id: string, smooth = true) {
    const target = this.slots.findIndex(s => s.def.id === id)
    if (target < 0) return
    const local = this.landingFor(id)
    if (!smooth) return this.gotoChapter(id, local)
    if (Math.abs(target - this.state.index) <= 1) return this.gotoChapter(id, local, true)
    this.jump = { t: 0, id, local, swapped: false }
  }

  /** Jump to global progress 0..1 (no smoothing). */
  goto(p: number) {
    this.jump = null
    const y = clamp(p) * this.state.total * this.vh
    this.lenis.scrollTo(y, { immediate: true, force: true })
  }

  /** Jump into a chapter at an exact local progress 0..1. */
  gotoChapter(id: string, local = 0, smooth = false) {
    const slot = this.slots.find(s => s.def.id === id)
    if (!slot) return
    if (!smooth) this.jump = null
    const y = (slot.start + clamp(local) * slot.def.length) * this.vh + 1
    this.lenis.scrollTo(y, smooth ? { duration: 1.8, force: true } : { immediate: true, force: true })
  }

  start() {
    if (this.running) return
    this.running = true
    const loop = (ms: number) => {
      if (!this.running) return
      this.timer.update(ms)
      this.lenis.raf(ms)
      this.tick()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  /**
   * Keep the frame rate up on weaker GPUs: drop the render resolution in
   * steps while frames run long relative to the display's own cadence (so a
   * 30 fps Low Power Mode cap is not mistaken for a slow GPU), and creep back
   * up once there's headroom.
   */
  private adaptResolution(raw: number, dt: number) {
    if (document.hidden || this.frame.time < 4 || this.jump) return
    this.cadence.push(raw)
    if (this.cadence.length > 120) this.cadence.shift()
    if (this.cadence.length >= 60 && this.cadence.length % 20 === 0) {
      const sorted = [...this.cadence].sort((a, b) => a - b)
      this.baseline = Math.max(1 / 144, sorted[Math.floor(sorted.length * 0.1)])
    }
    this.perfEma += (raw - this.perfEma) * 0.05
    this.perfCooldown -= dt
    const slow = this.perfEma > Math.max(this.baseline * 1.35, 1 / 50)
    this.slowFor = slow ? this.slowFor + dt : 0
    this.fastFor = this.perfEma < this.baseline * 1.08 ? this.fastFor + dt : 0
    if (this.slowFor > 1.5 && this.dprScale > 0.5) {
      this.dprScale = Math.max(0.5, this.dprScale - 0.15)
      this.slowFor = 0
      this.perfCooldown = 6
      this.resize()
    } else if (this.fastFor > 8 && this.dprScale < 1 && this.perfCooldown <= 0) {
      this.dprScale = Math.min(1, this.dprScale + 0.1)
      this.fastFor = 0
      this.resize()
    }
  }

  private applyCamera(parallax: number) {
    const cam = this.camera
    const pose = this.pose
    cam.position.copy(pose.position)
    cam.up.set(0, 1, 0)
    cam.lookAt(pose.target)
    if (parallax) {
      this.tmpRight.setFromMatrixColumn(cam.matrixWorld, 0)
      this.tmpUp.setFromMatrixColumn(cam.matrixWorld, 1)
      cam.position
        .addScaledVector(this.tmpRight, this.frame.pointer.x * parallax)
        .addScaledVector(this.tmpUp, this.frame.pointer.y * parallax * 0.6)
      cam.lookAt(pose.target)
    }
    if (pose.roll) cam.rotateZ(pose.roll)
    if (cam.fov !== pose.fov) {
      cam.fov = pose.fov
      cam.updateProjectionMatrix()
    }
  }

  /** 0..1 strength of a time-driven cut in progress (long nav jumps). */
  private jumpFx(dt: number) {
    const j = this.jump
    if (!j) return 0
    const IN = 0.26
    const OUT = 0.5
    j.t += dt
    if (j.t < IN) {
      const x = j.t / IN
      return x * x
    }
    if (!j.swapped) {
      j.swapped = true
      const slot = this.slots.find(s => s.def.id === j.id)
      if (slot) {
        const y = (slot.start + j.local * slot.def.length) * this.vh + 1
        this.lenis.scrollTo(y, { immediate: true, force: true })
      }
    }
    const out = clamp((j.t - IN) / OUT)
    if (out >= 1) this.jump = null
    return 1 - out * out * (3 - 2 * out)
  }

  private tick() {
    const f = this.frame
    const raw = Math.max(this.timer.getDelta(), 0)
    f.dt = Math.min(raw, 1 / 20)
    f.time += f.dt
    this.adaptResolution(Math.min(raw, 0.1), f.dt)
    f.pointer.x = damp(f.pointer.x, f.pointerRaw.x, 3.5, f.dt)
    f.pointer.y = damp(f.pointer.y, f.pointerRaw.y, 3.5, f.dt)

    const fx = this.jumpFx(f.dt)

    const scrollVh = this.lenis.scroll / this.vh
    const vel = (scrollVh - this.lastScrollVh) / Math.max(f.dt, 1e-3)
    this.lastScrollVh = scrollVh
    // a nav jump teleports the scroll; don't let it register as warp speed
    f.velocity = this.jump ? damp(f.velocity, 0, 8, f.dt) : damp(f.velocity, vel, 8, f.dt)
    f.progress = clamp(scrollVh / this.state.total)

    // which chapter owns this scroll position?
    let index = this.slots.length - 1
    for (let i = 0; i < this.slots.length; i++) {
      if (scrollVh < this.slots[i].end) {
        index = i
        break
      }
    }
    const slot = this.slots[index]
    if (!slot) return
    const local = clamp((scrollVh - slot.start) / slot.def.length)

    // glitch ramps up approaching any internal cut and back down after it
    let d = Infinity
    for (let i = 1; i < this.slots.length; i++) d = Math.min(d, Math.abs(scrollVh - this.slots[i].start))
    const tr = clamp(1 - d / CUT_WINDOW)
    const cut = Math.max(tr * tr * (3 - 2 * tr), fx)
    if (this.reducedMotion) {
      // no flashes, tearing or zoom blur: a quiet dip to black instead
      this.post.transition = 0
      this.post.fade = cut * 0.85
    } else {
      this.post.transition = cut
      this.post.fade = 0
    }

    if (index !== this.state.index || !slot.chapter.group.visible) {
      const prev = this.slots[this.state.index]
      if (prev && prev !== slot) {
        prev.chapter.group.visible = false
        prev.stage.classList.remove('is-active')
        prev.stage.inert = true
        prev.chapter.onLeave?.(prev.ctx)
      }
      slot.chapter.group.visible = true
      slot.stage.classList.add('is-active')
      slot.stage.inert = false
      slot.chapter.onEnter?.(slot.ctx)
      const from = this.state.index
      this.state.index = index
      document.documentElement.dataset.chapter = slot.def.id
      if (from !== index) {
        const url = index === 0 ? location.pathname + location.search : `#${slot.def.id}`
        try {
          history.replaceState(null, '', url)
        } catch {
          /* sandboxed */
        }
        for (const fn of this.onCut) fn(from, index)
      }
    }
    this.state.local = local

    this.post.resetParams()
    this.sky.resetParams()
    this.pose.parallax = 0
    this.pose.roll = 0
    try {
      slot.chapter.update(local, f, slot.ctx)
      slot.chapter.camera(local, f, this.pose)
    } catch (err) {
      if (!slot.failed) console.error(`[hark] chapter "${slot.def.id}" crashed in update`, err)
      slot.failed = true
    }
    if (this.reducedMotion) {
      this.post.params.flash = Math.min(this.post.params.flash, 0.08)
      this.post.params.glitch = 0
    }
    this.applyCamera(this.reducedMotion ? 0 : this.pose.parallax)
    this.sky.update(f, this.camera)

    for (const fn of this.onFrame) fn(f, this.state)
    this.renderer.info.reset()
    this.post.render(f.dt, f.time)
  }
}
