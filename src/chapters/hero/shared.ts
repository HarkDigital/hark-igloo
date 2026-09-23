import * as THREE from 'three'

// Shared constants + GLSL for the hero ("Signal") chapter.

/** The mark's world scale (logo geometry is 1 unit tall). */
export const MARK_SCALE = 2.2
/** Mark-space extrusion depth used by the bricks and the polished solid. */
export const MARK_DEPTH = 0.13

/** Timeline (local 0..1) for the chapter. */
export const T = {
  flightStart: 0.05,
  landStart: 0.105,
  landEnd: 0.465,
  holoFadeA: 0.18,
  holoFadeB: 0.47,
  resolveA: 0.49,
  resolveB: 0.655,
  payoffA: 0.68,
  outA: 0.93,
}

/** Mark-space dissolve key used by the resolve sweep: y (bottom → top) plus a little wobble. */
export const DISSOLVE_Y_GAIN = 0.85

export const COLOR_GLSL = /* glsl */ `
const vec3 SIGNAL = vec3(0.0, 1.0, 0.235);
const vec3 MINT = vec3(0.55, 1.0, 0.78);
`

/**
 * Procedural "studio in orbit" environment: dark space above, the planet's
 * green glow below, an atmospheric horizon band, plus a few softbox strips
 * so polished surfaces have something crisp to reflect. Used directly by the
 * brick shader and baked through PMREM for the physical solid.
 */
export const ENV_GLSL = /* glsl */ `
float heroStrip(vec3 d, vec3 c, vec3 a, float lu, float lv, float soft) {
  a = normalize(a - c * dot(a, c));
  vec3 b = cross(c, a);
  float w = dot(d, c);
  if (w <= 0.05) return 0.0;
  float u = dot(d, a) / w;
  float v = dot(d, b) / w;
  return (1.0 - smoothstep(lu - soft, lu, abs(u))) * (1.0 - smoothstep(lv - soft * 0.5, lv, abs(v)));
}
vec3 heroEnv(vec3 d) {
  float y = d.y;
  vec3 col = mix(vec3(0.004, 0.006, 0.010), vec3(0.010, 0.016, 0.026), smoothstep(-0.2, 0.9, y));
  col += vec3(0.0, 0.07, 0.035) * smoothstep(0.02, -0.7, y);
  col += vec3(0.06, 0.9, 0.46) * exp(-pow((y + 0.1) * 9.0, 2.0)) * 0.18;
  col += vec3(1.0, 1.02, 1.06) * 7.0 * heroStrip(d, normalize(vec3(-0.45, 0.62, 0.64)), vec3(0.85, 0.0, 0.55), 1.1, 0.07, 0.1);
  col += vec3(0.82, 0.93, 1.0) * 4.0 * heroStrip(d, normalize(vec3(0.92, 0.2, -0.25)), vec3(0.0, 1.0, 0.0), 0.8, 0.05, 0.06);
  col += vec3(0.75, 0.9, 1.0) * 2.5 * heroStrip(d, normalize(vec3(0.1, 0.95, -0.2)), vec3(1.0, 0.0, 0.0), 0.9, 0.05, 0.05);
  col += vec3(0.25, 1.0, 0.6) * 0.9 * heroStrip(d, normalize(vec3(-0.9, -0.1, 0.1)), vec3(0.0, 1.0, 0.0), 0.5, 0.05, 0.06);
  // diagonal reflection card behind the viewer: the front faces carry one soft
  // sheen that sweeps across the mark as the camera swings into the payoff
  col += vec3(0.86, 0.95, 1.0) * 2.2 * heroStrip(d, normalize(vec3(0.4, -0.02, 1.0)), vec3(0.62, 0.78, 0.0), 0.62, 0.028, 0.045);
  col += vec3(0.86, 0.95, 1.0) * 0.12 * heroStrip(d, normalize(vec3(0.4, -0.02, 1.0)), vec3(0.62, 0.78, 0.0), 0.7, 0.14, 0.2);
  return col;
}
`

/** Cheap hash for per-fragment sparkle. */
export const HASH11 = /* glsl */ `
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
`


/** Orientation of the debris belt around the mark (mark space): tilted toward the viewer, slightly rolled. */
export function ringMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationZ(-0.2).multiply(new THREE.Matrix4().makeRotationX(0.34))
}

/** Contour tolerance for simplifyShape, in mark units (the mark is 1 unit tall). */
export const CONTOUR_EPS = 2e-6

/**
 * Douglas–Peucker on a closed ring. The SVG import samples every Bézier at a
 * fixed count, so long straight bars and tiny corner curves carry thousands of
 * near-collinear points (median spacing ~0.0003 of the mark's height). At
 * CONTOUR_EPS the contour moves by far less than a pixel even in the final
 * dive, curves keep the same facet angles as before, and the extrusion and
 * face fill have about half the vertices to triangulate, build and shade.
 */
export function simplifyRing(src: THREE.Vector2[], eps: number): THREE.Vector2[] {
  const pts = src.slice()
  if (pts.length > 1 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-18) pts.pop()
  const n = pts.length
  if (n < 8) return pts
  const keep = new Uint8Array(n)
  // split the ring at the two points farthest apart, then simplify each half
  let far = 0
  let fd = 0
  for (let i = 1; i < n; i++) {
    const d = pts[i].distanceToSquared(pts[0])
    if (d > fd) {
      fd = d
      far = i
    }
  }
  keep[0] = keep[far] = 1
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const A = pts[a]
    const B = pts[b % n]
    const dx = B.x - A.x
    const dy = B.y - A.y
    const len = Math.hypot(dx, dy)
    let best = -1
    let bd = eps
    for (let i = a + 1; i < b; i++) {
      const P = pts[i]
      const d = len < 1e-12 ? Math.hypot(P.x - A.x, P.y - A.y) : Math.abs(dx * (P.y - A.y) - dy * (P.x - A.x)) / len
      if (d > bd) {
        bd = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return pts.filter((_, i) => keep[i] === 1)
}

export function simplifyShape(s: THREE.Shape, eps: number): THREE.Shape {
  const out = new THREE.Shape(simplifyRing(s.getPoints(1), eps))
  for (const h of s.holes) out.holes.push(new THREE.Path(simplifyRing(h.getPoints(1), eps)))
  return out
}
