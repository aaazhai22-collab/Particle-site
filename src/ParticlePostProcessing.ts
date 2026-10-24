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
    this.composer.setSize(1280, 720);
    // UnrealBloom halves this again internally: its highest blur mip is
    // 320×180; the scene and final output still contain all 1280×720 pixels.
    this.bloom.setSize(640, 360);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  configure(glow: number, exposure: number, contrast: number): void {
    this.bloom.enabled = glow > 0;
    this.bloom.strength = glow * 0.9;
    this.bloom.radius = 0.32 + Math.min(1, glow) * 0.16;
    this.renderer.toneMappingExposure = exposure;
    this.contrastUniform.value = contrast;
  }

  render(): void { this.composer.render(0); }

  dispose(): void {
    this.scenePass.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
