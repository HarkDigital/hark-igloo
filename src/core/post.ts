import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/**
 * Final display-space pass: chromatic aberration, chapter-cut glitch,
 * radial zoom blur, flash, vignette, film grain, faint scanlines.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** 0..1, peaks at a chapter cut (engine-driven) */
    uTransition: { value: 0 },
    /** 0..1, extra glitch a chapter can add */
    uGlitch: { value: 0 },
    /** baseline chromatic aberration (UV units at the corners) */
    uAberration: { value: 0.0025 },
    uGrain: { value: 0.06 },
    uVignette: { value: 0.55 },
    /** additive white-green flash */
    uFlash: { value: 0 },
    /** 0..1 fades the whole frame to black (loader / intro) */
    uFade: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uTransition, uGlitch, uAberration, uGrain, uVignette, uFlash, uFade;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      float t = uTransition;
      float g = clamp(max(t, uGlitch), 0.0, 1.0);

      // blocky horizontal slice tearing
      float rows = mix(18.0, 64.0, hash(vec2(floor(uTime * 9.0), 3.1)));
      float slice = floor(uv.y * rows);
      float r = hash(vec2(slice, floor(uTime * 24.0)));
      uv.x += (r - 0.5) * 0.16 * g * step(1.0 - 0.45 * g, r);

      // radial zoom toward center as we punch through a cut
      vec2 c = uv - 0.5;
      uv = 0.5 + c * (1.0 - 0.06 * t);

      float ca = uAberration * (0.35 + dot(c, c) * 3.0) + 0.018 * g;
      vec2 dir = normalize(c + 1e-5) * ca;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;

      if (t > 0.01) {
        vec3 acc = col;
        for (int i = 1; i < 7; i++) {
          float s = 1.0 - float(i) * 0.025 * t;
          acc += texture2D(tDiffuse, 0.5 + (uv - 0.5) * s).rgb;
        }
        col = mix(col, acc / 7.0, t);
      }

      col += vec3(0.75, 1.0, 0.86) * uFlash;
      col += vec3(0.6, 1.0, 0.8) * t * t * 0.55;

      float v = smoothstep(0.95, 0.25, length(c * vec2(1.0, 0.8)));
      col *= mix(1.0, v, uVignette);

      float n = hash(vUv * uResolution + fract(uTime * 7.13) * 91.0) - 0.5;
      col += n * uGrain;
      col *= 0.97 + 0.03 * sin(vUv.y * uResolution.y * 1.2);

      col = mix(col, vec3(0.0), uFade);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  aberration: number
  grain: number
  vignette: number
  glitch: number
  flash: number
  exposure: number
}

export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0.9,
  bloomRadius: 0.55,
  bloomThreshold: 0.62,
  aberration: 0.0025,
  grain: 0.055,
  vignette: 0.55,
  glitch: 0,
  flash: 0,
  exposure: 1,
}

export class Post {
  composer: EffectComposer
  bloom: UnrealBloomPass
  final: ShaderPass
  /**
   * Chapters write targets here every frame (engine resets them to defaults
   * first); values are damped toward so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  fade = 0

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    mobile: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: mobile ? 0 : 4,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.composer.addPass(new RenderPass(scene, camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.9, 0.55, 0.62)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.final = new ShaderPass(FinalShader)
    this.composer.addPass(this.final)
  }

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uGlitch.value = c.glitch
    u.uAberration.value = c.aberration
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uFade.value = this.fade
    this.composer.render(dt)
  }
}
