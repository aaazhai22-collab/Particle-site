/** Analytic, reversible GPU motion shared by points and short trajectory segments. */
export const particleVertexShader = /* glsl */ `
  attribute vec3 aSeed;
  attribute vec3 aColor;
  #ifdef TRAIL
    attribute vec3 aOrigin;
  #endif
  uniform float uProgress;
  uniform float uTime;
  uniform float uSize;
  uniform float uSpread;
  uniform float uTurbulence;
  uniform float uDepth;
  uniform float uScatter;
  uniform float uStagger;
  uniform float uIsImage;
  uniform float uGlow;
  uniform float uMode;
  uniform float uAxis;
  uniform float uOriginalColor;
  uniform float uErosion;
  uniform float uFlowScale;
  uniform float uStringiness;
  uniform float uTrail;
  uniform float uTrailTimeSpan;
  uniform float uTrailProgressSpan;
  uniform float uWaveRhythm;
  uniform vec3 uDirection;
  uniform vec3 uColor;
  varying vec3 vColor;
  varying float vShimmer;
  varying float vVisibility;
  varying float vTrailAlpha;

  vec3 flow(vec3 p, float t) {
    return vec3(
      sin(p.y * 1.7 + t * 0.63) + cos(p.z * 1.25 - t * 0.36),
      sin(p.z * 1.6 - t * 0.49) + cos(p.x * 1.37 + t * 0.42),
      sin(p.x * 1.8 + t * 0.55) + cos(p.y * 1.3 - t * 0.44)
    ) * 0.5;
  }

  vec3 axisSpace(vec3 p) {
    if (uAxis < 0.5) return p.yxz;
    if (uAxis > 1.5) return p.xzy;
    return p;
  }

  vec3 displace(vec3 original, float p, float t, out float visibility) {
    visibility = 1.0;
    if (p <= 0.0) return original;
    // Release timing is spatially related but not identical for neighbouring
    // pixels. It uses immutable positions/seeds, so reverse playback restores
    // the exact source instead of integrating or stretching a picture plane.
    float releaseField = clamp(0.5 + 0.25 * sin(original.x * 2.3 + original.y * 1.7) +
                        0.24 * sin(original.z * 2.7 - original.y * 2.1), 0.0, 1.0);
    float delay = uStagger * 0.7 * (releaseField * 0.65 + aSeed.x * 0.35);
    p = clamp((p - delay) / max(0.01, 1.0 - delay), 0.0, 1.0);
    float amount = smoothstep(0.0, 1.0, p);
    vec3 normal = normalize(original + vec3(0.00001));
    vec3 randomDirection = normalize(aSeed * 2.0 - 1.0 + vec3(0.0001));
    vec3 displaced = original;
    if (uMode < 0.5) {
      float distance = 1.35 * uSpread * (0.68 + aSeed.x * 0.48);
      displaced += normal * distance * amount;
      displaced += flow(original * 2.0 + aSeed * 0.35, t) *
                   uTurbulence * 1.35 * amount;
    } else if (uMode < 1.5) {
      vec3 cloud = flow(original * 1.15, t + aSeed.x * 0.16);
      vec3 detail = flow(original * 3.1 + aSeed * 2.2, t * 1.35);
      displaced += (cloud * 0.85 + randomDirection * 0.24) *
                   1.35 * uSpread * amount;
      displaced += detail * uTurbulence * 1.35 * amount;
    } else if (uMode < 2.5) {
      vec3 q = axisSpace(original);
      float angle = amount * (uSpread * 2.8 + t * 0.7) *
                    (1.0 + q.y * 0.34 + aSeed.x * 0.16);
      float c = cos(angle);
      float s = sin(angle);
      float radiusScale = 1.0 + amount * uSpread *
                          (0.45 + 0.32 * abs(q.y) / 1.35);
      vec3 twisted = vec3(
        (q.x * c - q.z * s) * radiusScale,
        q.y + amount * uSpread * (aSeed.y - 0.5) * 1.1,
        (q.x * s + q.z * c) * radiusScale
      );
      displaced = axisSpace(twisted);
      displaced += flow(original * 2.0, t * 0.65) *
                   uTurbulence * 1.35 * amount;
    } else if (uMode < 3.5) {
      displaced += uDirection * amount * 1.35 * uSpread * (0.55 + aSeed.x * 0.65);
      displaced += flow(original * 1.8, t) * amount *
                   1.35 * (uTurbulence + uSpread * 0.12);
    } else if (uMode < 4.5) {
      float coordinate = clamp(dot(original, uDirection) / 2.7 + 0.5, 0.0, 1.0);
      float rhythm = uWaveRhythm * 0.5;
      float local = smoothstep(0.0, 1.0, p * (1.0 + rhythm) - coordinate * rhythm);
      displaced += (uDirection + normal * 0.32) * local * 1.35 * uSpread;
      displaced += flow(original * 2.1, t) * local * 1.35 * uTurbulence;
    } else {
      // Neighbours share an activation threshold, creating local holes and islands.
      vec3 space = original * uFlowScale;
      float field = clamp(0.5 + 0.24 * sin(space.x * 2.3 + space.y * 1.7) +
                          0.23 * sin(space.z * 2.7 - space.y * 2.1), 0.0, 1.0);
      float edge = clamp(length(original) / 1.35, 0.0, 1.0);
      float threshold = 0.22 + field * 0.46 - edge * uErosion * 0.13;
      float local = amount * smoothstep(threshold - 0.1, threshold + 0.2, p);
      float travel = local * 1.35 * uSpread;
      // Three correlated flow samples approximate a short curved streamline.
      vec3 first = flow(space, t * 0.72);
      vec3 second = flow(space + first * 0.8 + uDirection * travel * 0.42, t * 0.72 + 0.45);
      vec3 third = flow(space + second * 1.2 + uDirection * travel * 0.73, t * 0.72 + 0.9);
      vec3 streamline = first * 0.42 + second * 0.35 + third * 0.23;
      displaced += travel * (streamline * (0.72 + uStringiness * 0.34) +
                            uDirection * (0.3 + uStringiness * 0.14));
      displaced += third * local * 1.35 * uTurbulence;
      visibility = 1.0 - local * uErosion * (0.16 + field * 0.5);
    }
    // Every mode includes independent 3D grain. Without it, a front-facing
    // image can remain a sheet under radial motion or a coherent wind field.
    vec3 grain = randomDirection * (0.35 + aSeed.y * 0.65);
    displaced += grain * amount * 1.35 * uSpread * uScatter;
    vec3 offset = displaced - original;
    if (uIsImage > 0.5) {
      float coherentDepth = sin(original.x * 1.8 + sin(original.y * 2.3) + t * 0.35) * 0.55 +
                            cos(original.y * 1.7 - original.x * 1.2 - t * 0.27) * 0.45;
      offset.z += amount * 1.35 * max(uSpread, uTurbulence) * coherentDepth * 0.48;
    }
    offset.z *= uDepth;
    return original + offset;
  }

  void main() {
    vec3 original = position;
    float p = uProgress;
    float t = uTime;
    float history = 0.0;
    #ifdef TRAIL
      original = aOrigin;
      history = position.x;
      p = clamp(uProgress - history * uTrailProgressSpan, 0.0, 1.0);
      t = max(0.0, uTime - history * uTrailTimeSpan);
    #endif
    float visibility;
    vec3 displaced = displace(original, p, t, visibility);
    vec3 normal = normalize(original + vec3(0.00001));
    float frontLight = 0.76 + 0.24 * dot(normal, normalize(vec3(-0.3, 0.6, 1.0)));
    // Original RGB is used directly; the uniform mode gets gentle shape lighting.
    vColor = mix(uColor * frontLight, aColor, uOriginalColor);
    vShimmer = 0.82 + 0.18 * aSeed.z;
    vVisibility = visibility;
    vTrailAlpha = smoothstep(0.005, 0.18, uProgress) *
                  pow(max(0.0, 1.0 - history), 0.7) * uTrail;
    vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float perspectiveSize = clamp(5.7 / max(0.25, -viewPosition.z), 0.28, 5.0);
    gl_PointSize = max(1.0, uSize * perspectiveSize * (1.0 + uGlow * 1.8));
  }
`;

export const particleFragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uProgress;
  varying vec3 vColor;
  varying float vShimmer;
  varying float vVisibility;
  varying float vTrailAlpha;

  void main() {
    float dissolve = mix(1.0, 1.0 - smoothstep(0.78, 1.0, uProgress), uFade);
    float alpha;
    #ifdef TRAIL
      alpha = vTrailAlpha * uOpacity * dissolve * vVisibility * 0.25;
    #else
      float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
      if (radius > 1.0) discard;
      float core = 1.0 - smoothstep(0.06, 0.61, radius);
      float halo = pow(max(0.0, 1.0 - radius), 2.0) * uGlow * 0.35;
      float edge = 1.0 - smoothstep(0.87, 1.0, radius);
      alpha = (core * 0.61 + halo) * edge * uOpacity * vShimmer * dissolve * vVisibility;
    #endif
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(vColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
