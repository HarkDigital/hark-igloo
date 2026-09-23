import * as THREE from 'three'
import { HASH } from '../../core/glsl'

/** Max simultaneous impact ripples the shell (and spark system) track. */
export const MAX_IMPACTS = 16

/**
 * Goldberg-style hex shell: a subdivided icosahedron whose dual cells
 * (hexagons + 12 pentagons) are emitted as kites so the fragment shader
 * knows (a) which cell a pixel belongs to (aCell = cell center) and
 * (b) how close it is to the cell border (aEdge: 0 center → 1 border).
 * That lets whole hexes light up as ripples pass, with crisp AA borders.
 */
export function hexShellGeometry(radius: number, detail: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, detail)
  const p = ico.getAttribute('position') as THREE.BufferAttribute
  const verts: THREE.Vector3[] = []
  const lookup = new Map<string, number>()
  const ids: number[] = []
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const k = `${Math.round(x * 1e4)}|${Math.round(y * 1e4)}|${Math.round(z * 1e4)}`
    let id = lookup.get(k)
    if (id === undefined) {
      id = verts.length
      verts.push(new THREE.Vector3(x, y, z).normalize())
      lookup.set(k, id)
    }
    ids.push(id)
  }
  ico.dispose()

  const tris = ids.length / 3
  const n = tris * 18
  const pos = new Float32Array(n * 3)
  const cell = new Float32Array(n * 3)
  const edge = new Float32Array(n)
  let o = 0
  const push = (v: THREE.Vector3, c: THREE.Vector3, e: number) => {
    pos[o * 3] = v.x * radius
    pos[o * 3 + 1] = v.y * radius
    pos[o * 3 + 2] = v.z * radius
    cell[o * 3] = c.x
    cell[o * 3 + 1] = c.y
    cell[o * 3 + 2] = c.z
    edge[o] = e
    o++
  }
  const g = new THREE.Vector3()
  const m1 = new THREE.Vector3()
  const m2 = new THREE.Vector3()
  for (let t = 0; t < tris; t++) {
    const corners = [verts[ids[t * 3]], verts[ids[t * 3 + 1]], verts[ids[t * 3 + 2]]]
    g.copy(corners[0]).add(corners[1]).add(corners[2]).normalize()
    for (let k = 0; k < 3; k++) {
      const v = corners[k]
      m1.copy(v).add(corners[(k + 1) % 3]).normalize()
      m2.copy(v).add(corners[(k + 2) % 3]).normalize()
      push(v, v, 0)
      push(m1, v, 1)
      push(g, v, 1)
      push(v, v, 0)
      push(g, v, 1)
      push(m2, v, 1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 3))
  geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1))
  geo.computeBoundingSphere()
  return geo
}

const VERT = /* glsl */ `
attribute vec3 aCell;
attribute float aEdge;
varying vec3 vCell;
varying float vEdge;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vWorld;
void main() {
  vCell = aCell;
  vEdge = aEdge;
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normalize(position));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const FRAG = /* glsl */ `
#define MAX_IMPACTS ${MAX_IMPACTS}
uniform float uTime;
uniform float uAlert;
uniform float uSealFront;
uniform float uSealed;
uniform float uCalm;
uniform float uBreach;
uniform float uFlare;
uniform float uIntensity;
uniform vec3 uCamPos;
uniform vec3 uBreachDir;
uniform vec3 uSealAxis;
uniform vec4 uImpacts[MAX_IMPACTS];
uniform float uImpactAmp[MAX_IMPACTS];
varying vec3 vCell;
varying float vEdge;
varying vec3 vN;
varying vec3 vObj;
varying vec3 vWorld;

const vec3 SIGNAL = vec3(0.0, 1.0, 0.235);
const vec3 ALERT = vec3(1.0, 0.045, 0.09);
const vec3 AMBER = vec3(1.0, 0.3, 0.05);
${HASH}
float gauss(float x) { return exp(-x * x); }

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vWorld);
  float facing = dot(N, V);
  float fres = pow(1.0 - abs(facing), 2.0);
  float backside = step(facing, 0.0);
  vec3 cell = normalize(vCell);
  vec3 P = normalize(vObj);
  float h = hash13(cell * 311.7 + 1.3);
  float h2 = hash13(cell * 91.1 + 7.7);

  // crisp, anti-aliased cell borders + a soft inner rim
  float fw = max(fwidth(vEdge), 1e-4);
  float line = smoothstep(1.0 - fw * 1.5, 1.0 - fw * 0.2, vEdge);
  float rim = smoothstep(0.62, 1.0, vEdge);

  // the seal radiates out from the breach: behind the front cells are locked
  float dB = acos(clamp(dot(cell, uBreachDir), -1.0, 1.0));
  float sc = dB / 3.14159;
  float sealedCell = max(1.0 - smoothstep(uSealFront - 0.05, uSealFront, sc), uCalm);
  float band = gauss((sc - uSealFront) / 0.028) * step(-0.05, uSealFront) * (1.0 - uCalm);

  // breach: a cluster of missing cells, red-edged and flickering
  float breach = uBreach * (1.0 - sealedCell);
  float hole = (1.0 - smoothstep(0.1, 0.19, dB + (h - 0.5) * 0.07)) * breach;
  float holeEdge = gauss((dB - 0.19) / 0.05) * breach;
  float flick = step(0.45, hash12(vec2(h * 91.0, floor(uTime * 14.0 + h * 7.0))));

  // damaged lattice: random cells stutter out while under attack
  float dropout = uAlert * (1.0 - sealedCell) * step(0.78, h2) * flick;

  vec3 idle = vec3(0.46, 0.8, 0.78);
  vec3 baseCol = mix(idle, SIGNAL, sealedCell);
  float baseI = (0.065 + 0.9 * fres) * mix(0.8, 1.0, sealedCell);
  float breath = 0.5 + 0.5 * sin(uTime * 0.85);
  baseI *= 1.0 + uCalm * (breath - 0.5) * 0.6;

  vec3 col = baseCol * line * baseI * (1.0 - dropout) * (1.0 - hole);
  col += baseCol * rim * (0.004 + 0.05 * fres) * (1.0 - hole);
  // soft bubble
  col += mix(vec3(0.16, 0.3, 0.32), SIGNAL * 0.55, sealedCell) * pow(fres, 3.4) * 0.28;

  // impacts: expanding hex ripple + a hot flash at the strike point
  vec3 impactCol = mix(mix(AMBER, ALERT, 0.6), SIGNAL * 0.38, uSealed);
  float rip = 0.0;
  float hot = 0.0;
  for (int i = 0; i < MAX_IMPACTS; i++) {
    float amp = uImpactAmp[i];
    if (amp <= 0.001) continue;
    vec4 im = uImpacts[i];
    float age = im.w;
    float dc = acos(clamp(dot(cell, im.xyz), -1.0, 1.0));
    float dp = acos(clamp(dot(P, im.xyz), -1.0, 1.0));
    float r = 0.02 + age * 0.62;
    rip += gauss((dc - r) / 0.05) * pow(1.0 - age, 1.8) * amp;
    hot += exp(-dp * dp / 0.0016) * pow(1.0 - age, 5.0) * amp;
  }
  col += impactCol * rip * (0.05 + 2.4 * line + 0.3 * rim) * 1.4;
  col += impactCol * hot * 6.0;

  col += ALERT * holeEdge * (line * 2.6 + rim * 0.25) * (0.5 + 0.5 * flick);
  col += ALERT * hole * 0.035 * flick;

  // the seal: a bright green front that locks each cell as it passes
  col += SIGNAL * band * (0.12 + 3.0 * line + 0.6 * rim) * 1.3;
  col += SIGNAL * uFlare * (line * 0.55 + fres * 0.22);

  // calm: a slow scan band + rare cell pings ("monitoring")
  float scanY = fract(uTime * 0.07) * 2.6 - 1.3;
  float scan = gauss((P.y - scanY) / 0.035) * uCalm;
  col += SIGNAL * scan * (line * 1.6 + 0.04 + rim * 0.15);
  float ping = step(0.99, hash12(vec2(h * 37.0, floor(uTime * 2.5 + h * 5.0)))) * uCalm;
  col += SIGNAL * ping * (0.12 + line * 1.4);

  col *= uIntensity * mix(1.0, 0.28, backside);
  gl_FragColor = vec4(col, 1.0);
}
`

export class HexShield {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  impacts: THREE.Vector4[]
  amps: number[]

  constructor(radius: number, detail: number, breachDir: THREE.Vector3) {
    this.impacts = Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4(0, 0, 1, 1))
    this.amps = new Array(MAX_IMPACTS).fill(0)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAlert: { value: 1 },
        uSealFront: { value: -1 },
        uSealed: { value: 0 },
        uCalm: { value: 0 },
        uBreach: { value: 1 },
        uFlare: { value: 0 },
        uIntensity: { value: 1 },
        uCamPos: { value: new THREE.Vector3() },
        uBreachDir: { value: breachDir.clone().normalize() },
        uSealAxis: { value: new THREE.Vector3(0.35, -0.8, 0.5).normalize() },
        uImpacts: { value: this.impacts },
        uImpactAmp: { value: this.amps },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(hexShellGeometry(radius, detail), this.material)
    this.mesh.renderOrder = 2
  }
}
