import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { advancePlayback, advanceTimelineTime, resumePlayback } from './playback';
import type { PlaybackMode, PlaybackState } from './playback';
import { createSphereAsset } from './assets';
import type { ParticleAsset } from './assets';
import { DEFAULT_CLIP, normalizeClip, sampleClip } from './animation';
import type { AnimationClip, AnimationSample } from './animation';
import { particleVertexShader, particleFragmentShader } from './shaders';

export type Effect = 'radial' | 'noise' | 'vortex' | 'directional' | 'wave' | 'erosion';
export type { PlaybackMode } from './playback';
export type FlowDirection = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

export interface ParticleParams {
  count: number;
  size: number;
  color: string;
  colorMode: 'original' | 'uniform';
  opacity: number;
  spread: number;
  turbulence: number;
  depth: number;
  scatter: number;
  stagger: number;
  motionSpeed: number;
  duration: number;
  playbackRate: number;
  glow: number;
  fade: boolean;
  autoRotate: boolean;
  rotationSpeed: number;
  axis: 'x' | 'y' | 'z';
  erosion: number;
  flowScale: number;
  stringiness: number;
  trail: number;
  direction: FlowDirection;
  waveRhythm: number;
}

export const DEFAULT_PARAMS: ParticleParams = {
  count: 30_000, size: 2, color: '#b6a4ff', colorMode: 'uniform', opacity: 0.9,
  spread: 2, turbulence: 0.15, motionSpeed: 1, duration: 3, playbackRate: 1,
  depth: 1.2, scatter: 0.65, stagger: 0.35,
  glow: 0.65, fade: false, autoRotate: false, rotationSpeed: 0.5, axis: 'y',
  erosion: 0.65, flowScale: 1.4, stringiness: 1, trail: 0.25, direction: 'x', waveRhythm: 1,
};

export interface EngineState extends PlaybackState {
  fps: number;
  actualCount: number;
  timelineTime: number;
  timelineDuration: number;
  timelineLoop: boolean;
  playbackSource: 'timeline' | 'free';
}

const MAX_PARTICLES = 100_000;
const MAX_TRAILS = 16_000;
const SPHERE_RADIUS = 1.35;
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const EFFECT_INDEX: Record<Effect, number> = {
  radial: 0, noise: 1, vortex: 2, directional: 3, wave: 4, erosion: 5,
};
const DIRECTION_VECTOR: Record<FlowDirection, [number, number, number]> = {
  x: [1, 0, 0], '-x': [-1, 0, 0], y: [0, 1, 0], '-y': [0, -1, 0], z: [0, 0, 1], '-z': [0, 0, -1],
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export class ParticleEngine {
  public readonly canvas: HTMLCanvasElement;
  public effect: Effect = 'radial';
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(43, 16 / 9, 0.01, 200);
  private readonly controls: OrbitControls;
  private readonly object = new THREE.Group();
  private geometry: THREE.BufferGeometry;
  private trailGeometry: THREE.InstancedBufferGeometry;
  private readonly points: THREE.Points;
  private readonly trails: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly resizeObserver: ResizeObserver;
  private readonly values: ParticleParams = { ...DEFAULT_PARAMS };
  private asset: ParticleAsset;
  private clip = normalizeClip(DEFAULT_CLIP);
  private timelineMode = true;
  private readonly progressLookup = new Float32Array(1025);
  private trailProgressVelocity = 0;
  private readonly current: EngineState = {
    progress: 0, running: true, mode: 'loop', direction: 1, time: 0, fps: 0,
    actualCount: DEFAULT_PARAMS.count, timelineTime: 0, timelineDuration: 6, timelineLoop: true, playbackSource: 'timeline',
  };
  private readonly onUpdate: (state: EngineState) => void;
  private readonly onError?: (message: string) => void;
  private requestId = 0;
  private lastFrame = 0;
  private lastUpdate = 0;
  private fpsStart = 0;
  private fpsFrames = 0;
  private interacting = false;
  private pendingEffect: Effect | null = null;
  private destroyed = false;
  private needsRendering = true;
  private captureActive = false;

  public constructor(
    private readonly container: HTMLElement,
    onUpdate: (state: EngineState) => void,
    onError?: (message: string) => void,
  ) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
      });
    } catch (error) {
      onError?.('无法创建 WebGL 画面，请检查浏览器的硬件加速设置。');
      throw error;
    }
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(OUTPUT_WIDTH, OUTPUT_HEIGHT, false);
    this.renderer.setClearColor('#000000', 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      this.onError?.('当前图形设备无法编译粒子效果。请尝试开启硬件加速，或使用最新版浏览器。');
      console.error('粒子着色器编译失败', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment));
    };
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '实时粒子预览；左键旋转，滚轮缩放，右键平移');
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.flexShrink = '0';
    this.canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    document.addEventListener('visibilitychange', this.visibilityChange);
    container.appendChild(this.canvas);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.rotateSpeed = 0.75;
    this.controls.zoomSpeed = 0.8;
    this.controls.panSpeed = 0.7;
    this.controls.minDistance = 0.7;
    this.controls.maxDistance = 100;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.addEventListener('start', this.interactionStart);
    this.controls.addEventListener('end', this.interactionEnd);
    this.resetView();

    this.asset = createSphereAsset();
    this.geometry = this.createGeometry(this.asset);
    this.trailGeometry = this.createTrailGeometry(this.asset);
    const uniforms = {
      uProgress: { value: 0 }, uTime: { value: 0 }, uSize: { value: this.values.size },
      uSpread: { value: this.values.spread }, uTurbulence: { value: this.values.turbulence },
      uDepth: { value: this.values.depth }, uScatter: { value: this.values.scatter },
      uStagger: { value: this.values.stagger }, uIsImage: { value: 0 },
      uGlow: { value: this.values.glow }, uMode: { value: 0 }, uAxis: { value: 1 },
      uColor: { value: new THREE.Color(this.values.color) }, uOriginalColor: { value: 0 },
      uOpacity: { value: this.values.opacity }, uFade: { value: 0 },
      uErosion: { value: this.values.erosion }, uFlowScale: { value: this.values.flowScale },
      uStringiness: { value: this.values.stringiness }, uTrail: { value: this.values.trail },
      uTrailTimeSpan: { value: 0 }, uTrailProgressSpan: { value: 0 },
      uDirection: { value: new THREE.Vector3(1, 0, 0) }, uWaveRhythm: { value: this.values.waveRhythm },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms, vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.trailMaterial = new THREE.ShaderMaterial({
      uniforms, defines: { TRAIL: 1 }, vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.trails = new THREE.LineSegments(this.trailGeometry, this.trailMaterial);
    this.points.frustumCulled = false;
    this.trails.frustumCulled = false;
    this.trails.renderOrder = -1;
    this.object.add(this.trails, this.points);
    this.scene.add(this.object);
    this.updateCount();
    this.rebuildProgressLookup();
    this.applyTimelineSample();
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    this.resize();
    this.scheduleFrame();
  }

  public get state(): EngineState { return { ...this.current, playbackSource: this.timelineMode ? 'timeline' : 'free' }; }
  public get params(): ParticleParams { return { ...this.values }; }
  public get currentSample(): AnimationSample {
    return {
      scale: this.object.scale.x,
      rotation: [this.object.rotation.x, this.object.rotation.y, this.object.rotation.z].map(THREE.MathUtils.radToDeg) as [number, number, number],
      progress: this.current.progress,
    };
  }

  /** Construct both new GPU geometries before disposing the previous valid asset. */
  public setAsset(asset: ParticleAsset): void {
    const count = Math.floor(asset.count);
    if (!(count > 0) || count > MAX_PARTICLES ||
        asset.positions.length < count * 3 || asset.colors.length < count * 3 || asset.seeds.length < count * 3) {
      throw new Error('素材没有有效的粒子采样数据，原有场景已保留。');
    }
    for (let i = 0; i < count * 3; i++) {
      if (!Number.isFinite(asset.positions[i]) || !Number.isFinite(asset.colors[i]) || !Number.isFinite(asset.seeds[i])) {
        throw new Error('素材包含无效的粒子数据，原有场景已保留。');
      }
    }
    const geometry = this.createGeometry(asset);
    let trailGeometry: THREE.InstancedBufferGeometry;
    try { trailGeometry = this.createTrailGeometry(asset); }
    catch (error) { geometry.dispose(); throw error; }
    const oldGeometry = this.geometry;
    const oldTrailGeometry = this.trailGeometry;
    this.asset = asset;
    this.geometry = geometry;
    this.trailGeometry = trailGeometry;
    this.points.geometry = geometry;
    this.trails.geometry = trailGeometry;
    this.updateCount();
    this.syncUniforms();
    oldGeometry.dispose();
    oldTrailGeometry.dispose();
    this.emit();
  }

  public setParams(partial: Partial<ParticleParams>): void {
    const ranges: Partial<Record<keyof ParticleParams, [number, number]>> = {
      count: [1000, MAX_PARTICLES], size: [0.5, 8], opacity: [0, 1], spread: [0, 5],
      turbulence: [0, 1], motionSpeed: [0, 3], duration: [0.5, 20], playbackRate: [0.25, 4],
      glow: [0, 2], rotationSpeed: [0, 3], erosion: [0, 1], flowScale: [0.3, 5],
      stringiness: [0, 3], trail: [0, 1], waveRhythm: [0.3, 3],
      depth: [0, 3], scatter: [0, 1], stagger: [0, 1],
    };
    for (const [key, range] of Object.entries(ranges)) {
      const value = partial[key as keyof ParticleParams];
      if (typeof value === 'number' && Number.isFinite(value)) {
        const normalized = clamp(value, range[0], range[1]);
        (this.values as unknown as Record<string, unknown>)[key] = key === 'count' ? Math.round(normalized) : normalized;
      }
    }
    if (partial.color && /^#[0-9a-fA-F]{6}$/.test(partial.color)) this.values.color = partial.color;
    if (partial.colorMode === 'original' || partial.colorMode === 'uniform') this.values.colorMode = partial.colorMode;
    if (typeof partial.fade === 'boolean') this.values.fade = partial.fade;
    if (typeof partial.autoRotate === 'boolean') this.values.autoRotate = partial.autoRotate;
    if (partial.axis === 'x' || partial.axis === 'y' || partial.axis === 'z') this.values.axis = partial.axis;
    if (partial.direction && Object.prototype.hasOwnProperty.call(DIRECTION_VECTOR, partial.direction)) this.values.direction = partial.direction;
    this.updateCount();
    this.syncUniforms();
    this.emit();
  }

  public setTimeline(clip: AnimationClip): void {
    this.clip = normalizeClip(clip);
    this.current.timelineDuration = this.clip.duration;
    this.current.timelineTime = clamp(this.current.timelineTime, 0, this.clip.duration);
    this.rebuildProgressLookup();
    if (this.timelineMode) this.applyTimelineSample();
    this.emit();
  }

  public seekTimeline(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    this.pendingEffect = null;
    this.timelineMode = true;
    this.current.timelineTime = clamp(seconds, 0, this.clip.duration);
    this.current.running = false;
    this.current.mode = this.current.timelineLoop ? 'loop' : 'idle';
    this.trailProgressVelocity = 0;
    this.applyTimelineSample();
    this.emit();
  }

  public setTimelinePlaying(playing: boolean): void {
    this.pendingEffect = null;
    this.timelineMode = true;
    if (playing && this.current.timelineTime >= this.clip.duration) this.current.timelineTime = 0;
    this.current.running = playing;
    this.current.mode = this.current.timelineLoop ? 'loop' : 'disperse';
    this.applyTimelineSample();
    this.emit();
  }

  public setTimelineLoop(loop: boolean): void {
    this.current.timelineLoop = loop;
    if (this.timelineMode) this.current.mode = loop ? 'loop' : 'disperse';
    this.emit();
  }

  public setProgress(value: number): void {
    if (!Number.isFinite(value)) return;
    this.pendingEffect = null;
    this.timelineMode = false;
    this.current.progress = clamp(value, 0, 1);
    this.current.timelineTime = this.closestProgressTime(this.current.progress);
    this.current.running = false;
    this.trailProgressVelocity = 0;
    this.emit();
  }

  public command(mode: PlaybackMode): void {
    this.pendingEffect = null;
    this.timelineMode = false;
    this.current.mode = mode;
    if (mode === 'disperse') {
      this.current.direction = 1;
      this.current.running = this.current.progress < 1;
    } else if (mode === 'assemble') {
      this.current.direction = -1;
      this.current.running = this.current.progress > 0;
    } else if (mode === 'loop') {
      if (this.current.progress === 0) this.current.direction = 1;
      if (this.current.progress === 1) this.current.direction = -1;
      this.current.running = true;
    } else this.current.running = false;
    if (!this.current.running && mode !== 'idle') this.synchronizeLegacyEndpoint();
    this.emit();
  }

  public togglePause(): void {
    if (this.timelineMode) { this.setTimelinePlaying(!this.current.running); return; }
    if (this.current.running) this.current.running = false;
    else Object.assign(this.current, resumePlayback(this.current));
    this.emit();
  }

  /** Recorder hook: restore the exact task, without restarting at an endpoint. */
  public setRunning(running: boolean): void { this.current.running = running; this.emit(); }

  /** Keep static frames flowing to captureStream while a recording is active. */
  public setCaptureActive(active: boolean): void {
    if (this.captureActive === active) return;
    this.captureActive = active;
    this.needsRendering = true;
    this.syncVisibility();
  }

  public setEffect(effect: Effect): void {
    if (!Object.prototype.hasOwnProperty.call(EFFECT_INDEX, effect)) return;
    if (effect === this.effect && this.pendingEffect === null) return;
    this.timelineMode = false;
    if (this.current.progress > 0.00001) {
      this.pendingEffect = effect;
      this.current.mode = 'assemble';
      this.current.direction = -1;
      this.current.running = true;
    } else {
      this.current.progress = 0;
      this.current.timelineTime = 0;
      this.applyEffect(effect);
      this.current.mode = 'idle';
      this.current.running = false;
    }
    this.emit();
  }

  public resetView(): void {
    const autoRotate = this.controls.autoRotate;
    this.controls.autoRotate = false;
    this.controls.enableDamping = false;
    this.controls.update(0);
    this.camera.position.set(0, 0.08, 5.7);
    this.controls.target.set(0, 0, 0);
    this.controls.saveState();
    this.controls.reset();
    this.controls.update(0);
    this.controls.enableDamping = true;
    this.controls.autoRotate = autoRotate;
    this.needsRendering = true;
  }

  public fitView(): void {
    const amount = this.current.progress ** 2 * (3 - 2 * this.current.progress);
    const multiplier = this.effect === 'erosion' ? 2.5 + this.values.stringiness * 0.4 : 1.8;
    const radius = SPHERE_RADIUS * this.object.scale.x *
      (1 + this.values.spread * amount * multiplier + this.values.turbulence * amount * 1.8);
    const depthScale = Math.max(1, this.values.depth);
    const distance = radius * depthScale / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(direction.multiplyScalar(Math.min(distance, this.controls.maxDistance)));
    this.controls.update(0);
    this.needsRendering = true;
  }

  public screenshot(): Promise<Blob> {
    this.render();
    return new Promise((resolve, reject) => this.canvas.toBlob((blob) => {
      if (blob) resolve(blob); else reject(new Error('截图生成失败，请重试。'));
    }, 'image/png'));
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.requestId);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('start', this.interactionStart);
    this.controls.removeEventListener('end', this.interactionEnd);
    this.controls.dispose();
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    document.removeEventListener('visibilitychange', this.visibilityChange);
    this.geometry.dispose();
    this.trailGeometry.dispose();
    this.material.dispose();
    this.trailMaterial.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private createGeometry(asset: ParticleAsset): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(asset.positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(asset.seeds, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(asset.colors, 3));
    geometry.setDrawRange(0, Math.min(this.values.count, asset.count));
    return geometry;
  }

  private createTrailGeometry(asset: ParticleAsset): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    const path = new Float32Array(18);
    for (let segment = 0; segment < 3; segment++) {
      path[segment * 6] = segment / 3;
      path[segment * 6 + 3] = (segment + 1) / 3;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(path, 3));
    geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(asset.positions, 3));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(asset.seeds, 3));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(asset.colors, 3));
    geometry.instanceCount = Math.min(this.values.count, asset.count, this.trailBudget());
    return geometry;
  }

  private updateCount(): void {
    this.current.actualCount = Math.min(this.values.count, this.asset.count);
    this.geometry.setDrawRange(0, this.current.actualCount);
    this.trailGeometry.instanceCount = Math.min(this.current.actualCount, this.trailBudget());
  }

  private trailBudget(): number { return this.values.count >= 60_000 ? 12_000 : MAX_TRAILS; }

  private syncUniforms(): void {
    const u = this.material.uniforms;
    u.uSize.value = this.values.size;
    u.uSpread.value = this.values.spread;
    u.uTurbulence.value = this.values.turbulence;
    u.uDepth.value = this.values.depth;
    u.uScatter.value = this.values.scatter;
    u.uStagger.value = this.values.stagger;
    u.uIsImage.value = this.asset.kind === 'image' ? 1 : 0;
    u.uGlow.value = this.values.glow;
    u.uColor.value.set(this.values.color);
    u.uOriginalColor.value = this.values.colorMode === 'original' && this.asset.hasOriginalColors ? 1 : 0;
    u.uOpacity.value = this.values.opacity;
    u.uFade.value = this.values.fade ? 1 : 0;
    u.uAxis.value = { x: 0, y: 1, z: 2 }[this.values.axis];
    u.uErosion.value = this.values.erosion;
    u.uFlowScale.value = this.values.flowScale;
    u.uStringiness.value = this.values.stringiness;
    u.uTrail.value = this.values.trail;
    u.uWaveRhythm.value = this.values.waveRhythm;
    u.uDirection.value.set(...DIRECTION_VECTOR[this.values.direction]);
  }

  private rebuildProgressLookup(): void {
    for (let i = 0; i < this.progressLookup.length; i++) {
      this.progressLookup[i] = sampleClip(this.clip, i / (this.progressLookup.length - 1) * this.clip.duration).progress;
    }
  }

  private closestProgressTime(progress: number): number {
    let bestTime = this.current.timelineTime;
    let bestError = Infinity;
    let bestDistance = Infinity;
    const consider = (candidate: number, value: number) => {
      const error = Math.abs(value - progress);
      const distance = Math.abs(candidate - this.current.timelineTime);
      if (error < bestError - 1e-7 || (Math.abs(error - bestError) <= 1e-7 && distance < bestDistance)) {
        bestError = error; bestDistance = distance; bestTime = candidate;
      }
    };
    const denominator = this.progressLookup.length - 1;
    for (let i = 0; i < this.progressLookup.length; i++) consider(i / denominator * this.clip.duration, this.progressLookup[i]);
    for (const frame of this.clip.keyframes) consider(frame.time, frame.progress);
    let left = Math.max(0, bestTime - this.clip.duration / denominator);
    let right = Math.min(this.clip.duration, bestTime + this.clip.duration / denominator);
    const from = sampleClip(this.clip, left).progress;
    const to = sampleClip(this.clip, right).progress;
    if (Math.abs(from - to) > 1e-9 && progress >= Math.min(from, to) && progress <= Math.max(from, to)) {
      for (let i = 0; i < 24; i++) {
        const middle = (left + right) / 2;
        const value = sampleClip(this.clip, middle).progress;
        if ((to > from && value < progress) || (to < from && value > progress)) left = middle;
        else right = middle;
      }
      bestTime = (left + right) / 2;
    }
    return bestTime;
  }

  private applyTimelineSample(): void {
    const sample = sampleClip(this.clip, this.current.timelineTime);
    this.current.progress = sample.progress;
    this.object.scale.setScalar(sample.scale);
    this.object.rotation.set(...sample.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]);
  }

  private synchronizeLegacyEndpoint(): void {
    this.current.timelineTime = this.current.progress >= 1 ? this.clip.duration / 2 : 0;
  }

  private applyEffect(effect: Effect): void {
    this.pendingEffect = null;
    this.effect = effect;
    this.material.uniforms.uMode.value = EFFECT_INDEX[effect];
  }

  private emit(invalidate = true): void {
    if (invalidate) this.needsRendering = true;
    if (!this.destroyed) this.onUpdate(this.state);
  }

  private scheduleFrame(): void {
    if (!this.destroyed && !this.requestId && (!document.hidden || this.captureActive)) {
      this.requestId = requestAnimationFrame(this.frame);
    }
  }

  private readonly visibilityChange = (): void => { this.syncVisibility(); };

  private syncVisibility(): void {
    this.lastFrame = 0;
    this.fpsStart = 0;
    this.fpsFrames = 0;
    if (document.hidden && !this.captureActive) {
      cancelAnimationFrame(this.requestId);
      this.requestId = 0;
      this.current.fps = 0;
      this.emit(false);
    } else {
      this.needsRendering = true;
      this.scheduleFrame();
    }
  }
  private readonly preventContextMenu = (event: Event): void => event.preventDefault();
  private readonly contextLost = (event: Event): void => {
    event.preventDefault();
    this.current.running = false;
    this.onError?.('图形设备暂时不可用。请刷新页面重新创建粒子画面。');
  };
  private readonly interactionStart = (): void => { this.interacting = true; };
  private readonly interactionEnd = (): void => { this.interacting = false; };
  private readonly resize = (): void => {
    if (this.destroyed) return;
    const width = Math.max(1, Math.min(this.container.clientWidth, this.container.clientHeight * 16 / 9));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${width * 9 / 16}px`;
    // Capture pixels remain exactly 1280 × 720 through resizing/fullscreen.
  };

  private render(): void {
    const u = this.material.uniforms;
    u.uProgress.value = this.current.progress;
    u.uTime.value = this.current.time;
    const span = this.values.trail * (0.3 + this.values.stringiness * 0.4);
    u.uTrailTimeSpan.value = span * this.values.motionSpeed;
    u.uTrailProgressSpan.value = this.trailProgressVelocity * span;
    this.trails.visible = this.values.trail > 0 && this.current.progress > 0.00001;
    this.points.visible = !(this.values.fade && this.current.progress >= 1);
    this.trails.visible &&= this.points.visible && (u.uTrailTimeSpan.value > 0 || Math.abs(u.uTrailProgressSpan.value) > 0);
    this.renderer.render(this.scene, this.camera);
    this.needsRendering = false;
  }

  private readonly frame = (now: number): void => {
    this.requestId = 0;
    if (this.destroyed) return;
    this.tick(now);
    this.scheduleFrame();
  };

  private tick(now: number): void {
    if (this.destroyed) return;
    const dt = this.lastFrame ? Math.max(0, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (this.current.running) {
      this.needsRendering = true;
      const previousProgress = this.current.progress;
      if (this.timelineMode) {
        this.current.time += dt * this.values.motionSpeed;
        const next = advanceTimelineTime(this.current.timelineTime, dt, this.clip.duration, this.values.playbackRate, this.current.timelineLoop);
        this.current.timelineTime = next.time;
        this.applyTimelineSample();
        if (next.completed) this.current.running = false;
      } else {
        Object.assign(this.current, advancePlayback(this.current, dt, this.values));
        if (!this.current.running) {
          this.synchronizeLegacyEndpoint();
          if (this.current.progress === 0 && this.pendingEffect) {
            this.applyEffect(this.pendingEffect);
            this.current.mode = 'idle';
          }
        } else this.current.timelineTime = this.closestProgressTime(this.current.progress);
      }
      if (dt > 0) {
        const velocity = (this.current.progress - previousProgress) / dt;
        this.trailProgressVelocity = clamp(velocity, -2, 2);
        // The folded legacy integrator owns its endpoint direction. A frame that
        // crosses an endpoint can have a net delta opposite to its new direction.
        if (this.timelineMode && Math.abs(velocity) > 0.000001) this.current.direction = velocity >= 0 ? 1 : -1;
      }
    }
    this.controls.autoRotate = this.values.autoRotate && !this.interacting;
    this.controls.autoRotateSpeed = this.values.rotationSpeed;
    const cameraChanged = this.controls.update(dt);
    if (this.needsRendering || this.current.running || this.captureActive || cameraChanged) {
      this.render();
      this.fpsFrames++;
    }
    if (!this.fpsStart) this.fpsStart = now;
    if (now - this.fpsStart >= 1000) {
      this.current.fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsStart));
      this.fpsFrames = 0;
      this.fpsStart = now;
    }
    if (now - this.lastUpdate >= 100) { this.emit(false); this.lastUpdate = now; }
  }
}
