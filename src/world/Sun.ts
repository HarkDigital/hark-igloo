import * as THREE from 'three'
import type { Frame } from '../core/types'

/**
 * Optional cinematic sun: an HDR disc + glow that sits "at infinity" along
 * `direction` (depth-tested, so planets in front hide it), plus a lens layer
 * (thin anamorphic streak + soft starburst) that is never depth-tested but
 * fades with the analytically computed visibility of the sun disc behind any
 * spherical occluders — so a sun rising over a planet's limb flares up as it
 * clears the horizon instead of being cut off hard.
 *
 *   const sun = new Sun()
 *   group.add(sun.object)
 *   sun.direction.copy(planet.opts.sunDirection)
 *   sun.update(frame, camera, [{ center: planetWorldPos, radius: 10 }])
 */
export interface SunOptions {
  color?: THREE.ColorRepresentation
  /** overall brightness multiplier (default 1) */
  intensity?: number
  /** apparent radius of the sun disc in degrees (default 0.55) */
  size?: number
  /** size of the glow, as a fraction of the viewport height (default 0.55) */
  glow?: number
  /** strength of the lens streak / starburst (default 1) */
  flare?: number
}

export interface SunOccluder {
  center: THREE.Vector3
  radius: number
}

const VERT = /* glsl */ `
uniform vec3 uDir;
uniform vec2 uScale;   // quad half-size in viewport-height units (x, y)
varying vec2 vC;
void main() {
  vC = position.xy;
  vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + uDir * 1500.0, 1.0);
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  // behind the camera → collapse
  if (clip.w <= 0.0) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); return; }
  // sized against the shorter viewport side so portrait screens aren't flooded
  vec2 off = position.xy * uScale * 2.0 * min(1.0, aspect) * vec2(1.0 / aspect, 1.0);
  clip.xy += off * clip.w;
  clip.z = min(clip.z, clip.w * 0.99999);
  gl_Position = clip;
}
`

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uDisc;   // disc radius in quad units
varying vec2 vC;
void main() {
  float r = length(vC);
  float disc = smoothstep(uDisc, uDisc * 0.55, r);
  float glow = exp(-r / (uDisc * 2.2)) * 1.2 + exp(-r * 9.0) * 0.16 + exp(-r * 3.0) * 0.025;
  glow *= smoothstep(1.0, 0.55, r);
  vec3 col = uColor * (disc * 26.0 + glow);
  // outer halo drifts toward a cool tint
  col = mix(col, col * vec3(0.7, 1.0, 0.95), smoothstep(0.05, 0.5, r));
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`

const FLARE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uAspectQ; // quad x / y extent ratio
varying vec2 vC;
void main() {
  // vC.x spans the long streak, vC.y the short axis (scaled so units are square)
  vec2 c = vec2(vC.x * uAspectQ, vC.y);
  float streak = exp(-abs(vC.y) * 38.0) * pow(max(1.0 - abs(vC.x), 0.0), 2.4);
  float core = exp(-abs(vC.y) * 140.0) * pow(max(1.0 - abs(vC.x), 0.0), 7.0);
  float r = length(c);
  float a = atan(c.y, c.x);
  float rays = pow(abs(cos(a * 3.0 + 0.3)), 60.0) * exp(-r * 9.0) * 0.7
             + pow(abs(cos(a * 2.0 + 1.1)), 90.0) * exp(-r * 6.0) * 0.35;
  vec3 tint = vec3(0.55, 0.95, 1.0);
  vec3 col = tint * (streak * 0.42 + core * 1.2) + uColor * rays * smoothstep(0.0, 0.02, r);
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`

export class Sun {
  object = new THREE.Group()
  /** world-space direction toward the sun (= direction light comes FROM) */
  direction = new THREE.Vector3(0, 0.2, -1).normalize()
  /** 0..1 fraction of the disc visible after the last update */
  visibility = 1
  opts: Required<SunOptions>
  private glowMat: THREE.ShaderMaterial
  private flareMat: THREE.ShaderMaterial
  private tmp = new THREE.Vector3()

  constructor(opts: SunOptions = {}) {
    this.opts = { color: 0xfff3e6, intensity: 1, size: 0.55, glow: 0.55, flare: 1, ...opts }
    const quad = new THREE.PlaneGeometry(2, 2)
    const color = new THREE.Color(this.opts.color)
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: {
        uDir: { value: this.direction },
        uScale: { value: new THREE.Vector2(this.opts.glow, this.opts.glow) },
        uColor: { value: color },
        uIntensity: { value: 1 },
        uDisc: { value: 0.03 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    })
    const flareW = 1.15
    const flareH = 0.42
    this.flareMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FLARE_FRAG,
      uniforms: {
        uDir: { value: this.direction },
        uScale: { value: new THREE.Vector2(flareW, flareH) },
        uColor: { value: color },
        uIntensity: { value: 1 },
        uAspectQ: { value: flareW / flareH },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
    const glow = new THREE.Mesh(quad, this.glowMat)
    const flare = new THREE.Mesh(quad, this.flareMat)
    for (const m of [glow, flare]) {
      m.frustumCulled = false
      m.renderOrder = 50
      this.object.add(m)
    }
    flare.renderOrder = 51
  }

  update(frame: Frame, camera: { position: THREE.Vector3; fov?: number; aspect?: number }, occluders: SunOccluder[] = []) {
    const o = this.opts
    this.direction.normalize()
    const sigma = THREE.MathUtils.degToRad(o.size)
    let vis = 1
    let glowVis = 1
    for (const occ of occluders) {
      this.tmp.copy(occ.center).sub(camera.position)
      const dist = this.tmp.length()
      if (dist <= occ.radius) {
        vis = 0
        glowVis = 0
        break
      }
      const alpha = Math.asin(Math.min(1, occ.radius / dist))
      const theta = this.tmp.angleTo(this.direction)
      vis *= THREE.MathUtils.smoothstep(theta, alpha - sigma, alpha + sigma)
      glowVis *= THREE.MathUtils.smoothstep(theta, alpha - sigma * 8, alpha + sigma)
    }
    this.visibility = vis
    // disc radius in quad units: angular size / glow half-height (in tan space)
    const halfFov = THREE.MathUtils.degToRad((camera.fov ?? 45) / 2)
    // (portrait: the quad is scaled by aspect in the shader, compensate here)
    const aspect = camera.aspect ?? 1
    const discNdc = Math.tan(sigma) / Math.tan(halfFov) // in viewport-height half units
    this.glowMat.uniforms.uDisc.value = Math.max(0.006, discNdc / (o.glow * 2 * Math.min(1, aspect)))
    this.glowMat.uniforms.uScale.value.set(o.glow, o.glow)
    this.glowMat.uniforms.uIntensity.value = o.intensity * (0.25 + 0.75 * glowVis)
    const flick = frame.reducedMotion ? 1 : 1 + 0.03 * Math.sin(frame.time * 7.3) * Math.sin(frame.time * 3.1)
    this.flareMat.uniforms.uIntensity.value = o.intensity * o.flare * vis * vis * flick
  }
}
