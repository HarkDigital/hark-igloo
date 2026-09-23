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

    // sin-free hash: stable on mobile GPUs at large inputs
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // one chromatic sample: radial aberration + horizontal RGB split
    vec3 chroma(vec2 uv, vec2 ca, float split) {
      return vec3(
        texture2D(tDiffuse, uv + ca + vec2(split, 0.0)).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - ca - vec2(split, 0.0)).b
      );
    }

    void main() {
      vec2 uv = vUv;
      float t = uTransition;
      float g = clamp(max(t, uGlitch), 0.0, 1.0);
      // glitch patterns step at 24 fps, like dropped frames
      float ft = floor(uTime * 24.0);

      // horizontal slice tear: a growing share of bands jump sideways
      float rows = mix(14.0, 52.0, hash(vec2(floor(uTime * 8.0), 3.1)));
      float slice = floor(uv.y * rows);
      float r = hash(vec2(slice, ft));
      float torn = step(1.0 - 0.5 * g, r);
      float tear = (hash(vec2(slice, ft + 17.0)) - 0.5) * 0.15 * g * torn;
      uv.x += tear;

      // coarse block displacement only near the peak of a cut
      vec2 blk = floor(vUv * vec2(10.0, 6.0));
      float bOn = step(1.0 - 0.16 * g * g, hash(blk + ft * 1.37));
      uv += bOn * (vec2(hash(blk + 4.1), hash(blk + 9.7)) - 0.5) * vec2(0.09, 0.025);

      // punch-in zoom as we go through the cut
      vec2 c = vUv - 0.5;
      uv = 0.5 + (uv - 0.5) * (1.0 - 0.07 * t * t);

      vec2 ca = normalize(c + 1e-5) * uAberration * (0.2 + dot(c, c) * 1.8);
      float split = 0.011 * g + abs(tear) * 0.45;

      vec3 col;
      if (t > 0.01) {
        // radial zoom blur, dithered per pixel so the steps never band
        float j = hash(gl_FragCoord.xy + fract(uTime * 3.7) * 61.0);
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        for (int i = 0; i < 8; i++) {
          float fi = (float(i) + j) / 8.0;
          float w = 1.0 - fi * 0.55;
          acc += chroma(0.5 + (uv - 0.5) * (1.0 - fi * 0.17 * t), ca, split) * w;
          wsum += w;
        }
        col = mix(chroma(uv, ca, split), acc / wsum, smoothstep(0.0, 0.6, t));
      } else {
        col = chroma(uv, ca, split);
      }

      // a few thin signal-green interference lines while glitching
      float line = step(0.994 - 0.02 * g, hash(vec2(floor(vUv.y * uResolution.y * 0.5), ft)));
      col += vec3(0.25, 1.0, 0.6) * line * g * 0.22;

      // chapter-driven flash + a brief white-hot / green-rim flash right at the cut
      float peak = pow(t, 8.0);
      float core = smoothstep(0.8, 0.0, length(c * vec2(1.5, 1.0)));
      vec3 flashCol = mix(vec3(0.3, 1.0, 0.62), vec3(1.0), core);
      col += vec3(0.75, 1.0, 0.86) * uFlash;
      col += flashCol * peak * (0.25 + 0.5 * core);
      col += vec3(0.3, 1.0, 0.6) * t * t * 0.07;

      float v = smoothstep(0.95, 0.25, length(c * vec2(1.0, 0.8)));
      col *= mix(1.0, v, uVignette);

      // film grain, a touch stronger in the midtones than in the blacks
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      float n = hash(vUv * uResolution + fract(uTime * 7.13) * 91.0) - 0.5;
      col += n * uGrain * (0.55 + 0.45 * smoothstep(0.0, 0.35, lum));
      // barely-there scanlines that come up during glitches
      col *= 1.0 - (0.018 + 0.06 * g) * (0.5 + 0.5 * sin(vUv.y * uResolution.y * 1.3));

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

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through the bloom
 * mip chain and black it out.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
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
    this.composer.addPass(new ShaderPass(SanitizeShader))
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
