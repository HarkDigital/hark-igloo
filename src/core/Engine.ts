import * as THREE from 'three'
import Lenis from 'lenis'
import { Post } from './post'
import { Assets } from './assets'
import { Sky } from '../world/Sky'
import { clamp, damp } from './math'
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

/** Seconds of scroll distance (in vh) on each side of a cut where the glitch ramps. */
const CUT_WINDOW = 0.22

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

  private vh = window.innerHeight
  private vw = window.innerWidth
  private timer = new THREE.Timer()
  private lastScrollVh = 0
  private running = false
  private mobile: boolean
  private reducedMotion: boolean
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

    this.scene.background = new THREE.Color(0x020304)
    this.sky = new Sky(this.mobile)
    this.scene.add(this.sky.object)
    this.assets = new Assets(this.renderer)
    this.post = new Post(this.renderer, this.scene, this.camera, this.mobile)

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
    window.addEventListener('pointermove', e => {
      this.frame.pointerRaw.set((e.clientX / this.vw) * 2 - 1, -(e.clientY / this.vh) * 2 + 1)
    })
    window.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement
      if (t.closest('a, button, input, textarea, select, label')) return
      this.frame.pointerRaw.set((e.clientX / this.vw) * 2 - 1, -(e.clientY / this.vh) * 2 + 1)
      const slot = this.slots[this.state.index]
      slot?.chapter.onPointerDown?.(this.frame, slot.ctx)
    })
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
   * `only` (debug) inits a single chapter and stubs the rest.
   */
  async load(defs: ChapterDef[], only?: string | null) {
    let cursor = 0
    for (const def of defs) {
      const section = document.createElement('section')
      section.className = 'chapter'
      section.id = def.id
      section.dataset.chapter = def.id
      section.setAttribute('aria-label', def.label)
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

    await Promise.all(
      this.slots.map(async slot => {
        if (only && slot.def.id !== only) return
        try {
          const mod = await this.assets.track(slot.def.load())
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
      }),
    )

    await this.prewarm()
  }

  /** Compile shaders and upload textures for every chapter before the reveal. */
  private async prewarm() {
    const rt = new THREE.WebGLRenderTarget(64, 64)
    for (const slot of this.slots) {
      try {
        slot.chapter.group.visible = true
        slot.chapter.update(0.5, this.frame, slot.ctx)
        slot.chapter.camera(0.5, this.frame, this.pose)
        this.applyCamera(0)
        this.renderer.setRenderTarget(rt)
        this.renderer.render(this.scene, this.camera)
      } catch (err) {
        console.error(`[hark] chapter "${slot.def.id}" failed during prewarm`, err)
      } finally {
        slot.chapter.group.visible = false
      }
    }
    this.renderer.setRenderTarget(null)
    rt.dispose()
    try {
      await this.renderer.compileAsync(this.scene, this.camera)
    } catch {
      /* compileAsync is best-effort */
    }
  }

  private layoutTrack() {
    for (const slot of this.slots) slot.section.style.height = `${slot.def.length * this.vh}px`
    const tail = this.track.querySelector<HTMLElement>('.track-tail')
    if (tail) tail.style.height = `${this.vh}px`
  }

  private resize(force = false) {
    const w = window.innerWidth
    const h = window.innerHeight
    // mobile URL bars change innerHeight constantly; only relayout the scroll
    // track on real changes so the page doesn't jump
    const relayout = force || w !== this.vw || Math.abs(h - this.vh) > this.vh * 0.25
    this.vw = w
    const dpr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h, dpr)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.frame.width = w
    this.frame.height = h
    if (relayout) {
      this.vh = h
      this.layoutTrack()
      this.lenis?.resize()
    }
  }

  /** Jump to global progress 0..1 (no smoothing). */
  goto(p: number) {
    const y = clamp(p) * this.state.total * this.vh
    this.lenis.scrollTo(y, { immediate: true, force: true })
  }

  /** Jump into a chapter at local progress 0..1. */
  gotoChapter(id: string, local = 0, smooth = false) {
    const slot = this.slots.find(s => s.def.id === id)
    if (!slot) return
    const y = (slot.start + clamp(local) * slot.def.length) * this.vh + 1
    this.lenis.scrollTo(y, smooth ? { duration: 2.2, force: true } : { immediate: true, force: true })
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

  private tick() {
    const f = this.frame
    f.dt = Math.min(Math.max(this.timer.getDelta(), 0), 1 / 20)
    f.time += f.dt
    f.pointer.x = damp(f.pointer.x, f.pointerRaw.x, 3.5, f.dt)
    f.pointer.y = damp(f.pointer.y, f.pointerRaw.y, 3.5, f.dt)

    const scrollVh = this.lenis.scroll / this.vh
    const vel = (scrollVh - this.lastScrollVh) / Math.max(f.dt, 1e-3)
    this.lastScrollVh = scrollVh
    f.velocity = damp(f.velocity, vel, 8, f.dt)
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
    this.post.transition = tr * tr * (3 - 2 * tr)

    if (index !== this.state.index || !slot.chapter.group.visible) {
      const prev = this.slots[this.state.index]
      if (prev && prev !== slot) {
        prev.chapter.group.visible = false
        prev.stage.classList.remove('is-active')
        prev.stage.setAttribute('aria-hidden', 'true')
        prev.stage.inert = true
        prev.chapter.onLeave?.(prev.ctx)
      }
      slot.chapter.group.visible = true
      slot.stage.classList.add('is-active')
      slot.stage.removeAttribute('aria-hidden')
      slot.stage.inert = false
      slot.chapter.onEnter?.(slot.ctx)
      const from = this.state.index
      this.state.index = index
      document.documentElement.dataset.chapter = slot.def.id
      if (from !== index) for (const fn of this.onCut) fn(from, index)
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
    this.applyCamera(this.reducedMotion ? 0 : this.pose.parallax)
    this.sky.update(f, this.camera)

    for (const fn of this.onFrame) fn(f, this.state)
    this.renderer.info.reset()
    this.post.render(f.dt, f.time)
  }
}
