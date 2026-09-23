import * as THREE from 'three'
import { HASH } from '../../core/glsl'
import { rng } from '../../core/math'

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying float vSeed;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(position, 1.0);
  vN = normalize(mat3(m) * normal);
  vW = w.xyz;
  vSeed = float(gl_InstanceID);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const FRAG = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uLight;
uniform float uTime;
uniform float uGlow;
varying vec3 vN;
varying vec3 vW;
varying float vSeed;
${HASH}
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  if (dot(N, V) < 0.0) N = -N;
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 3.0);
  float spec = pow(max(dot(reflect(-uLight, N), V), 0.0), 48.0);
  float h = hash12(vec2(vSeed, 3.7));
  float tw = pow(0.5 + 0.5 * sin(uTime * (1.2 + h * 2.6) + h * 40.0), 30.0);
  vec3 ice = vec3(0.72, 1.0, 0.9);
  vec3 col = vec3(0.006, 0.012, 0.014) + vec3(0.02, 0.06, 0.05) * ndv;
  col += ice * fres * 0.7;
  col += ice * spec * 3.5;
  col += mix(ice, vec3(0.0, 1.0, 0.235), 0.55) * tw * 3.2 * (0.35 + fres);
  gl_FragColor = vec4(col * uGlow, 1.0);
}
`

/** A drifting field of faceted crystal shards that glitter (the out-beat destination). */
export class Shards {
  mesh: THREE.InstancedMesh
  material: THREE.ShaderMaterial

  constructor(count: number, center: THREE.Vector3, spread: number, seed = 5) {
    const geo = new THREE.OctahedronGeometry(1, 0)
    geo.scale(0.32, 1, 0.32)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uLight: { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() },
        uTime: { value: 0 },
        uGlow: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, count)
    const r = rng(seed)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    for (let i = 0; i < count; i++) {
      // flattened ellipsoid cloud, denser toward the middle
      const a = r() * Math.PI * 2
      const rad = Math.pow(r(), 0.7) * spread
      p.set(Math.cos(a) * rad, (r() - 0.5) * spread * 0.55, Math.sin(a) * rad).add(center)
      e.set(r() * Math.PI, r() * Math.PI, r() * Math.PI)
      q.setFromEuler(e)
      const k = 0.18 + Math.pow(r(), 3) * 0.9
      s.set(k, k * (0.8 + r() * 0.9), k)
      m.compose(p, q, s)
      this.mesh.setMatrixAt(i, m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.computeBoundingSphere()
  }
}
