import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { advancePlayback, advanceTimelineTime, resumePlayback } from './playback';
import type { PlaybackMode, PlaybackState } from './playback';
import { createSphereAsset } from './assets';
import type { ParticleAsset } from './assets';
import { DEFAULT_CLIP, normalizeClip } from './animation';
import type { AnimationClip, AnimationSample } from './animation';
import { particleVertexShader, particleFragmentShader } from './shaders';
import { ParticlePostProcessing } from './ParticlePostProcessing';
import { AdaptiveQualityController } from './adaptiveQuality';
import { MAX_PARTICLES, DEFAULT_PARTICLE_COUNT } from './particleLimits';
import { layerBudgets, ambientPhase, motionTime } from './particleLayers';

export type Effect = 'radial' | 'noise' | 'vortex' | 'directional' | 'wave' | 'erosion';
export type { PlaybackMode } from './playback';
export type PreviewQuality = 'smooth' | 'sharp';
export interface OfflineExportSession {
  canvas: HTMLCanvasElement;
  duration: number;
  renderFrame(timeSeconds: number): void;
  restore(): void;
}
export type FlowDirection = 'x' | '-x' | 'y' | '-y' | 'z' | '-z';

export interface ParticleParams {
  count: number;
  autoCount: boolean;
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
  exposure: number;
  contrast: number;
  curl: number;
  sparkle: number;
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
  surfaceMode: boolean;
  petalFlow: boolean;
  grainStyle: boolean;
  ambient: number;
  ambientRange: number;
  ambientSpeed: number;
  resolution: '720p' | '1080p';
}

export const DEFAULT_PARAMS: ParticleParams = {
  count: 300_000, autoCount: true, size: 2, color: '#b6a4ff', colorMode: 'uniform', opacity: 0.9,
  spread: 2, turbulence: 0.15, motionSpeed: 1, duration: 3, playbackRate: 1,
  depth: 1.2, scatter: 0.65, stagger: 0.35,
  glow: 0.65, fade: false, autoRotate: false, rotationSpeed: 0.5, axis: 'y',
  erosion: 0.65, flowScale: 1.4, stringiness: 1, trail: 0.25, direction: 'x', waveRhythm: 1,
  exposure: 1.3, contrast: 1, curl: 1.2, sparkle: 0.35,
  surfaceMode: false, petalFlow: false, grainStyle: false, ambient: 0.02, ambientRange: 0.3, ambientSpeed: 0.5, resolution: '720p',
};

export interface EngineState extends PlaybackState {
  fps: number;
  actualCount: number;
  timelineTime: number;
  timelineDuration: number;
  timelineLoop: boolean;
  playbackSource: 'timeline' | 'free';
  adaptiveStatus: string;
  adaptiveCeiling: number;
  frameMsAvg: number;
  ambientCount: number;
  filamentCount: number;
}

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
  private particleTrailGeometry: THREE.InstancedBufferGeometry;
  private ambientGeometry: THREE.BufferGeometry;
  private readonly points: THREE.Points;
  private readonly trails: THREE.LineSegments;
  private readonly particleTrails: THREE.Points;
  private readonly ambientPoints: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly particleTrailMaterial: THREE.ShaderMaterial;
  private readonly ambientMaterial: THREE.ShaderMaterial;
  private readonly postProcessing: ParticlePostProcessing;
  private readonly resizeObserver: ResizeObserver;
  private readonly values: ParticleParams = { ...DEFAULT_PARAMS };
  private asset: ParticleAsset;
  private clip = normalizeClip(DEFAULT_CLIP);
  private timelineMode = true;
  private readonly progressLookup = new Float32Array(1025);
  private progressTexture?: THREE.DataTexture;
  private ambientClock = 0;
  private trailProgressVelocity = 0;
  private readonly current: EngineState = {
    progress: 0, running: true, mode: 'loop', direction: 1, time: 0, fps: 0,
    actualCount: DEFAULT_PARTICLE_COUNT, timelineTime: 0, timelineDuration: 6, timelineLoop: true, playbackSource: 'timeline',
    adaptiveStatus: '等待有效运动采样', adaptiveCeiling: DEFAULT_PARAMS.count, frameMsAvg: 0,
    ambientCount: 0, filamentCount: 0,
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
  private cameraDirty = false;
  private captureActive = false;
  private recordingLocked = false;
  private adaptive: AdaptiveQualityController | null = null;
  private activeCount = DEFAULT_PARTICLE_COUNT;
  private adaptiveWarmupPending = true;
  private adaptiveWarmupReason = '图形首次编译预热，暂不判断设备性能';
  private renderedTrails = false;
  private renderedParticleTrails = false;
  private renderedBloom = false;
  private pageHidden = typeof document !== 'undefined' && document.hidden;
  private previewQuality: PreviewQuality = 'smooth';
  private captureSize: { width: number; height: number } | null = null;
  private renderWidth = OUTPUT_WIDTH;
  private renderHeight = OUTPUT_HEIGHT;
  private offlineActive = false;
  private graphicsLost = false;
  private offlineRestore: (() => void) | null = null;

  public constructor(
    private readonly container: HTMLElement,
    onUpdate: (state: EngineState) => void,
    onError?: (message: string) => void,
  ) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
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
    this.controls.addEventListener('change', this.controlsChange);
    this.resetView();

    this.asset = createSphereAsset();
    this.geometry = this.createGeometry(this.asset);
    this.trailGeometry = this.createTrailGeometry(this.asset, this.geometry);
    this.particleTrailGeometry = this.createParticleTrailGeometry(this.trailGeometry);
    this.ambientGeometry = this.createAmbientGeometry(this.asset, this.geometry);
    this.rebuildProgressLookup();
    const uniforms = {
      uProgress: { value: 0 }, uTime: { value: 0 }, uSize: { value: this.values.size },
      uSpread: { value: this.values.spread }, uTurbulence: { value: this.values.turbulence },
      uDepth: { value: this.values.depth }, uScatter: { value: this.values.scatter },
      uStagger: { value: this.values.stagger }, uIsImage: { value: 0 },
      uGlow: { value: this.values.glow }, uMode: { value: 0 }, uAxis: { value: 1 },
      uCurl: { value: this.values.curl }, uSparkle: { value: this.values.sparkle },
      uDensityOpacity: { value: 1 }, uGrainStyle: { value: 0 },
      uColor: { value: new THREE.Color(this.values.color) }, uOriginalColor: { value: 0 },
      uOpacity: { value: this.values.opacity }, uFade: { value: 0 },
      uErosion: { value: this.values.erosion }, uFlowScale: { value: this.values.flowScale },
      uStringiness: { value: this.values.stringiness }, uTrail: { value: this.values.trail },
      uTrailTimeSpan: { value: 0 }, uTrailProgressSpan: { value: 0 },
      uDirection: { value: new THREE.Vector3(1, 0, 0) }, uWaveRhythm: { value: this.values.waveRhythm },
      uSurfaceMode: { value: 0 }, uPetalFlow: { value: 0 },
      uAmbientPhase: { value: 0 }, uAmbientRange: { value: this.values.ambientRange },
      uTimelineActive: { value: 1 }, uTimelineTime: { value: 0 }, uTimelineDuration: { value: this.clip.duration },
      uMotionSpeed: { value: this.values.motionSpeed }, uProgressHistory: { value: this.progressTexture },
      uOutputScale: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms, vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.trailMaterial = new THREE.ShaderMaterial({
      uniforms, defines: { TRAIL: 1 }, vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.particleTrailMaterial = new THREE.ShaderMaterial({
      uniforms, defines: { TRAIL: 1, PARTICLE_TRAIL: 1 }, vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.ambientMaterial = new THREE.ShaderMaterial({
      uniforms, defines: { AMBIENT: 1 }, vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.trails = new THREE.LineSegments(this.trailGeometry, this.trailMaterial);
    this.particleTrails = new THREE.Points(this.particleTrailGeometry, this.particleTrailMaterial);
    this.ambientPoints = new THREE.Points(this.ambientGeometry, this.ambientMaterial);
    this.points.frustumCulled = false;
    this.trails.frustumCulled = false;
    this.particleTrails.frustumCulled = false;
    this.ambientPoints.frustumCulled = false;
    this.points.renderOrder = 0;
    this.trails.renderOrder = 1;
    this.particleTrails.renderOrder = 1;
    this.ambientPoints.renderOrder = 2;
    this.object.add(this.points, this.trails, this.particleTrails, this.ambientPoints);
    this.scene.add(this.object);
    this.postProcessing = new ParticlePostProcessing(this.renderer, this.scene, this.camera);
    this.postProcessing.configure(this.values.glow, this.values.exposure, this.values.contrast, this.values.surfaceMode);
    this.synchronizeAdaptive(true);
    this.requestAdaptiveWarmup('图形首次编译预热，暂不判断设备性能');
    this.updateCount();
    this.applyTimelineSample();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.scheduleFrame();
  }

  public get state(): EngineState { return { ...this.current, playbackSource: this.timelineMode ? 'timeline' : 'free' }; }
  public get params(): ParticleParams { return { ...this.values }; }
  public get outputSize(): { width: number; height: number } {
    return { width: this.renderWidth, height: this.renderHeight };
  }

  public setPreviewQuality(quality: PreviewQuality): void {
    if (quality !== 'smooth' && quality !== 'sharp') return;
    this.previewQuality = quality;
    this.resize();
  }

  /** Capture dimensions stay stable when the preview panel or fullscreen changes. */
  public setCaptureSize(width: number, height: number): void;
  public setCaptureSize(size: null): void;
  public setCaptureSize(width: number | null, height?: number): void {
    if (this.offlineActive) return;
    if (width === null) this.captureSize = null;
    else {
      this.validateOutputSize(width, height ?? 0);
      this.captureSize = { width: Math.round(width), height: Math.round(height!) };
    }
    this.resize();
  }

  /** An exact offline clock produces every output frame at the selected density. */
  public beginOfflineExport(width: number, height: number, fps: number): OfflineExportSession {
    if (this.destroyed) throw new Error('粒子画面已关闭，请重新打开后导出。');
    if (this.graphicsLost) throw new Error('图形设备中断了画面渲染，请刷新后再导出。');
    if (this.offlineActive || this.recordingLocked || this.captureActive) throw new Error('已有视频正在录制或导出，请等待完成。');
    this.validateOutputSize(width, height);
    if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('导出帧率必须在 1–120 FPS 之间。');
    const saved = {
      state: { ...this.current }, timelineMode: this.timelineMode, pendingEffect: this.pendingEffect,
      rotation: this.object.rotation.clone(), scale: this.object.scale.clone(),
      position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(),
      target: this.controls.target.clone(), zoom: this.camera.zoom,
      controlsEnabled: this.controls.enabled, autoRotate: this.controls.autoRotate,
      captureActive: this.captureActive, recordingLocked: this.recordingLocked,
      width: this.renderWidth, height: this.renderHeight,
      trailVelocity: this.trailProgressVelocity, ambientClock: this.ambientClock,
      activeCount: this.activeCount, adaptive: this.adaptive,
      adaptiveWarmupPending: this.adaptiveWarmupPending, adaptiveWarmupReason: this.adaptiveWarmupReason,
      renderedTrails: this.renderedTrails, renderedParticleTrails: this.renderedParticleTrails, renderedBloom: this.renderedBloom,
      cameraDirty: this.cameraDirty,
    };
    const rate = this.values.playbackRate;
    const duration = this.clip.duration / rate;
    const autoRotate = this.values.autoRotate;
    const rotationSpeed = this.values.rotationSpeed;
    const baseOffset = saved.position.clone().sub(saved.target);
    const rotationAxis = this.camera.up.clone().normalize();
    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      this.offlineRestore = null;
      this.timelineMode = saved.timelineMode;
      this.pendingEffect = saved.pendingEffect;
      this.object.rotation.copy(saved.rotation);
      this.object.scale.copy(saved.scale);
      this.camera.position.copy(saved.position);
      this.camera.quaternion.copy(saved.quaternion);
      this.camera.zoom = saved.zoom;
      this.controls.target.copy(saved.target);
      this.controls.enabled = saved.controlsEnabled;
      this.controls.autoRotate = saved.autoRotate;
      this.captureActive = saved.captureActive;
      this.recordingLocked = saved.recordingLocked;
      this.trailProgressVelocity = saved.trailVelocity;
      this.ambientClock = saved.ambientClock;
      this.activeCount = saved.activeCount;
      Object.assign(this.current, saved.state);
      this.updateCount();
      this.offlineActive = false;
      this.lastFrame = 0;
      this.lastUpdate = 0;
      this.fpsStart = 0;
      this.fpsFrames = 0;
      if (!this.destroyed && !this.graphicsLost) {
        this.setRenderSize(saved.width, saved.height);
        this.render();
      }
      // Preview timings never include the export's renders or shader warmup.
      this.adaptiveWarmupPending = saved.adaptiveWarmupPending;
      this.adaptiveWarmupReason = saved.adaptiveWarmupReason;
      this.renderedTrails = saved.renderedTrails;
      this.renderedParticleTrails = saved.renderedParticleTrails;
      this.renderedBloom = saved.renderedBloom;
      this.cameraDirty = saved.cameraDirty;
      this.adaptive = saved.adaptive;
      Object.assign(this.current, saved.state);
      if (this.graphicsLost) this.current.running = false;
      if (!this.destroyed) { this.emit(false); this.scheduleFrame(); }
    };
    this.offlineActive = true;
    this.offlineRestore = restore;
    cancelAnimationFrame(this.requestId);
    this.requestId = 0;
    this.controls.enabled = false;
    this.controls.autoRotate = false;
    this.current.running = false;
    this.timelineMode = true;
    this.recordingLocked = true;
    // A slow GPU changes processing time, never export density or frame rate.
    this.adaptive = new AdaptiveQualityController();
    this.adaptive.reset(this.asset.count, this.values.count, this.values.count);
    this.adaptive.freeze('逐帧导出期间固定完整粒子数量');
    this.activeCount = Math.min(this.values.count, this.asset.count);
    this.updateCount();
    this.current.adaptiveStatus = '逐帧导出期间固定完整粒子数量';
    try { this.setRenderSize(Math.round(width), Math.round(height)); }
    catch (error) { restore(); throw error; }
    return {
      canvas: this.canvas, duration,
      renderFrame: (timeSeconds: number): void => {
        if (restored || this.destroyed) throw new Error('导出会话已结束。');
        if (this.graphicsLost) throw new Error('图形设备中断了画面渲染，请刷新后降低分辨率再导出。');
        if (!Number.isFinite(timeSeconds)) throw new Error('导出帧时间无效。');
        const elapsed = clamp(timeSeconds, 0, duration);
        this.current.timelineTime = clamp(elapsed * rate, 0, this.clip.duration);
        this.applyTimelineSample();
        const halfStep = rate / fps / 2;
        const before = Math.max(0, this.current.timelineTime - halfStep);
        const after = Math.min(this.clip.duration, this.current.timelineTime + halfStep);
        this.trailProgressVelocity = after > before ? clamp(
          (this.sampleTimeline(after).progress - this.sampleTimeline(before).progress) * rate / (after - before), -2, 2,
        ) : 0;
        if (Math.abs(this.trailProgressVelocity) > 0.000001) this.current.direction = this.trailProgressVelocity > 0 ? 1 : -1;
        this.camera.position.copy(saved.position);
        this.camera.quaternion.copy(saved.quaternion);
        if (autoRotate) {
          this.camera.position.copy(baseOffset).applyAxisAngle(rotationAxis, -Math.PI * 2 / 60 * rotationSpeed * elapsed).add(saved.target);
          this.camera.lookAt(saved.target);
        }
        this.render();
      },
      restore,
    };
  }
  public get currentSample(): AnimationSample {
    return {
      scale: this.object.scale.x,
      rotation: [this.object.rotation.x, this.object.rotation.y, this.object.rotation.z].map(THREE.MathUtils.radToDeg) as [number, number, number],
      progress: this.current.progress,
    };
  }

  /** Construct both new GPU geometries before disposing the previous valid asset. */
  public setAsset(asset: ParticleAsset): void {
    if (this.offlineActive) return;
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
    let trailGeometry: THREE.InstancedBufferGeometry | undefined;
    let ambientGeometry: THREE.BufferGeometry;
    let particleTrailGeometry: THREE.InstancedBufferGeometry | undefined;
    try {
      trailGeometry = this.createTrailGeometry(asset, geometry);
      particleTrailGeometry = this.createParticleTrailGeometry(trailGeometry);
      ambientGeometry = this.createAmbientGeometry(asset, geometry);
    } catch (error) { geometry.dispose(); trailGeometry?.dispose(); particleTrailGeometry?.dispose(); throw error; }
    const oldGeometry = this.geometry;
    const oldTrailGeometry = this.trailGeometry;
    const oldParticleTrailGeometry = this.particleTrailGeometry;
    const oldAmbientGeometry = this.ambientGeometry;
    this.asset = asset;
    this.geometry = geometry;
    this.trailGeometry = trailGeometry;
    this.particleTrailGeometry = particleTrailGeometry;
    this.ambientGeometry = ambientGeometry;
    this.points.geometry = geometry;
    this.trails.geometry = trailGeometry;
    this.particleTrails.geometry = particleTrailGeometry;
    this.ambientPoints.geometry = ambientGeometry;
    this.updateTrailPath();
    this.synchronizeAdaptive(true);
    this.updateCount();
    this.syncUniforms();
    oldGeometry.dispose();
    oldTrailGeometry.dispose();
    oldParticleTrailGeometry.dispose();
    oldAmbientGeometry.dispose();
    this.emit();
  }

  public setParams(partial: Partial<ParticleParams>): void {
    if (this.offlineActive) return;
    const previous = { ...this.values };
    const ranges: Partial<Record<keyof ParticleParams, [number, number]>> = {
      count: [1000, MAX_PARTICLES], size: [0.5, 8], opacity: [0, 1], spread: [0, 5],
      turbulence: [0, 1], motionSpeed: [0, 3], duration: [0.5, 20], playbackRate: [0.25, 4],
      glow: [0, 2], rotationSpeed: [0, 3], erosion: [0, 1], flowScale: [0.3, 5],
      stringiness: [0, 3], trail: [0, 1], waveRhythm: [0.3, 3],
      depth: [0, 3], scatter: [0, 1], stagger: [0, 1],
      exposure: [0.3, 3], contrast: [0.5, 2], curl: [0, 3], sparkle: [0, 1],
      ambient: [0, 0.08], ambientRange: [0, 1], ambientSpeed: [0, 3],
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
    if (typeof partial.surfaceMode === 'boolean') this.values.surfaceMode = partial.surfaceMode;
    if (typeof partial.petalFlow === 'boolean') this.values.petalFlow = partial.petalFlow;
    if (typeof partial.grainStyle === 'boolean') this.values.grainStyle = partial.grainStyle;
    if ((partial.resolution === '720p' || partial.resolution === '1080p') && partial.resolution !== this.values.resolution) {
      if (this.recordingLocked || this.captureActive) this.onError?.('录制期间不能修改输出分辨率，请结束录制后再调整。');
      else this.values.resolution = partial.resolution;
    }
    const wasAuto = this.values.autoCount;
    if (typeof partial.autoCount === 'boolean') this.values.autoCount = partial.autoCount;
    if (partial.axis === 'x' || partial.axis === 'y' || partial.axis === 'z') this.values.axis = partial.axis;
    if (partial.direction && Object.prototype.hasOwnProperty.call(DIRECTION_VECTOR, partial.direction)) this.values.direction = partial.direction;
    const changed = Object.keys(this.values).some(key => this.values[key as keyof ParticleParams] !== previous[key as keyof ParticleParams]);
    if (!changed) return;
    const quantityChanged = previous.count !== this.values.count || wasAuto !== this.values.autoCount;
    const layersChanged = previous.surfaceMode !== this.values.surfaceMode || previous.petalFlow !== this.values.petalFlow ||
      previous.ambient !== this.values.ambient || previous.trail !== this.values.trail;
    if (quantityChanged) {
      this.synchronizeAdaptive(!wasAuto && this.values.autoCount);
    }
    if (quantityChanged || layersChanged) this.updateCount();
    if (previous.petalFlow !== this.values.petalFlow) this.updateTrailPath();
    if (previous.resolution !== this.values.resolution) {
      const [width, height] = this.values.resolution === '1080p' ? [1920, 1080] : [1280, 720];
      this.setRenderSize(width, height);
      this.requestAdaptiveWarmup('输出分辨率变更预热，重新判断粒子数量');
    }
    // Repeated settings sync, colour, exposure and playback controls do not
    // invalidate a valid performance window. Resample actual fill/blur changes.
    const fillChanged = previous.size !== this.values.size || previous.trail !== this.values.trail ||
      previous.stringiness !== this.values.stringiness || previous.sparkle !== this.values.sparkle ||
      (previous.glow > 0) !== (this.values.glow > 0) || previous.grainStyle !== this.values.grainStyle || layersChanged;
    if (fillChanged) this.adaptiveController().resetSamples();
    this.syncUniforms();
    if (this.timelineMode && (previous.motionSpeed !== this.values.motionSpeed || previous.ambientSpeed !== this.values.ambientSpeed)) {
      this.current.time = motionTime(this.current.timelineTime, this.values.motionSpeed);
      this.ambientClock = this.current.timelineTime;
    }
    this.emit();
  }

  public setTimeline(clip: AnimationClip): void {
    if (this.offlineActive) return;
    this.clip = normalizeClip(clip);
    this.current.timelineDuration = this.clip.duration;
    this.current.timelineTime = clamp(this.current.timelineTime, 0, this.clip.duration);
    this.rebuildProgressLookup();
    if (this.timelineMode) this.applyTimelineSample();
    this.emit();
  }

  public seekTimeline(seconds: number): void {
    if (this.offlineActive) return;
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
    if (this.offlineActive) return;
    this.pendingEffect = null;
    this.timelineMode = true;
    if (playing && this.current.timelineTime >= this.clip.duration) this.current.timelineTime = 0;
    this.current.running = playing;
    this.current.mode = this.current.timelineLoop ? 'loop' : 'disperse';
    this.applyTimelineSample();
    this.emit();
  }

  public setTimelineLoop(loop: boolean): void {
    if (this.offlineActive) return;
    this.current.timelineLoop = loop;
    if (this.timelineMode) this.current.mode = loop ? 'loop' : 'disperse';
    this.emit();
  }

  public setProgress(value: number): void {
    if (this.offlineActive) return;
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
    if (this.offlineActive) return;
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
    if (this.offlineActive) return;
    if (this.timelineMode) { this.setTimelinePlaying(!this.current.running); return; }
    if (this.current.running) this.current.running = false;
    else Object.assign(this.current, resumePlayback(this.current));
    this.emit();
  }

  /** Recorder hook: restore the exact task, without restarting at an endpoint. */
  public setRunning(running: boolean): void { if (this.offlineActive) return; this.current.running = running; this.emit(); }

  /** Keep static frames flowing to captureStream while a recording is active. */
  public setCaptureActive(active: boolean): void {
    if (this.offlineActive) return;
    if (this.captureActive === active) return;
    this.captureActive = active;
    this.synchronizeRecordingFreeze();
    this.needsRendering = true;
    this.syncVisibility();
  }

  /** Paused recording still owns a fixed particle density until generation ends. */
  public setRecordingLocked(locked: boolean): void {
    if (this.offlineActive) return;
    if (this.recordingLocked === locked) return;
    this.recordingLocked = locked;
    this.synchronizeRecordingFreeze();
    this.emit();
  }

  public setEffect(effect: Effect): void {
    if (this.offlineActive) return;
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
    if (this.offlineActive) return;
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

  public fitView(mode: 'full' | 'macro' = 'full'): void {
    if (this.offlineActive) return;
    if (this.isPetalFlowActive() || (this.values.surfaceMode && this.current.progress === 0)) {
      this.geometry.computeBoundingBox();
      this.object.updateMatrixWorld(true);
      const bounds = this.geometry.boundingBox?.clone().applyMatrix4(this.object.matrixWorld);
      if (bounds && !bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const direction = this.camera.position.clone().sub(this.controls.target).normalize();
        const allowance = 1 + this.current.progress * this.values.spread * 0.65;
        const distance = Math.max(size.y, size.x / this.camera.aspect, size.z * 0.7, 0.25) * allowance /
          (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.8) * (mode === 'macro' ? 0.58 : 1);
        this.controls.target.copy(center);
        this.camera.position.copy(center).add(direction.multiplyScalar(clamp(distance, this.controls.minDistance, this.controls.maxDistance)));
        this.controls.update(0);
        this.needsRendering = true;
        this.scheduleFrame();
        return;
      }
    }
    const amount = this.current.progress ** 2 * (3 - 2 * this.current.progress);
    const multiplier = this.effect === 'erosion' ? 2.5 + this.values.stringiness * 0.4 : 1.8;
    const radius = SPHERE_RADIUS * this.object.scale.x *
      (1 + this.values.spread * amount * multiplier + this.values.turbulence * amount * 1.8);
    const depthScale = Math.max(1, this.values.depth);
    const distance = radius * depthScale / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(direction.multiplyScalar(Math.min(distance * (mode === 'macro' ? 0.58 : 1), this.controls.maxDistance)));
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
    this.offlineRestore?.();
    cancelAnimationFrame(this.requestId);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('start', this.interactionStart);
    this.controls.removeEventListener('end', this.interactionEnd);
    this.controls.removeEventListener('change', this.controlsChange);
    this.controls.dispose();
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    document.removeEventListener('visibilitychange', this.visibilityChange);
    this.geometry.dispose();
    this.trailGeometry.dispose();
    this.particleTrailGeometry.dispose();
    this.ambientGeometry.dispose();
    this.material.dispose();
    this.trailMaterial.dispose();
    this.particleTrailMaterial.dispose();
    this.ambientMaterial.dispose();
    this.progressTexture?.dispose();
    this.postProcessing.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private createGeometry(asset: ParticleAsset): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(asset.positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(asset.seeds, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(asset.colors, 3));
    const extended = asset as ParticleAsset & { normals?: Float32Array; surface?: Float32Array };
    const normals = new Float32Array(asset.count * 3);
    const surface = new Float32Array(asset.count * 3);
    for (let i = 0; i < asset.count; i++) {
      const offset = i * 3;
      const x = asset.positions[offset], y = asset.positions[offset + 1], z = asset.positions[offset + 2];
      const n = extended.normals;
      const suppliedNormal = n && [n[offset], n[offset + 1], n[offset + 2]].every(Number.isFinite);
      const nx = suppliedNormal ? n[offset] : asset.kind === 'image' ? 0 : x;
      const ny = suppliedNormal ? n[offset + 1] : asset.kind === 'image' ? 0 : y;
      const nz = suppliedNormal ? n[offset + 2] : asset.kind === 'image' ? 1 : z;
      const length = Math.hypot(nx, ny, nz);
      normals.set(length > 1e-9 ? [nx / length, ny / length, nz / length] : [0, 0, 1], offset);
      const s = extended.surface;
      const suppliedSurface = s && [s[offset], s[offset + 1], s[offset + 2]].every(Number.isFinite);
      surface.set(suppliedSurface ? [clamp(s[offset], 0, 1), clamp(s[offset + 1], 0, 1), clamp(s[offset + 2], 0, 2)] :
        [Math.atan2(y, x) / (Math.PI * 2) + 0.5, clamp(Math.hypot(x, y, z) / SPHERE_RADIUS, 0, 1), 0], offset);
    }
    geometry.setAttribute('aNormal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('aSurface', new THREE.BufferAttribute(surface, 3));
    geometry.setDrawRange(0, Math.min(this.values.count, asset.count));
    return geometry;
  }

  private createTrailGeometry(asset: ParticleAsset, source: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    const path = new Float32Array(18);
    for (let segment = 0; segment < 3; segment++) {
      path[segment * 6] = segment / 3;
      path[segment * 6 + 3] = (segment + 1) / 3;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(path, 3));
    // Upload only the short-trajectory prefix, not another full 500k pool.
    const trailComponents = Math.min(asset.count, MAX_TRAILS) * 3;
    geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(asset.positions.subarray(0, trailComponents), 3));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(asset.seeds.subarray(0, trailComponents), 3));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(asset.colors.subarray(0, trailComponents), 3));
    for (const name of ['aNormal', 'aSurface']) {
      const data = source.getAttribute(name).array as Float32Array;
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data.subarray(0, trailComponents), 3));
    }
    geometry.instanceCount = Math.min(this.values.count, asset.count, this.trailBudget());
    return geometry;
  }

  private createAmbientGeometry(asset: ParticleAsset, source: THREE.BufferGeometry): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const components = Math.min(asset.count, MAX_TRAILS) * 3;
    for (const name of ['position', 'aSeed', 'aColor', 'aNormal', 'aSurface']) {
      const data = source.getAttribute(name).array as Float32Array;
      geometry.setAttribute(name, new THREE.BufferAttribute(data.subarray(0, components), 3));
    }
    geometry.setDrawRange(0, 0);
    return geometry;
  }

  /** Unique samples of the same particle's path, drawn as grains rather than loops. */
  private createParticleTrailGeometry(source: THREE.InstancedBufferGeometry): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    const path = new Float32Array(25 * 3);
    for (let i = 0; i < 25; i++) path[i * 3] = i / 24;
    geometry.setAttribute('position', new THREE.BufferAttribute(path, 3));
    for (const name of ['aOrigin', 'aSeed', 'aColor', 'aNormal', 'aSurface']) {
      const attribute = source.getAttribute(name);
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(attribute.array, 3));
    }
    geometry.instanceCount = 0;
    return geometry;
  }

  private updateTrailPath(): void {
    const segments = 3;
    const path = new Float32Array(segments * 6);
    for (let segment = 0; segment < segments; segment++) {
      path[segment * 6] = segment / segments;
      path[segment * 6 + 3] = (segment + 1) / segments;
    }
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(path, 3));
  }

  private updateCount(): void {
    if (!this.values.autoCount) this.activeCount = this.values.count;
    this.current.actualCount = Math.min(this.activeCount, this.asset.count);
    this.geometry.setDrawRange(0, this.current.actualCount);
    const petalActive = this.isPetalFlowActive();
    const layers = layerBudgets(this.current.actualCount, this.values.petalFlow || this.values.surfaceMode, this.values.ambient, petalActive ? this.values.trail : 0);
    this.current.ambientCount = layers.ambient;
    this.current.filamentCount = petalActive ? layers.filaments : 0;
    this.ambientGeometry.setDrawRange(0, layers.ambient);
    this.trailGeometry.instanceCount = petalActive ? 0 : Math.min(this.current.actualCount, this.trailBudget());
    this.particleTrailGeometry.instanceCount = petalActive ? layers.filaments : 0;
  }

  private isPetalFlowActive(): boolean { return this.values.petalFlow && this.effect === 'erosion'; }

  private trailBudget(): number { return this.current.actualCount >= 60_000 ? 12_000 : MAX_TRAILS; }

  private adaptiveController(): AdaptiveQualityController {
    return this.adaptive ??= new AdaptiveQualityController();
  }

  private synchronizeAdaptive(reset = false): void {
    const controller = this.adaptiveController();
    if (reset) controller.reset(this.asset.count, this.values.count, Math.min(this.activeCount, DEFAULT_PARTICLE_COUNT));
    else controller.setCeiling(this.values.count);
    this.current.adaptiveCeiling = Math.min(this.values.count, this.asset.count);
    if (!this.values.autoCount || (!this.recordingLocked && !this.captureActive)) {
      this.activeCount = this.values.autoCount ? controller.state.currentCount : this.values.count;
    }
    this.current.adaptiveStatus = this.values.autoCount && (this.recordingLocked || this.captureActive) ? '录制期间冻结自动数量' :
      this.values.autoCount ? controller.state.reason : '手动数量';
  }

  private synchronizeRecordingFreeze(): void {
    const controller = this.adaptiveController();
    if (this.recordingLocked || this.captureActive) {
      controller.freeze('录制期间冻结粒子数量');
      this.current.adaptiveStatus = this.values.autoCount ? '录制期间冻结自动数量' : '手动数量，录制期间可实时调整';
    } else {
      controller.resume();
      controller.resetSamples();
      this.synchronizeAdaptive();
      this.updateCount();
    }
  }

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
    u.uCurl.value = this.values.curl;
    u.uSparkle.value = this.values.sparkle;
    this.postProcessing.configure(this.values.glow, this.values.exposure, this.values.contrast, this.values.surfaceMode);
    u.uColor.value.set(this.values.color);
    u.uOriginalColor.value = this.values.colorMode === 'original' && this.asset.hasOriginalColors ? 1 : 0;
    u.uSurfaceMode.value = this.values.surfaceMode ? 1 : 0;
    u.uPetalFlow.value = this.isPetalFlowActive() ? 1 : 0;
    u.uGrainStyle.value = this.values.grainStyle ? 1 : 0;
    u.uAmbientRange.value = this.values.ambientRange;
    u.uMotionSpeed.value = this.values.motionSpeed;
    const blending = this.values.surfaceMode ? THREE.NormalBlending : THREE.AdditiveBlending;
    if (this.material.blending !== blending || this.material.depthWrite !== this.values.surfaceMode) {
      this.material.blending = blending;
      this.material.depthWrite = this.values.surfaceMode;
      this.material.needsUpdate = true;
    }
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
      this.progressLookup[i] = this.sampleTimeline(i / (this.progressLookup.length - 1) * this.clip.duration).progress;
    }
    if (!this.progressTexture) {
      this.progressTexture = new THREE.DataTexture(this.progressLookup, this.progressLookup.length, 1, THREE.RedFormat, THREE.FloatType);
      this.progressTexture.minFilter = THREE.NearestFilter;
      this.progressTexture.magFilter = THREE.NearestFilter;
      this.progressTexture.generateMipmaps = false;
    }
    this.progressTexture.needsUpdate = true;
    if (this.material?.uniforms.uProgressHistory) this.material.uniforms.uProgressHistory.value = this.progressTexture;
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
    const from = this.sampleTimeline(left).progress;
    const to = this.sampleTimeline(right).progress;
    if (Math.abs(from - to) > 1e-9 && progress >= Math.min(from, to) && progress <= Math.max(from, to)) {
      for (let i = 0; i < 24; i++) {
        const middle = (left + right) / 2;
      const value = this.sampleTimeline(middle).progress;
        if ((to > from && value < progress) || (to < from && value > progress)) left = middle;
        else right = middle;
      }
      bestTime = (left + right) / 2;
    }
    return bestTime;
  }

  /** The clip is normalized on edit, avoiding allocation/sorting per frame. */
  private sampleTimeline(seconds: number): AnimationSample {
    const frames = this.clip.keyframes;
    const time = clamp(seconds, 0, this.clip.duration);
    const first = frames[0], last = frames[frames.length - 1];
    if (time <= first.time) return { scale: first.scale, rotation: first.rotation, progress: first.progress };
    if (time >= last.time) return { scale: last.scale, rotation: last.rotation, progress: last.progress };
    let low = 1, high = frames.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (frames[middle].time < time) low = middle + 1;
      else high = middle;
    }
    const right = frames[low], left = frames[low - 1];
    if (time === right.time) return { scale: right.scale, rotation: right.rotation, progress: right.progress };
    const ratio = (time - left.time) / (right.time - left.time);
    const eased = left.interpolation === 'hold' ? 0 : left.interpolation === 'linear' ? ratio : ratio * ratio * (3 - 2 * ratio);
    const lerp = (from: number, to: number) => from + (to - from) * eased;
    return {
      scale: lerp(left.scale, right.scale), progress: lerp(left.progress, right.progress),
      rotation: [0, 1, 2].map(axis => lerp(left.rotation[axis], right.rotation[axis])) as [number, number, number],
    };
  }

  private applyTimelineSample(): void {
    const sample = this.sampleTimeline(this.current.timelineTime);
    this.current.progress = sample.progress;
    this.current.time = motionTime(this.current.timelineTime, this.values.motionSpeed);
    this.ambientClock = this.current.timelineTime;
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
    this.updateTrailPath();
    this.updateCount();
    this.syncUniforms();
    this.adaptiveController().resetSamples();
  }

  private emit(invalidate = true): void {
    if (invalidate) this.needsRendering = true;
    if (!this.destroyed) this.onUpdate(this.state);
  }

  private requestAdaptiveWarmup(reason: string): void {
    this.adaptiveWarmupPending = true;
    this.adaptiveWarmupReason = reason;
    this.adaptiveController().resetSamples();
    this.current.frameMsAvg = 0;
    if (this.values.autoCount && !this.recordingLocked && !this.captureActive) this.current.adaptiveStatus = reason;
  }

  private scheduleFrame(): void {
    if (!this.destroyed && !this.offlineActive && !this.graphicsLost && !this.requestId && (!document.hidden || this.captureActive)) {
      this.requestId = requestAnimationFrame(this.frame);
    }
  }

  private readonly visibilityChange = (): void => { this.syncVisibility(); };

  private syncVisibility(): void {
    if (this.pageHidden && !document.hidden) this.requestAdaptiveWarmup('页面恢复预热，暂不判断设备性能');
    this.pageHidden = document.hidden;
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
    this.graphicsLost = true;
    this.current.running = false;
    this.onError?.('图形设备暂时不可用。请刷新页面重新创建粒子画面。');
  };
  private readonly interactionStart = (): void => { this.interacting = true; };
  private readonly interactionEnd = (): void => { this.interacting = false; };
  private readonly controlsChange = this.handleControlsChange.bind(this);
  private handleControlsChange(): void {
    if (this.destroyed) return;
    // Wheel and pointer handlers can update OrbitControls before the next RAF.
    // Its subsequent update() may return false, so retain the change until tick.
    this.cameraDirty = true;
    this.needsRendering = true;
    this.scheduleFrame();
  }
  private resize(): void {
    if (this.destroyed) return;
    const width = Math.max(1, Math.min(this.container.clientWidth, this.container.clientHeight * 16 / 9));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${width * 9 / 16}px`;
    if (this.offlineActive) return;
    if (this.captureSize) { this.setRenderSize(this.captureSize.width, this.captureSize.height); return; }
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const maximum = this.previewQuality === 'sharp' ? 2560 : 1920;
    const pixels = Math.max(16, Math.round(Math.min(width * dpr, maximum) / 16) * 16);
    this.setRenderSize(pixels, pixels * 9 / 16);
  }

  private validateOutputSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || width > 8192 || height > 8192) {
      throw new Error('画面分辨率必须在 2–8192 像素之间。');
    }
  }

  private setRenderSize(width: number, height: number): void {
    if (width === this.renderWidth && height === this.renderHeight) return;
    this.renderer.setSize(width, height, false);
    this.postProcessing.setSize(width, height);
    this.renderWidth = width;
    this.renderHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uOutputScale.value = height / OUTPUT_HEIGHT;
    this.needsRendering = true;
  }

  private render(): void {
    const u = this.material.uniforms;
    u.uProgress.value = this.current.progress;
    u.uTime.value = this.current.time;
    u.uAmbientPhase.value = ambientPhase(this.ambientClock, this.values.ambientSpeed, this.clip.duration, this.timelineMode);
    u.uTimelineActive.value = this.timelineMode ? 1 : 0;
    u.uTimelineTime.value = this.current.timelineTime;
    u.uTimelineDuration.value = this.clip.duration;
    u.uOutputScale.value = (this.renderHeight || OUTPUT_HEIGHT) / OUTPUT_HEIGHT;
    const span = this.values.trail * (0.18 + this.values.stringiness * 0.22) * (1 + this.values.curl * 0.2);
    u.uTrailTimeSpan.value = span * this.values.motionSpeed;
    u.uTrailProgressSpan.value = this.values.trail * 0.22;
    this.trails.visible = !this.isPetalFlowActive() && this.values.trail > 0 && this.current.progress > 0.00001 && this.trailGeometry.instanceCount > 0;
    this.particleTrails.visible = this.isPetalFlowActive() && this.values.trail > 0 && this.current.progress > 0.00001 && this.particleTrailGeometry.instanceCount > 0;
    this.points.visible = !(this.values.fade && this.current.progress >= 1);
    this.trails.visible &&= this.points.visible;
    this.particleTrails.visible &&= this.points.visible;
    this.ambientPoints.visible = this.current.ambientCount > 0 && this.points.visible;
    if ((this.trails.visible && !this.renderedTrails) || (this.particleTrails.visible && !this.renderedParticleTrails) || (this.values.glow > 0 && !this.renderedBloom)) {
      this.requestAdaptiveWarmup('图形新通道预热，暂不判断设备性能');
    }
    u.uDensityOpacity.value = clamp(Math.pow(DEFAULT_PARTICLE_COUNT / Math.max(1, this.current.actualCount), 0.35), 0.22, 1.35);
    this.postProcessing.render();
    this.renderedTrails ||= this.trails.visible;
    this.renderedParticleTrails ||= this.particleTrails.visible;
    this.renderedBloom ||= this.values.glow > 0;
    this.needsRendering = false;
  }

  private readonly frame = (now: number): void => {
    this.requestId = 0;
    if (this.destroyed || this.offlineActive || this.graphicsLost) return;
    this.tick(now);
    this.scheduleFrame();
  };

  private tick(now: number): void {
    if (this.destroyed) return;
    const dt = this.lastFrame ? Math.max(0, (now - this.lastFrame) / 1000) : 0;
    const previousShape = this.current.progress;
    const previousScale = this.object.scale.x;
    const previousRotationX = this.object.rotation.x;
    const previousRotationY = this.object.rotation.y;
    const previousRotationZ = this.object.rotation.z;
    this.lastFrame = now;
    if (this.current.running) {
      this.needsRendering = true;
      const previousProgress = this.current.progress;
      if (this.timelineMode) {
        const next = advanceTimelineTime(this.current.timelineTime, dt, this.clip.duration, this.values.playbackRate, this.current.timelineLoop);
        this.current.timelineTime = next.time;
        this.applyTimelineSample();
        if (next.completed) this.current.running = false;
      } else {
        this.ambientClock += dt;
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
    const controlsChanged = this.controls.update(dt);
    const cameraChanged = this.cameraDirty || !!controlsChanged;
    this.cameraDirty = false;
    const motionChanged = this.current.progress !== previousShape || this.object.scale.x !== previousScale ||
      this.object.rotation.x !== previousRotationX || this.object.rotation.y !== previousRotationY ||
      this.object.rotation.z !== previousRotationZ ||
      (this.current.running && ((this.current.progress > 0 && this.values.motionSpeed > 0) ||
        (this.current.ambientCount > 0 && this.values.ambientSpeed > 0)));
    const visible = typeof document === 'undefined' || !document.hidden;
    const particlesVisible = !(this.values.fade && this.current.progress >= 1);
    const warmingUp = this.adaptiveWarmupPending || this.adaptiveController().isWarmingUp(now, dt * 1000);
    const activeSample = visible && particlesVisible && (motionChanged || !!cameraChanged) && dt > 0 && !this.captureActive && !this.recordingLocked && !warmingUp;
    if (activeSample) this.current.frameMsAvg = this.current.frameMsAvg ? this.current.frameMsAvg * 0.9 + dt * 1000 * 0.1 : dt * 1000;
    if (this.values.autoCount) {
      const adaptiveState = this.adaptiveController().observe({
        now, frameMs: dt * 1000, eligible: activeSample,
        reason: this.recordingLocked || this.captureActive ? '录制期间冻结自动数量' : !visible ? '后台暂停采样' :
          !particlesVisible ? '已完全淡出，保留当前粒子数量' : warmingUp ? this.adaptiveWarmupReason : '等待真实运动或相机变化',
      });
      this.current.adaptiveStatus = this.recordingLocked || this.captureActive ? '录制期间冻结自动数量' : adaptiveState.reason;
      this.current.adaptiveCeiling = adaptiveState.ceiling;
      if (!this.recordingLocked && !this.captureActive && adaptiveState.currentCount !== this.activeCount) {
        this.activeCount = adaptiveState.currentCount;
        this.updateCount();
        this.needsRendering = true;
      }
    }
    if (this.needsRendering || this.current.running || this.captureActive || cameraChanged) {
      const renderStarted = performance.now();
      this.render();
      if (this.adaptiveWarmupPending) {
        const completedAt = now + Math.max(0, performance.now() - renderStarted);
        this.adaptiveController().warmup(completedAt, 2000, this.adaptiveWarmupReason);
        this.adaptiveWarmupPending = false;
        this.current.frameMsAvg = 0;
        if (this.values.autoCount && !this.recordingLocked && !this.captureActive) this.current.adaptiveStatus = this.adaptiveWarmupReason;
      }
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
