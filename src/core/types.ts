import type * as THREE from 'three'
import type { Post } from './post'
import type { Assets } from './assets'
import type { Sky } from '../world/Sky'

/** Per-frame state handed to every update. */
export interface Frame {
  /** seconds since the experience started */
  time: number
  /** clamped frame delta in seconds */
  dt: number
  /** smoothed global scroll progress, 0..1 across the whole experience */
  progress: number
  /** smoothed scroll velocity in viewport-heights per second (signed) */
  velocity: number
  /** smoothed pointer, -1..1 (x right, y up) — use for parallax */
  pointer: THREE.Vector2
  /** raw pointer, -1..1 — use for raycasting / hover */
  pointerRaw: THREE.Vector2
  width: number
  height: number
  /** true on narrow / touch devices — fewer particles, simpler shaders */
  mobile: boolean
  /** true when the user prefers reduced motion — calm idle animation */
  reducedMotion: boolean
}

/** Camera pose a chapter writes each frame. The engine adds pointer parallax. */
export interface CameraPose {
  position: THREE.Vector3
  target: THREE.Vector3
  /** vertical field of view in degrees */
  fov: number
  /** roll around the view axis, radians */
  roll: number
  /** how much pointer parallax to apply (world units at the camera). 0 = none */
  parallax: number
}

/** Everything a chapter may touch. */
export interface ChapterContext {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  /** Shared always-on space backdrop (nebula + stars). Chapters may tweak its uniforms. */
  sky: Sky
  post: Post
  assets: Assets
  /** The chapter's own fixed, full-screen DOM overlay. Put all HUD copy here. */
  stage: HTMLElement
  mobile: boolean
  reducedMotion: boolean
}

/**
 * A chapter is one "scene" of the scroll story. Only the active chapter's
 * group is visible; the engine hides the cut between chapters with a
 * glitch/flash transition in post. Keep the first and last ~4% of local
 * progress visually "busy" (camera moving fast, bright) so the cut reads as
 * intentional.
 */
export interface Chapter {
  id: string
  /** 3D content. Added to the scene by the engine; visible only while active. */
  group: THREE.Group
  /** Build geometry/materials/DOM. May await textures. */
  init(ctx: ChapterContext): Promise<void> | void
  /**
   * Called every frame while active. `local` is 0..1 progress through this
   * chapter's scroll range.
   */
  update(local: number, frame: Frame, ctx: ChapterContext): void
  /** Write the camera pose for this local progress. */
  camera(local: number, frame: Frame, out: CameraPose): void
  onEnter?(ctx: ChapterContext): void
  onLeave?(ctx: ChapterContext): void
  /** Optional hover/click raycast hooks (pointer in NDC). */
  onPointerDown?(frame: Frame, ctx: ChapterContext): void
}

/** A chapter module default-exports a factory. */
export type ChapterFactory = () => Chapter

export interface ChapterDef {
  id: string
  /** Short HUD label, e.g. "Signal" */
  label: string
  /** Scroll length in viewport heights */
  length: number
  load: () => Promise<{ default: ChapterFactory }>
}
