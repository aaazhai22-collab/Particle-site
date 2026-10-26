import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** One HDR render graph owns the final canvas used by preview, PNG and video. */
export class ParticlePostProcessing {
  private readonly composer: EffectComposer;
  private readonly scenePass: RenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly output: OutputPass;
  private readonly contrastUniform = { value: 1 };

  constructor(private readonly renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1280, 720, { type: THREE.HalfFloatType, depthBuffer: true });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.composer = new EffectComposer(renderer, target);
    this.scenePass = new RenderPass(scene, camera);
    // Subpixel light cores are reduced before extraction; a photographic
    // threshold such as .72 discards them. Keep a low, soft energy threshold.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(640, 360), 0.65, 0.35, 0.08);
    this.output = new OutputPass();
    // Add contrast in linear HDR immediately before OutputPass's sole tone-map
    // and sRGB conversion. Black remains black even when lowering contrast.
    Object.assign(this.output.uniforms, { uContrast: this.contrastUniform });
    this.output.material.fragmentShader = this.output.material.fragmentShader
      .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\n uniform float uContrast;')
      .replace('// tone mapping', `
        if (abs(uContrast - 1.0) > 0.0001) {
          float sceneLuminance = max(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.00001);
          gl_FragColor.rgb *= pow(sceneLuminance / 0.18, (uContrast - 1.0) * 0.55);
        }
        // tone mapping`);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.setSize(1280, 720);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  configure(glow: number, exposure: number, contrast: number, surfaceMode = false): void {
    this.bloom.enabled = glow > 0;
    // Dense coloured surfaces need highlight bloom, not a blur of the entire
    // silhouette. Radius zero also prevents zero-weight wide mips leaking back
    // through UnrealBloom's mirrored radius interpolation.
    this.bloom.threshold = surfaceMode ? 0.55 : 0.08;
    this.bloom.strength = glow * (surfaceMode ? 0.32 : 0.9);
    this.bloom.radius = surfaceMode ? 0 : 0.32 + Math.min(1, glow) * 0.16;
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = surfaceMode ? [1, 0.22, 0.025, 0, 0] : [1, 0.8, 0.6, 0.4, 0.2];
    this.renderer.toneMappingExposure = exposure;
    this.contrastUniform.value = contrast;
  }

  /** Resize the actual HDR output graph, not just the canvas's CSS box. */
  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    // Keep convolution at a bounded quarter-resolution highest mip.
    this.bloom.setSize(Math.min(960, Math.round(width / 2)), Math.min(540, Math.round(height / 2)));
  }

  render(): void { this.composer.render(0); }

  dispose(): void {
    this.scenePass.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
