import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { logoParts } from '../../logo/logo'
import { lerp, rng } from '../../core/math'
import { ROTATE } from '../../core/glsl'
import { COLOR_GLSL, DISSOLVE_Y_GAIN, ENV_GLSL, MARK_DEPTH, T, ringMatrix } from './shared'

/*
 * The assembly: the two loops of the Hark mark voxelized on a 45° grid (so the
 * bricks run along the diagonal bars), laid in a running bond, three courses
 * deep. Every brick starts in a debris belt orbiting the hologram, leaves the
 * orbit tangentially, spirals in and locks into place with a green flash that
 * cools to gunmetal. Everything is a pure function of `local` (+ time for idle
 * drift), so any scroll position renders correctly on its own.
 *
 * One InstancedBufferGeometry, one ShaderMaterial, one draw call.
 */

export interface BrickInfo {
  index: number
  /** landed centre, mark space */
  target: THREE.Vector3
  landT: number
  layer: number
  /** normalized build order 0..1 */
  order: number
}

type Poly = { outer: THREE.Vector2[]; holes: THREE.Vector2[][] }

/**
 * Occupancy of the 45° brick lattice, by scanline fill. Every contour is
 * rotated into lattice space (u along the bars, v across) once; then each row's
 * centre line is intersected with the edges of each shape (outer + holes, so an
 * even-odd fill cuts the holes out) and the cells between crossing pairs are
 * filled. Shapes are unioned. O(rows × edges) instead of the old per-cell
 * point-in-polygon test, which was O(cells × edges) and the hero's biggest
 * boot cost. Returns a (2n)² grid indexed [(j + n) * 2n + (i + n)].
 */
function voxelize(polys: Poly[], c: number, n: number, R: number) {
  const size = 2 * n
  const occ = new Uint8Array(size * size)
  const shapes = polys.map(p => {
    const rings = [p.outer, ...p.holes]
    let m = 0
    for (const r of rings) m += r.length
    // edges as (u0, v0, u1, v1), lattice space
    const e = new Float64Array(m * 4)
    let vMin = Infinity
    let vMax = -Infinity
    let k = 0
    for (const r of rings) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const ua = (r[a].x + r[a].y) * R
        const va = (r[a].y - r[a].x) * R
        e[k++] = (r[b].x + r[b].y) * R
        e[k++] = (r[b].y - r[b].x) * R
        e[k++] = ua
        e[k++] = va
        if (va < vMin) vMin = va
        if (va > vMax) vMax = va
      }
    }
    return { e, vMin, vMax }
  })
  const xs: number[] = []
  for (let j = -n; j < n; j++) {
    const v = (j + 0.5) * c
    const row = (j + n) * size
    for (const s of shapes) {
      if (v < s.vMin || v > s.vMax) continue
      const e = s.e
      xs.length = 0
      for (let k = 0; k < e.length; k += 4) {
        const v0 = e[k + 1]
        const v1 = e[k + 3]
        if (v0 > v !== v1 > v) xs.push(e[k] + ((v - v0) * (e[k + 2] - e[k])) / (v1 - v0))
      }
      xs.sort((a, b) => a - b)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        // cells whose centre (i + 0.5)·c lies strictly between the crossings
        const i0 = Math.max(-n, Math.floor(xs[q] / c - 0.5) + 1)
        const i1 = Math.min(n - 1, Math.ceil(xs[q + 1] / c - 0.5) - 1)
        for (let i = i0; i <= i1; i++) occ[row + i + n] = 1
      }
    }
  }
  return (i: number, j: number) => i >= -n && i < n && j >= -n && j < n && occ[(j + n) * size + i + n] === 1
}

const VERT = /* glsl */ `
${ROTATE}
attribute vec3 aTarget;
attribute vec3 aSize;
attribute vec4 aOrbit;  // theta0, radius, height, speed
attribute vec4 aTime;   // landT, flight duration, dissolve key, debris flag
attribute vec4 aRand;

uniform float uLocal;
uniform float uTime;
uniform float uReveal;
uniform float uMotion;
uniform float uDebris;
uniform mat3 uRing;

varying vec3 vN;
varying vec3 vWP;
varying vec3 vBox;
varying vec3 vHalf;
varying float vFlash;
varying float vHeat;
varying float vFly;
varying float vBurn;
varying float vRest;

void main() {
  float landT = aTime.x;
  float dur = aTime.y;
  float debris = aTime.w;

  float p = clamp((uLocal - (landT - dur)) / dur, 0.0, 1.0);
  p = mix(p, 0.0, debris);
  float e = p * p * (3.0 - 2.0 * p);
  e = mix(e, 1.0 - pow(1.0 - p, 3.0), 0.45);

  // orbit in the tilted belt (scroll spins it, time drifts it)
  float theta = aOrbit.x + (uLocal * 1.35 + uTime * 0.028 * uMotion) * aOrbit.w;
  vec3 ringLocal = vec3(cos(theta) * aOrbit.y, aOrbit.z, sin(theta) * aOrbit.y);
  vec3 ring = uRing * ringLocal;
  vec3 tangent = uRing * vec3(-sin(theta), 0.0, cos(theta));

  // leave the orbit tangentially, spiral in, arrive from the viewer's side
  vec3 ctrl = mix(ring, aTarget, 0.45) + tangent * (0.35 + 0.25 * aRand.x) * aOrbit.y + vec3(0.0, 0.0, 0.25 + 0.3 * aRand.y);
  vec3 c0 = mix(ring, ctrl, e);
  vec3 c1 = mix(ctrl, aTarget, e);
  vec3 center = mix(c0, c1, e);

  // tumble while free, aligned once locked
  float fly = 1.0 - e;
  vec3 axis = normalize(aRand.xyz - 0.5 + vec3(1e-3));
  float ang = fly * fly * (aRand.w * 6.2831 + uTime * (0.25 + 0.5 * aRand.x) * uMotion + uLocal * 9.0);

  float since = uLocal - landT;
  float landed = step(0.0, since) * (1.0 - debris);
  float pop = 1.0 + 0.22 * landed * exp(-max(since, 0.0) * 90.0);

  float burn = smoothstep(aTime.z - 0.015, aTime.z + 0.085, uReveal) * (1.0 - debris);
  float scl = mix(0.42 + 0.4 * aRand.z, 1.0, e) * pop * (1.0 - burn);
  scl *= mix(1.0, uDebris, debris);

  vec3 hs = aSize * 0.5;
  vec3 lp = position * aSize * scl;
  mat3 base = rotZ(0.78539816);
  vec3 wp = rotateAxis(base * lp, axis, ang) + center;
  vec3 n = rotateAxis(base * normalize(normal / aSize), axis, ang);

  vBox = position * aSize;
  vHalf = hs;
  vFlash = landed * exp(-max(since, 0.0) * 110.0);
  vHeat = landed * exp(-max(since, 0.0) * 42.0);
  vFly = sin(p * 3.14159) * (1.0 - debris);
  vBurn = burn;
  vRest = (1.0 - step(0.001, p)) + debris;

  vec4 world = modelMatrix * vec4(wp, 1.0);
  vWP = world.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const FRAG = /* glsl */ `
${COLOR_GLSL}
${ENV_GLSL}
uniform vec3 uSunDir;
uniform vec3 uRimDir;
uniform float uEdgeW;
uniform float uGlow;

varying vec3 vN;
varying vec3 vWP;
varying vec3 vBox;
varying vec3 vHalf;
varying float vFlash;
varying float vHeat;
varying float vFly;
varying float vBurn;
varying float vRest;

void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWP);
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 70.0);
  float rim = pow(1.0 - ndv, 3.0);
  float back = max(dot(N, uRimDir), 0.0);

  vec3 R = reflect(-V, N);
  vec3 env = heroEnv(R);
  vec3 hemi = mix(vec3(0.0, 0.05, 0.028), vec3(0.018, 0.024, 0.034), N.y * 0.5 + 0.5);

  vec3 albedo = vec3(0.03, 0.034, 0.038);
  vec3 col = albedo * (ndl * vec3(1.6, 1.62, 1.7) + hemi * 2.0);
  col += env * mix(0.02, 0.22, rim) * 0.5;
  col += spec * vec3(1.2, 1.25, 1.3) * 0.2;
  col += back * vec3(0.3, 0.55, 0.5) * 0.12;

  // lit edges: distance to the second-nearest face plane
  vec3 d = vHalf - abs(vBox);
  float mn = min(d.x, min(d.y, d.z));
  float mx = max(d.x, max(d.y, d.z));
  float mid = d.x + d.y + d.z - mn - mx;
  float w = max(uEdgeW, fwidth(mid) * 1.2);
  float edge = 1.0 - smoothstep(0.0, w, mid);

  vec3 edgeCold = vec3(0.3, 0.38, 0.37) * (0.22 + 0.5 * ndl + 0.45 * rim);
  vec3 edgeCol = mix(edgeCold, SIGNAL * 2.6, vHeat);
  edgeCol = mix(edgeCol, mix(MINT, SIGNAL, 0.5) * 0.8, vFly * 0.75);
  edgeCol = mix(edgeCol, vec3(0.22, 0.28, 0.27), vRest * 0.6);
  col += edgeCol * edge * uGlow;

  col += SIGNAL * vFlash * 1.4;
  col += SIGNAL * sin(vBurn * 3.14159) * 1.3;
  col += MINT * vFly * 0.03;

  gl_FragColor = vec4(col, 1.0);
}
`

export class Bricks {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  infos: BrickInfo[] = []
  /** number of bricks that build the mark (the rest are orbiting debris) */
  buildCount = 0
  private landTimes: number[] = []

  constructor(mobile: boolean) {
    const rand = rng(1337)
    const { loopA, loopB } = logoParts()
    const polys: Poly[] = [...loopA, ...loopB].map(s => ({
      outer: s.getPoints(64),
      holes: s.holes.map(h => h.getPoints(64)),
    }))

    // --- voxelize on a 45° grid (u runs along the bars) ---
    const c = mobile ? 0.026 : 0.019
    const layers = 3
    const dz = MARK_DEPTH / layers
    const R = Math.SQRT1_2
    const n = Math.ceil(0.74 / c)
    const toXY = (u: number, v: number) => [(u - v) * R, (u + v) * R] as const
    const occupied = voxelize(polys, c, n, R)

    type Raw = { x: number; y: number; z: number; su: number; layer: number }
    const raw: Raw[] = []
    const gap = c * 0.13
    for (let k = 0; k < layers; k++) {
      const z = (k - (layers - 1) / 2) * dz
      for (let j = -n; j < n; j++) {
        const offset = (j + k) & 1
        const used = new Set<number>()
        for (let i = -n; i < n; i++) {
          if (!occupied(i, j) || used.has(i)) continue
          const pairStart = (((i - offset) % 2) + 2) % 2 === 0
          if (pairStart && occupied(i + 1, j)) {
            used.add(i).add(i + 1)
            const [x, y] = toXY((i + 1) * c, (j + 0.5) * c)
            raw.push({ x, y, z, su: 2 * c - gap, layer: k })
          } else {
            used.add(i)
            const [x, y] = toXY((i + 0.5) * c, (j + 0.5) * c)
            raw.push({ x, y, z, su: c - gap, layer: k })
          }
        }
      }
    }

    // --- build order: radiate out from the core, back course slightly first ---
    let rMax = 0
    for (const b of raw) rMax = Math.max(rMax, Math.hypot(b.x, b.y))
    const keyed = raw.map(b => ({
      b,
      k: (Math.hypot(b.x, b.y) / rMax) * 0.84 + (b.layer / (layers - 1)) * 0.07 + rand() * 0.09,
    }))
    keyed.sort((a, b) => a.k - b.k)

    const buildCount = keyed.length
    const debrisCount = Math.round(buildCount * (mobile ? 0.12 : 0.16))
    const count = buildCount + debrisCount
    this.buildCount = buildCount

    const aTarget = new Float32Array(count * 3)
    const aSize = new Float32Array(count * 3)
    const aOrbit = new Float32Array(count * 4)
    const aTime = new Float32Array(count * 4)
    const aRand = new Float32Array(count * 4)

    const orbitFor = (i: number, debris: boolean) => {
      const theta = rand() * Math.PI * 2
      // a thin, dense ring (like a planetary ring) with a few strays
      const g2 = (rand() + rand() + rand() + rand() - 2) / 2
      const stray = rand() < 0.06
      const radius = stray ? lerp(1.0, 1.9, rand()) : (debris ? 1.42 : 1.34) + g2 * 0.16
      const gauss = (rand() + rand() + rand() - 1.5) / 1.5
      const height = gauss * (stray ? 0.06 : 0.012)
      const speed = 0.9 / Math.sqrt(radius)
      aOrbit.set([theta, radius, height, speed], i * 4)
    }

    for (let i = 0; i < buildCount; i++) {
      const { b } = keyed[i]
      const order = buildCount > 1 ? i / (buildCount - 1) : 0
      const landT = lerp(T.landStart, T.landEnd, order)
      const dur = Math.min(landT - T.flightStart, 0.07 + rand() * 0.05)
      const dissolve = (b.y + 0.5) * DISSOLVE_Y_GAIN + (rand() - 0.5) * 0.08
      aTarget.set([b.x, b.y, b.z], i * 3)
      aSize.set([b.su, c - gap, dz * 0.86], i * 3)
      orbitFor(i, false)
      aTime.set([landT, dur, dissolve, 0], i * 4)
      aRand.set([rand(), rand(), rand(), rand()], i * 4)
      this.infos.push({ index: i, target: new THREE.Vector3(b.x, b.y, b.z), landT, layer: b.layer, order })
      this.landTimes.push(landT)
    }
    for (let i = buildCount; i < count; i++) {
      const pair = rand() < 0.45
      const s = 0.5 + rand() * 0.45
      aTarget.set([0, 0, 0], i * 3)
      aSize.set([(pair ? 2 * c - gap : c - gap) * s, (c - gap) * s, dz * 0.86 * s], i * 3)
      orbitFor(i, true)
      aTime.set([99, 0.1, 99, 1], i * 4)
      aRand.set([rand(), rand(), rand(), rand()], i * 4)
    }

    const base = new RoundedBoxGeometry(1, 1, 1, 1, 0.1)
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', base.getAttribute('position'))
    geo.setAttribute('normal', base.getAttribute('normal'))
    if (base.index) geo.setIndex(base.index)
    geo.setAttribute('aTarget', new THREE.InstancedBufferAttribute(aTarget, 3))
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 3))
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(aOrbit, 4))
    geo.setAttribute('aTime', new THREE.InstancedBufferAttribute(aTime, 4))
    geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(aRand, 4))
    geo.instanceCount = count

    const ring = ringMatrix()
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uLocal: { value: 0 },
        uTime: { value: 0 },
        uReveal: { value: -1 },
        uMotion: { value: 1 },
        uDebris: { value: 1 },
        uRing: { value: new THREE.Matrix3().setFromMatrix4(ring) },
        uSunDir: { value: new THREE.Vector3(-0.5, 0.72, 0.5).normalize() },
        uRimDir: { value: new THREE.Vector3(0.7, 0.25, -0.7).normalize() },
        uEdgeW: { value: c * 0.07 },
        uGlow: { value: 1 },
      },
    })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
  }

  /** How many bricks have locked into place at this local progress. */
  landed(local: number) {
    let lo = 0,
      hi = this.landTimes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.landTimes[mid] <= local) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  update(local: number, time: number, reveal: number, motion: number, debrisScale: number) {
    const u = this.material.uniforms
    u.uLocal.value = local
    u.uTime.value = time
    u.uReveal.value = reveal
    u.uMotion.value = motion
    u.uDebris.value = debrisScale
  }
}
