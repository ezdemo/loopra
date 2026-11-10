export type LensMap = { width: number; height: number; scale: number; displacement: Uint8ClampedArray; highlight: Uint8ClampedArray };

/** A convex capsule lens: trace orthogonal rays through a rounded bevel (n=1.5).
 * RG encodes the sampling offset, not decorative noise. The flat center stays clear.
 */
export function rasterizeLens(width: number, height: number): LensMap {
  if (![width, height].every(value => Number.isFinite(value) && value >= 2 && value <= 1024)) throw new Error('Invalid lens dimensions');
  width = Math.round(width); height = Math.round(height);
  const radius = Math.min(width, height) / 2;
  const bezel = Math.min(15, radius * .6);
  const thickness = Math.min(22, radius * .7);
  const offset = new Float32Array(width * height * 2);
  const displacement = new Uint8ClampedArray(width * height * 4);
  const highlight = new Uint8ClampedArray(width * height * 4);
  let maximum = 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + .5; const py = y + .5;
    const nearestX = Math.max(radius, Math.min(width - radius, px));
    const nearestY = Math.max(radius, Math.min(height - radius, py));
    const dx = px - nearestX; const dy = py - nearestY;
    const radial = Math.hypot(dx, dy);
    const depth = radius - radial;
    const index = y * width + x;
    if (depth <= 0 || depth >= bezel || radial < .001) continue;
    const t = Math.max(.001, Math.min(.999, depth / bezel));
    const profile = Math.pow(1 - Math.pow(1 - t, 4), .25);
    const slope = thickness / bezel * Math.pow(1 - t, 3) / Math.pow(profile, 3);
    const nz = 1 / Math.hypot(1, slope);
    const nx = slope * nz * dx / radial; const ny = slope * nz * dy / radial;
    const eta = 1 / 1.5;
    const refracted = eta * nz - Math.sqrt(1 - eta * eta * (1 - nz * nz));
    const travel = (thickness * profile + 12) / (eta - refracted * nz);
    const shiftX = nx * refracted * travel; const shiftY = ny * refracted * travel;
    offset[index * 2] = shiftX; offset[index * 2 + 1] = shiftY;
    maximum = Math.max(maximum, Math.abs(shiftX), Math.abs(shiftY));
    // A tight, geometry-derived rim; no full-surface white fog.
    const light = Math.abs(nx * -.58 + ny * -.75 + nz * .32);
    const rim = Math.exp(-Math.pow(depth / 1.7, 2)) * (.12 + .75 * Math.pow(light, 5));
    highlight[index * 4] = 255; highlight[index * 4 + 1] = 255; highlight[index * 4 + 2] = 255; highlight[index * 4 + 3] = Math.round(rim * 255);
  }
  const scale = maximum * 2;
  for (let index = 0; index < width * height; index++) {
    // The SVG transfer 255/256 maps an encoded neutral 128 to exactly 0.5.
    displacement[index * 4] = 128 + offset[index * 2] / scale * 256;
    displacement[index * 4 + 1] = 128 + offset[index * 2 + 1] / scale * 256;
    displacement[index * 4 + 2] = 128; displacement[index * 4 + 3] = 255;
  }
  return { width, height, scale, displacement, highlight };
}
