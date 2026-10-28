// The backdrop behind the sleeve in hand: the water-caustics shader the user brought (the same one
// as on the Flutter create screen), drawn in screen space on a plane that faces the camera.
// Colours: behind a sleeve with a cover, the cover's two colours as they are (shelf/scene.ts,
// coverTint); otherwise the theme's — the water is the page's paper, the highlights its ink at
// WATER.strength (softer at night),
// with the clear middle pushed out (WATER.clearFrom/clearTo), as tuned in the Flutter version.
import * as THREE from 'three';

export const WATER = {
  /**
   * How strongly the highlights show over the water. At night light highlights on the dark paper
   * stand out much more, so they are softer: at 0.15 even the brightest spot keeps ink-muted text
   * above 4.5:1.
   */
  strength: { day: 0.4, night: 0.15, cover: 0.4 },
  /** The middle stays clear of highlights up to here (distance from the centre, 0..~2). */
  clearFrom: 0.2,
  clearTo: 0.7,
  /** Seconds of shader time per real second. */
  speed: 0.1,
};

const vertexShader = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
#define TAU 6.28318530718
#define TILING_FACTOR .5
#define MAX_ITER 10

uniform float uTime;
uniform vec2 uResolution;
uniform float uOpacity;
uniform vec3 uWater;
uniform vec3 uHighlight;
uniform float uStrength;
uniform vec2 uClear;

float waterHighlight(vec2 p, float time, float foaminess) {
  vec2 i = vec2(p);
  float c = 0.0;
  float foaminess_factor = mix(1.0, 6.0, foaminess);
  float inten = .005 * foaminess_factor;
  for (int n = 0; n < MAX_ITER; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t)), p.y / (cos(i.y + t))));
  }
  c = 0.2 + c / (inten * float(MAX_ITER));
  c = 1.17 - pow(c, 1.4);
  c = pow(abs(c), 8.0);
  return c / sqrt(foaminess_factor);
}

void main() {
  if (uOpacity <= 0.0) discard;
  float time = uTime + 23.0;
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 uv_square = vec2(uv.x * uResolution.x / uResolution.y, uv.y);
  float dist_center = pow(2.0 * length(uv - 0.5), 2.0);
  float foaminess = smoothstep(0.4, 1.8, dist_center);
  float clearness = 0.1 + 0.9 * smoothstep(uClear.x, uClear.y, dist_center);
  vec2 p = mod(uv_square * TAU * TILING_FACTOR, TAU) - 250.0;
  float c = waterHighlight(p, time, foaminess);
  // original: water + white highlights; here: paper + ink highlights at uStrength
  vec3 lit = mix(uWater, uHighlight, clamp(c, 0.0, 1.0) * uStrength);
  vec3 color = mix(uWater, lit, clearness);
  gl_FragColor = vec4(color, uOpacity);
  #include <colorspace_fragment>
}
`;

export function createWaterVeil() {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uOpacity: { value: 0 },
      uWater: { value: new THREE.Color('#efeeec') },
      uHighlight: { value: new THREE.Color('#1f1e21') },
      uStrength: { value: WATER.strength.day },
      uClear: { value: new THREE.Vector2(WATER.clearFrom, WATER.clearTo) },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), material);
  mesh.frustumCulled = false;
  const u = material.uniforms;
  // the colours it is easing toward: the theme's, or the cover's of the sleeve in hand
  const target = { water: new THREE.Color('#efeeec'), highlight: new THREE.Color('#1f1e21'), strength: WATER.strength.day };
  return {
    mesh,
    get opacity() {
      return u.uOpacity.value as number;
    },
    set opacity(v: number) {
      u.uOpacity.value = v;
    },
    /** Sets the colours to ease toward (see `ease`); `now` jumps there at once. */
    aim(water: string, highlight: string, strength: number, now = false) {
      target.water.set(water);
      target.highlight.set(highlight);
      target.strength = strength;
      if (now) {
        (u.uWater.value as THREE.Color).copy(target.water);
        (u.uHighlight.value as THREE.Color).copy(target.highlight);
        u.uStrength.value = strength;
      }
    },
    /** One step toward the aimed colours; true while they are still changing. */
    ease(k: number): boolean {
      const w = u.uWater.value as THREE.Color, hl = u.uHighlight.value as THREE.Color;
      w.lerp(target.water, k);
      hl.lerp(target.highlight, k);
      u.uStrength.value += (target.strength - (u.uStrength.value as number)) * k;
      const d = Math.abs(w.r - target.water.r) + Math.abs(w.g - target.water.g) + Math.abs(w.b - target.water.b) +
        Math.abs(hl.r - target.highlight.r) + Math.abs(hl.g - target.highlight.g) + Math.abs(hl.b - target.highlight.b);
      return d > 1e-3;
    },
    setResolution(w: number, h: number) {
      (u.uResolution.value as THREE.Vector2).set(w, h);
    },
    advance(dt: number) {
      u.uTime.value = (u.uTime.value as number) + dt * WATER.speed;
    },
  };
}
