/** Analytic, reversible GPU motion shared by points and short trajectory segments. */
export const particleVertexShader = /* glsl */ `
  attribute vec3 aSeed;
  attribute vec3 aColor;
  attribute vec3 aNormal;
  attribute vec3 aSurface;
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
  uniform float uCurl;
  uniform float uSparkle;
  uniform float uDensityOpacity;
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
  uniform float uSurfaceMode;
  uniform float uPetalFlow;
  uniform float uAmbientPhase;
  uniform float uAmbientRange;
  uniform float uTimelineActive;
  uniform float uTimelineTime;
  uniform float uTimelineDuration;
  uniform float uMotionSpeed;
  uniform float uOutputScale;
  uniform float uFade;
  uniform sampler2D uProgressHistory;
  varying vec3 vColor;
  varying float vShimmer;
  varying float vVisibility;
  varying float vTrailAlpha;
  varying float vSpark;
  varying float vDistanceFade;
  varying float vLocalAge;
  varying vec3 vSeed;
  varying float vHistory;

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

  // Each component depends on the other two coordinates, so the divergence
  // is analytically zero. Neighbouring samples follow the same curling field.
  vec3 curlVelocity(vec3 q, float t) {
    return vec3(
      sin(q.y + t * 0.42) - cos(q.z * 1.13 - t * 0.27),
      sin(q.z * 1.13 + t * 0.31) - cos(q.x * 0.91 + t * 0.23),
      sin(q.x * 0.91 - t * 0.35) - cos(q.y + t * 0.29)
    ) * 0.6;
  }

  vec3 streamlinePosition(vec3 origin, float travel, float t) {
    vec3 pointOnCurve = origin;
    float stepLength = travel * (0.22 + uCurl * 0.24);
    // Two midpoint integration steps, evaluated afresh from the immutable
    // origin. This makes actual curved trajectories without simulation drift.
    for (int stepIndex = 0; stepIndex < 2; stepIndex++) {
      vec3 firstVelocity = curlVelocity(pointOnCurve * uFlowScale, t);
      vec3 midpoint = pointOnCurve + firstVelocity * stepLength * 0.5;
      vec3 middleVelocity = curlVelocity(midpoint * uFlowScale, t);
      pointOnCurve += (middleVelocity + uDirection * 0.32) * stepLength;
    }
    return pointOnCurve;
  }

  float petalAge(vec3 origin, float p) {
    if (p <= 0.0) return 0.0;
    vec3 q = origin * uFlowScale;
    float islands = 0.5 + 0.23 * sin(q.x * 3.1 + q.y * 2.7) +
                    0.21 * cos(q.y * 3.7 - q.z * 2.1 + aSurface.x * 6.2831853);
    float centerOrgan = 1.0 - step(0.45, abs(aSurface.z - 1.0));
    float stemOrgan = step(1.5, aSurface.z);
    // Edge erosion is shared by local surface neighbours. Stamens stay intact
    // longer, retaining the warm centre while cooler petal patches release.
    float releaseAt = clamp(0.12 + islands * (0.28 + uStagger * 0.18) -
      aSurface.y * uErosion * 0.17 + centerOrgan * 0.2 + stemOrgan * 0.1, 0.025, 0.72);
    return smoothstep(releaseAt, min(1.0, releaseAt + 0.45), p);
  }

  vec3 surfaceNormal(vec3 original) {
    if (dot(aNormal, aNormal) > 0.00001) return normalize(aNormal);
    if (uIsImage > 0.5) return vec3(0.0, 0.0, 1.0);
    return normalize(original + vec3(0.00001));
  }

  vec3 petalDrift(vec3 original) {
    vec3 outward = normalize(vec3(original.x * 0.8, original.y * 0.22, original.z * 0.35) + vec3(0.0001));
    vec3 drift = uDirection * 0.4 + vec3(0.0, 0.1, 0.0) + outward * 0.85;
    drift.z *= uDepth;
    return normalize(drift + vec3(0.0001, 0.0001, 0.0001 * uDepth));
  }

  vec3 petalVelocity(vec3 pointOnPath, vec3 drift, float phase) {
    vec3 velocity = curlVelocity(pointOnPath * uFlowScale, phase) *
                    (uCurl * (0.16 + uStringiness * 0.035) + uTurbulence * 0.2);
    velocity.z *= uDepth;
    velocity += drift * (0.82 + uStringiness * 0.04);
    // Positive forward velocity opens the streamlines. Curl bends the stream
    // without prescribing a circular loop or bringing its endpoint home.
    velocity += drift * max(0.0, 0.58 - dot(velocity, drift));
    return velocity;
  }

  vec3 petalPosition(vec3 original, float age, float motionPhase) {
    if (age <= 0.0) return original;
    vec3 drift = petalDrift(original);
    float travel = 1.35 * (uSpread / (0.8 + uSpread)) * age * (0.4 + age * 0.6) * (0.82 + aSeed.y * 0.36);
    float stepLength = travel * 0.5;
    float phase = motionPhase * 0.6 + aSurface.x * 0.25;
    vec3 pointOnPath = original;
    // Two midpoint steps (four field samples), recomputed from immutable P0.
    // Stable per-particle travel and spatial release break a surface into
    // correlated moving grains instead of fading a stationary flower card.
    for (int streamStep = 0; streamStep < 2; streamStep++) {
      vec3 velocity = petalVelocity(pointOnPath, drift, phase);
      vec3 midpoint = pointOnPath + velocity * stepLength * 0.5;
      pointOnPath += petalVelocity(midpoint, drift, phase) * stepLength;
    }
    vec3 grain = (aSeed - 0.5) * uScatter * travel * 0.12;
    grain.z *= uDepth;
    grain -= drift * dot(grain, drift);
    return pointOnPath + grain;
  }

  float progressAt(float seconds) {
    float index = clamp(seconds / max(0.0001, uTimelineDuration), 0.0, 1.0) * 1024.0;
    float left = floor(index);
    float a = texture2D(uProgressHistory, vec2((left + 0.5) / 1025.0, 0.5)).r;
    float b = texture2D(uProgressHistory, vec2((min(left + 1.0, 1024.0) + 0.5) / 1025.0, 0.5)).r;
    return mix(a, b, fract(index));
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
      displaced = streamlinePosition(original, travel * (0.8 + uStringiness * 0.24), t * 0.38);
      displaced += flow(space * 1.7, t * 0.4) * local * 1.35 * uTurbulence * 0.35;
      visibility = 1.0 - local * uErosion * (0.16 + field * 0.5);
    }
    // Every mode includes independent 3D grain. Without it, a front-facing
    // image can remain a sheet under radial motion or a coherent wind field.
    vec3 grain = randomDirection * (0.35 + aSeed.y * 0.65);
    float coherentWeight = uMode > 4.5 ? mix(1.0, 0.16, clamp(uCurl, 0.0, 1.0)) : 1.0;
    displaced += grain * amount * 1.35 * uSpread * uScatter * coherentWeight;
    vec3 offset = displaced - original;
    if (uIsImage > 0.5) {
      float coherentDepth = sin(original.x * 1.8 + sin(original.y * 2.3) + t * 0.35) * 0.55 +
                            cos(original.y * 1.7 - original.x * 1.2 - t * 0.27) * 0.45;
      offset.z += amount * 1.35 * max(uSpread, uTurbulence) * coherentDepth * 0.48 * coherentWeight;
    }
    offset.z *= uDepth;
    return original + offset;
  }

  void main() {
    vec3 original = position;
    float p = uProgress;
    float t = uTime;
    float history = 0.0;
    bool petalActive = uPetalFlow > 0.5 && uMode > 4.5;
    #ifdef TRAIL
      original = aOrigin;
      history = position.x;
      if (!petalActive) {
        p = clamp(uProgress - history * uTrailProgressSpan, 0.0, 1.0);
        t = max(0.0, uTime - history * uTrailTimeSpan);
        if (uTimelineActive > 0.5) {
          float historicalSecond = max(0.0, uTimelineTime - history * (0.18 + uTrail * 0.7));
          p = progressAt(historicalSecond);
          t = historicalSecond * uMotionSpeed;
        }
      }
    #endif
    float visibility = 1.0;
    float tailBirth = 1.0;
    vec3 displaced;
    vLocalAge = 0.0;
    if (petalActive) {
      vLocalAge = petalAge(original, uProgress);
      float sampledAge = vLocalAge;
      #ifdef TRAIL
        #ifdef PARTICLE_TRAIL
          // Sample the actual particle trajectory. No extra circular geometry.
          float endingProgress = mix(min(uProgress, 0.94), uProgress, uFade);
          float shrink = mix(1.0, 0.25, smoothstep(0.8, 0.985, endingProgress));
          sampledAge = max(0.0, sampledAge - history * (0.04 + uTrail * 0.2) * shrink);
          t = max(0.0, t - history * uTrail * 0.35 * uMotionSpeed * shrink);
        #else
          sampledAge = max(0.0, sampledAge - history * (0.025 + uTrail * 0.085));
        #endif
      #endif
      displaced = petalPosition(original, sampledAge, t);
      #ifdef PARTICLE_TRAIL
        tailBirth = smoothstep(0.0, 0.025, sampledAge);
      #endif
      visibility = 1.0 - smoothstep(0.2, 0.95, vLocalAge) * 0.25;
    } else displaced = displace(original, p, t, visibility);
    vec3 normal = surfaceNormal(original);
    #ifdef AMBIENT
      float phase = uAmbientPhase + aSeed.x * 6.2831853;
      vec3 orbit = vec3(sin(phase), cos(phase + aSeed.y * 3.0), sin(phase + aSeed.z * 5.0));
      float reach = (0.06 + uAmbientRange * 0.6) * (0.35 + aSeed.y * 0.65);
      displaced += (normal * (0.045 + uAmbientRange * 0.1) + orbit * reach);
      visibility = 0.45 + aSeed.z * 0.5;
    #endif
    float frontLight = 0.76 + 0.24 * dot(normal, normalize(vec3(-0.3, 0.6, 1.0)));
    // Original RGB is used directly; the uniform mode gets gentle shape lighting.
    // Keep original RGB independent of the hidden uniform colour. A mix at
    // exactly 1 can still leave an HDR rounding difference after colour edits.
    vColor = uOriginalColor > 0.5 ? aColor : uColor * frontLight;
    if (uSurfaceMode > 0.5) {
      vec3 viewNormal = normalize(normalMatrix * normal);
      float surfaceLight = 0.32 + 0.68 * pow(abs(dot(viewNormal, normalize(vec3(-0.35, 0.6, 1.0)))), 1.45);
      vColor *= surfaceLight;
    }
    #ifdef TRAIL
      if (petalActive) vColor = mix(vColor, uOriginalColor > 0.5 ? aColor : uColor, 0.7);
    #endif
    vShimmer = 0.82 + 0.18 * aSeed.z;
    vSpark = step(1.0 - uSparkle * 0.035, aSeed.z);
    vVisibility = visibility;
    vSeed = aSeed;
    vHistory = history;
    vTrailAlpha = smoothstep(0.005, 0.18, uProgress) *
                  pow(max(0.0, 1.0 - history), 1.15) * uTrail *
                  mix(0.28, 1.0, step(0.8, aSeed.z));
    if (petalActive) {
      vTrailAlpha = smoothstep(0.03, 0.2, vLocalAge) *
        pow(max(0.0, 1.0 - history), 1.1) * uTrail * (0.48 + aSeed.z * 0.52) * tailBirth;
    }
    vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float perspectiveSize = clamp(5.7 / max(0.25, -viewPosition.z), 0.28, 5.0);
    vDistanceFade = clamp(sqrt(perspectiveSize), 0.4, 1.2) * uDensityOpacity;
    gl_PointSize = max(1.0, uSize * perspectiveSize * mix(0.9, 1.55, vSpark) * (1.0 + uGlow * 0.3));
    if (uSurfaceMode > 0.5) gl_PointSize = max(0.85, uSize * perspectiveSize * (0.92 + aSeed.z * 0.13) * mix(1.0, 1.14, vSpark));
    #ifdef AMBIENT
      gl_PointSize = max(0.9, uSize * perspectiveSize * (0.55 + aSeed.z * 0.45));
    #endif
    #ifdef PARTICLE_TRAIL
      gl_PointSize = max(0.9, uSize * perspectiveSize * (0.65 + aSeed.z * 0.4));
    #endif
    gl_PointSize *= max(1.0, uOutputScale);
  }
`;

export const particleFragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uProgress;
  uniform float uSurfaceMode;
  uniform float uPetalFlow;
  uniform float uMode;
  uniform float uOriginalColor;
  varying vec3 vColor;
  varying float vShimmer;
  varying float vVisibility;
  varying float vTrailAlpha;
  varying float vSpark;
  varying float vDistanceFade;
  varying float vLocalAge;
  varying vec3 vSeed;
  varying float vHistory;

  void main() {
    float petalWeight = uPetalFlow * step(4.5, uMode);
    float dissolve = mix(1.0, 1.0 - smoothstep(mix(0.78, 0.88, petalWeight), 1.0, uProgress), uFade);
    float alpha;
    #ifdef TRAIL
      #ifdef PARTICLE_TRAIL
        if (petalWeight < 0.5) discard;
        float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
        if (radius > 1.0) discard;
        float core = 1.0 - smoothstep(0.05, 0.98, radius);
        float endingProgress = mix(min(uProgress, 0.94), uProgress, uFade);
        // Each grain has an immutable lifetime; strands break into dots rather
        // than surviving as a graphic line after the source particles vanish.
        float grain = fract(sin(vHistory * 79.3 + vSeed.x * 311.7 + vSeed.y * 127.1) * 43758.5453);
        float death = 0.72 + grain * 0.31;
        float survival = mix(1.0, 1.0 - smoothstep(death - 0.04, death + 0.03, endingProgress), uFade);
        float retain = mix(1.0, 0.18, smoothstep(0.8, 0.985, endingProgress));
        float shortTail = 1.0 - smoothstep(retain - 0.1, retain + 0.08, vHistory);
        float density = mix(1.0, 0.4, smoothstep(0.45, 0.94, endingProgress));
        float broken = 1.0 - smoothstep(density - 0.1, density + 0.08, grain);
        broken = mix(1.0, broken, smoothstep(0.0, 0.08, vHistory));
        alpha = core * vTrailAlpha * uOpacity * dissolve * survival * shortTail *
                broken * smoothstep(0.01, 0.1, uProgress) * 0.8;
      #else
        if (petalWeight > 0.5) discard;
      alpha = vTrailAlpha * uOpacity * dissolve * mix(vVisibility, 1.0, petalWeight) * mix(0.42, 0.6, petalWeight);
      #endif
    #else
      float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
      if (radius > 1.0) discard;
      float core = 1.0 - smoothstep(0.04, 0.72, radius);
      float halo = pow(max(0.0, 1.0 - radius), 3.0) * uGlow * 0.08;
      float edge = 1.0 - smoothstep(0.87, 1.0, radius);
      alpha = (core * 0.61 + halo) * edge * uOpacity * vShimmer * dissolve * vVisibility;
      if (uSurfaceMode > 0.5) {
        alpha = (1.0 - smoothstep(0.52, 0.99, radius)) * uOpacity * dissolve * vVisibility;
        #ifndef AMBIENT
          if (petalWeight > 0.5) {
            float endingProgress = mix(min(uProgress, 0.94), uProgress, uFade);
            float localProgress = endingProgress * mix(0.65, 1.0, vLocalAge);
            float death = 0.68 + vSeed.x * 0.36;
            float survival = mix(1.0, 1.0 - smoothstep(death - 0.045, death + 0.035, localProgress), uFade);
            alpha *= survival;
            if (alpha < 0.002) discard;
          } else if (alpha < 0.075) discard;
        #endif
      }
    #endif
    if (alpha < 0.001) discard;
    alpha *= mix(vDistanceFade, clamp(vDistanceFade / max(0.22, vDistanceFade), 0.65, 1.0), uSurfaceMode);
    // Emit unclamped linear HDR; the final OutputPass alone performs tone
    // mapping and sRGB encoding after the real bloom convolution.
    float energy = mix(1.1 + vSpark * 8.0, 1.08 + vSpark * 1.4, uSurfaceMode);
    #ifdef TRAIL
      if (petalWeight > 0.5) energy = 4.8;
      #ifdef PARTICLE_TRAIL
        energy = 4.8 + vSpark;
      #endif
    #else
      #ifndef AMBIENT
        if (uSurfaceMode > 0.5 && uOriginalColor > 0.5) energy = 1.22 + vSpark * 1.4;
      #endif
    #endif
    #ifdef AMBIENT
      energy = 1.25 + vSpark * 1.0;
      alpha *= 0.65;
    #endif
    gl_FragColor = vec4(vColor * energy, alpha);
  }
`;
