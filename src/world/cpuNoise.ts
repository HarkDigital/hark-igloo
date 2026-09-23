// CPU port of the Ashima 3D simplex noise + fbm in src/core/glsl.ts.
// Used to place things (e.g. planet city nodes) on features the GPU shaders
// draw, so the two agree to within float rounding.

const mod289 = (x: number) => x - Math.floor(x * (1 / 289)) * 289
const permute = (x: number) => mod289((x * 34 + 1) * x)
const taylorInvSqrt = (r: number) => 1.79284291400159 - 0.85373472095314 * r
const step = (edge: number, x: number) => (x < edge ? 0 : 1)

const OX = [0, 0, 0, 0]
const OY = [0, 0, 0, 0]
const OZ = [0, 0, 0, 0]
const P = [0, 0, 0, 0]
const XS = [0, 0, 0, 0]
const YS = [0, 0, 0, 0]
const ZS = [0, 0, 0, 0]

/** float snoise(vec3) — same math as the GLSL version, returns roughly -1..1 */
export function snoise(vx: number, vy: number, vz: number): number {
  const Cx = 1 / 6
  const Cy = 1 / 3
  const s = (vx + vy + vz) * Cy
  const ix = Math.floor(vx + s)
  const iy = Math.floor(vy + s)
  const iz = Math.floor(vz + s)
  const t = (ix + iy + iz) * Cx
  const x0x = vx - ix + t
  const x0y = vy - iy + t
  const x0z = vz - iz + t

  const gx = step(x0y, x0x)
  const gy = step(x0z, x0y)
  const gz = step(x0x, x0z)
  const lx = 1 - gx
  const ly = 1 - gy
  const lz = 1 - gz
  // i1 = min(g.xyz, l.zxy); i2 = max(g.xyz, l.zxy)
  const i1x = Math.min(gx, lz)
  const i1y = Math.min(gy, lx)
  const i1z = Math.min(gz, ly)
  const i2x = Math.max(gx, lz)
  const i2y = Math.max(gy, lx)
  const i2z = Math.max(gz, ly)

  OX[1] = i1x; OY[1] = i1y; OZ[1] = i1z
  OX[2] = i2x; OY[2] = i2y; OZ[2] = i2z
  OX[3] = 1; OY[3] = 1; OZ[3] = 1

  XS[0] = x0x; YS[0] = x0y; ZS[0] = x0z
  XS[1] = x0x - i1x + Cx; YS[1] = x0y - i1y + Cx; ZS[1] = x0z - i1z + Cx
  XS[2] = x0x - i2x + Cy; YS[2] = x0y - i2y + Cy; ZS[2] = x0z - i2z + Cy
  XS[3] = x0x - 0.5; YS[3] = x0y - 0.5; ZS[3] = x0z - 0.5

  const mx = mod289(ix)
  const my = mod289(iy)
  const mz = mod289(iz)
  for (let k = 0; k < 4; k++) {
    P[k] = permute(permute(permute(mz + OZ[k]) + my + OY[k]) + mx + OX[k])
  }

  const n_ = 0.142857142857
  const nsx = n_ * 2
  const nsy = n_ * 0.5 - 1
  const nsz = n_
  let sum = 0
  for (let k = 0; k < 4; k++) {
    const p = P[k]
    const j = p - 49 * Math.floor(p * nsz * nsz)
    const x_ = Math.floor(j * nsz)
    const y_ = Math.floor(j - 7 * x_)
    const x = x_ * nsx + nsy
    const y = y_ * nsx + nsy
    const h = 1 - Math.abs(x) - Math.abs(y)
    const sh = -step(h, 0)
    let gxk = x + (Math.floor(x) * 2 + 1) * sh
    let gyk = y + (Math.floor(y) * 2 + 1) * sh
    let gzk = h
    const norm = taylorInvSqrt(gxk * gxk + gyk * gyk + gzk * gzk)
    gxk *= norm
    gyk *= norm
    gzk *= norm
    const dx = XS[k]
    const dy = YS[k]
    const dz = ZS[k]
    let m = Math.max(0.6 - (dx * dx + dy * dy + dz * dz), 0)
    m = m * m
    sum += m * m * (gxk * dx + gyk * dy + gzk * dz)
  }
  return 42 * sum
}

/** fbm over snoise with the same lacunarity/offsets as the GLSL FBM snippet. */
export function fbm(x: number, y: number, z: number, octaves: number): number {
  let a = 0.5
  let s = 0
  for (let i = 0; i < octaves; i++) {
    s += a * snoise(x, y, z)
    x = x * 2.03 + 1.7
    y = y * 2.03 + 9.2
    z = z * 2.03 + 3.4
    a *= 0.5
  }
  return s
}
