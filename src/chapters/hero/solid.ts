import * as THREE from 'three'
import { logoGeometry, logoParts } from '../../logo/logo'
import { NOISE } from '../../core/glsl'
import { COLOR_GLSL, DISSOLVE_Y_GAIN, ENV_GLSL, MARK_DEPTH } from './shared'

/*
 * The resolved mark: polished obsidian-chrome loops (MeshPhysicalMaterial on a
 * procedural PMREM environment, thin-film iridescence, fresnel rim) revealed
 * by a noise-edged scan that burns signal green, plus the centre diamond as an
 * HDR "signal core" that blooms, a soft billboard halo behind it, and the
 * scan-line light that sweeps the mark during the resolve.
 */

function buildEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene()
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      ${ENV_GLSL}
      varying vec3 vDir;
      void main() { gl_FragColor = vec4(heroEnv(normalize(vDir)), 1.0); }
    `,
  })
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(40, 96, 48), mat)
  scene.add(sphere)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(scene, 0.015, 0.1, 100)
  pmrem.dispose()
  sphere.geometry.dispose()
  mat.dispose()
  return rt.texture
}

const CORE_VERT = /* glsl */ `
varying vec3 vMark;
varying vec3 vN;
varying vec3 vV;
void main() {
  vMark = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`
const CORE_FRAG = /* glsl */ `
${COLOR_GLSL}
uniform float uTime;
uniform float uIntensity;
uniform float uMotion;
uniform vec2 uCenter;
uniform float uSize;
varying vec3 vMark;
varying vec3 vN;
varying vec3 vV;
void main() {
  // a cut gem: flat facets catch a key light, glowing from within
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  float ndv = abs(dot(N, V));
  float fr = pow(1.0 - ndv, 2.0);
  float key = 0.5 + 0.5 * dot(N, normalize(vec3(-0.45, 0.65, 0.6)));
  float glint = pow(max(dot(reflect(-V, N), normalize(vec3(-0.3, 0.5, 0.8))), 0.0), 24.0);
  vec2 q = vMark.xy - uCenter;
  float d = clamp((abs(q.x) + abs(q.y)) / uSize, 0.0, 1.0);
  float t = uTime * uMotion;
  float ripple = pow(0.5 + 0.5 * sin(d * 22.0 - t * 3.0), 8.0) * (1.0 - d);
  float pulse = 0.9 + 0.1 * sin(t * 2.2);
  vec3 col = SIGNAL * (0.35 + 0.95 * key * key + 0.7 * fr + ripple * 0.5);
  col += MINT * (glint * 1.4 + pow(1.0 - d, 4.0) * 0.5);
  gl_FragColor = vec4(col * uIntensity * pulse, 1.0);
}
`

const HALO_VERT = /* glsl */ `
uniform float uScale;
varying vec2 vUv;
void main() {
  vUv = uv - 0.5;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uScale;
  gl_Position = projectionMatrix * mv;
}
`
const HALO_FRAG = /* glsl */ `
${COLOR_GLSL}
uniform float uIntensity;
varying vec2 vUv;
void main() {
  float r = length(vUv) * 2.0;
  float g = exp(-r * r * 9.0) * 0.9 + exp(-r * 3.5) * 0.25;
  g *= 1.0 - smoothstep(0.8, 1.0, r);
  // four-point star glint, aligned to the diamond
  vec2 a = abs(vUv);
  float star = exp(-a.x * 90.0) * exp(-a.y * 5.0) + exp(-a.y * 90.0) * exp(-a.x * 5.0);
  vec3 col = SIGNAL * g + MINT * star * 0.35;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`

const SCAN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const SCAN_FRAG = /* glsl */ `
${COLOR_GLSL}
uniform float uIntensity;
uniform float uSheet;
varying vec2 vUv;
void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  float y = abs(vUv.y - 0.5) * 2.0;
  float ends = 1.0 - smoothstep(0.55, 1.0, x);
  float line = exp(-y * mix(28.0, 3.0, uSheet));
  vec3 col = mix(MINT * 1.25, SIGNAL, uSheet) * line * ends;
  float a = line * ends * uIntensity * mix(0.9, 0.08, uSheet);
  gl_FragColor = vec4(col * a, a);
}
`

export class Solid {
  group = new THREE.Group()
  mark: THREE.Mesh
  core: THREE.Mesh
  halo: THREE.Mesh
  scan: THREE.Group
  /** diamond centre in mark space */
  coreCenter = new THREE.Vector3()
  coreSize = 0.1
  private reveal = { value: -1 }
  private rim = { value: 0.6 }
  private coreMat: THREE.ShaderMaterial
  private haloMat: THREE.ShaderMaterial
  private scanLine: THREE.ShaderMaterial
  private scanSheet: THREE.ShaderMaterial
  material: THREE.MeshPhysicalMaterial

  constructor(renderer: THREE.WebGLRenderer, mobile: boolean) {
    const parts = logoParts()
    const envMap = buildEnv(renderer)

    const geo = logoGeometry({
      shapes: [...parts.loopA, ...parts.loopB],
      depth: MARK_DEPTH - 0.02,
      bevelSize: 0.011,
      bevelThickness: 0.013,
      curveSegments: mobile ? 16 : 28,
    })
    this.material = new THREE.MeshPhysicalMaterial({
      color: 0x6f7980,
      metalness: 1,
      roughness: 0.2,
      envMap,
      envMapIntensity: 1.25,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      iridescence: 0.55,
      iridescenceIOR: 1.7,
      iridescenceThicknessRange: [220, 560],
    })
    const reveal = this.reveal
    const rim = this.rim
    this.material.onBeforeCompile = shader => {
      shader.uniforms.uReveal = reveal
      shader.uniforms.uRim = rim
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMarkPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMarkPos = position;')
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vMarkPos;
uniform float uReveal;
uniform float uRim;
${NOISE}
${COLOR_GLSL}`,
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
float dKey = (vMarkPos.y + 0.5) * ${DISSOLVE_Y_GAIN.toFixed(3)} + snoise(vMarkPos * 11.0) * 0.04 + snoise(vMarkPos * 37.0) * 0.012;
float dEdge = uReveal - dKey;
if (dEdge < 0.0) discard;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
float burnE = 1.0 - smoothstep(0.0, 0.012, dEdge);
float burnW = 1.0 - smoothstep(0.0, 0.06, dEdge);
totalEmissiveRadiance += SIGNAL * (burnE * 2.2 + burnW * 0.12) + MINT * pow(burnE, 4.0) * 1.6;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `float rimF = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0);
outgoingLight += mix(MINT, vec3(0.85, 0.95, 1.0), 0.55) * rimF * uRim;
#include <opaque_fragment>`,
        )
    }
    this.mark = new THREE.Mesh(geo, this.material)
    this.group.add(this.mark)

    // --- signal core (the diamond) ---
    // the logo's diamond is a square on its point: an octahedron seen head-on
    const flat = logoGeometry({ shapes: parts.diamond, depth: 0.01, bevel: false, curveSegments: 4 })
    flat.computeBoundingBox()
    const bb = flat.boundingBox!
    bb.getCenter(this.coreCenter)
    this.coreSize = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) * 0.5
    flat.dispose()
    const dGeo = new THREE.OctahedronGeometry(1, 0)
    dGeo.scale(this.coreSize, this.coreSize, 0.1)
    dGeo.translate(this.coreCenter.x, this.coreCenter.y, 0)
    this.coreMat = new THREE.ShaderMaterial({
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uMotion: { value: 1 },
        uCenter: { value: new THREE.Vector2(this.coreCenter.x, this.coreCenter.y) },
        uSize: { value: this.coreSize },
      },
    })
    this.core = new THREE.Mesh(dGeo, this.coreMat)
    this.group.add(this.core)

    this.haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: { uScale: { value: 0.9 }, uIntensity: { value: 0.5 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.haloMat)
    this.halo.position.copy(this.coreCenter)
    this.halo.renderOrder = 3
    this.halo.frustumCulled = false
    this.group.add(this.halo)

    // --- scan line + faint horizontal light sheet ---
    this.scan = new THREE.Group()
    const blend = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }
    this.scanLine = new THREE.ShaderMaterial({
      vertexShader: SCAN_VERT,
      fragmentShader: SCAN_FRAG,
      uniforms: { uIntensity: { value: 0 }, uSheet: { value: 0 } },
      ...blend,
    })
    this.scanSheet = new THREE.ShaderMaterial({
      vertexShader: SCAN_VERT,
      fragmentShader: SCAN_FRAG,
      uniforms: { uIntensity: { value: 0 }, uSheet: { value: 1 } },
      ...blend,
    })
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.02), this.scanLine)
    line.position.z = MARK_DEPTH / 2 + 0.03
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.9), this.scanSheet)
    sheet.rotation.x = -Math.PI / 2
    this.scan.add(line, sheet)
    this.scan.renderOrder = 4
    for (const o of [line, sheet]) {
      o.renderOrder = 4
      o.frustumCulled = false
    }
    this.group.add(this.scan)
  }

  /**
   * @param reveal dissolve threshold in key space (≤ -0.1 hidden, ≥ 1 fully solid)
   * @param core   HDR multiplier for the diamond core
   */
  update(reveal: number, core: number, halo: number, rim: number, time: number, motion: number) {
    this.reveal.value = reveal
    this.rim.value = rim
    this.mark.visible = reveal > -0.12
    const cu = this.coreMat.uniforms
    cu.uTime.value = time
    cu.uIntensity.value = core
    cu.uMotion.value = motion
    this.haloMat.uniforms.uIntensity.value = halo
    this.core.visible = core > 0.001
    this.halo.visible = halo > 0.001

    // scan plane rides the dissolve front
    const s = Math.sin(Math.PI * Math.min(1, Math.max(0, (reveal + 0.1) / 1.2)))
    const y = reveal / DISSOLVE_Y_GAIN - 0.5
    this.scan.position.y = y
    this.scanLine.uniforms.uIntensity.value = s
    this.scanSheet.uniforms.uIntensity.value = s
    this.scan.visible = s > 0.01
  }

  setHaloScale(v: number) {
    this.haloMat.uniforms.uScale.value = v
  }
}
