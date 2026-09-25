// 场景、相机、灯光与视角预设。场景单位统一为毫米（与 Rhino 模型一致）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { N8AOPass } from 'n8ao';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const SETTLE_FRAMES = 48; // 静止后继续累积的帧数（环境光遮蔽逐步去噪）
const isTouch = matchMedia('(pointer: coarse)').matches;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Viewer {
  constructor(container, labelContainer) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    // adaptive resolution: start at the device ratio (capped), step down / up to hold the frame rate
    this.maxPR = Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2);
    this.minPR = isTouch ? 0.75 : 1;
    this.pr = this.maxPR;
    this.renderer.setPixelRatio(this.pr);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap; // 柔和阴影
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer({ element: labelContainer });

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
    this.scene.environmentIntensity = 0.6;
    this.scene.environmentRotation.y = -0.6;
    this.bgCanvas = document.createElement('canvas');
    this.bgCanvas.width = 1600; this.bgCanvas.height = 1000;
    this.brand = 'DIAXIS';
    this.bgStyle = 'clean'; // clean | monogram | sheet | monolith
    this.scene.background = new THREE.CanvasTexture(this.bgCanvas);
    this.scene.background.colorSpace = THREE.SRGBColorSpace;

    // 透视相机 + 正交相机（立面 / 平面用正交，更接近建筑图纸）
    this.persp = new THREE.PerspectiveCamera(35, 1, 10, 400000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -400000, 400000);
    this.camera = this.persp;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.zoomToCursor = true;

    // 灯光：柔和天光 + 一盏暖色主光（投影）
    this.hemi = new THREE.HemisphereLight(0xfbfaf7, 0xb5ab9c, 0.35);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff7ee, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.radius = 14;
    this.sun.shadow.blurSamples = 12;
    // the sun and the stair do not move while the camera orbits: re-render the shadow map only on change
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.scene.add(this.sun, this.sun.target);

    // 地面阴影
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.2, depthWrite: false }),
    );
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);

    this.grid = null;
    this.bounds = new THREE.Box3(new THREE.Vector3(-1000, 0, -1000), new THREE.Vector3(1000, 3000, 1000));

    this.firstPerson = false; // 第一人称行走时由外部直接控制相机
    this.viewShift = 0; // 被侧边面板遮挡时，视图中心的水平偏移（像素）
    this._tween = null;
    this._listeners = [];
    this.needsRender = true;

    // 后期：环境光遮蔽（N8AO）→ 色调映射输出 → SMAA 抗锯齿
    this.composer = new EffectComposer(this.renderer);
    this.ao = new N8AOPass(this.scene, this.camera, 1, 1);
    Object.assign(this.ao.configuration, {
      aoRadius: 320, // 毫米
      distanceFalloff: 1.2,
      intensity: 3.2,
      aoSamples: isTouch ? 8 : 16,
      denoiseSamples: 8,
      denoiseRadius: 10,
      halfRes: isTouch,
      depthAwareUpsampling: true,
      gammaCorrection: false,
      transparencyAware: true,
      accumulate: true,
      color: new THREE.Color(0x1a1612),
    });
    this.composer.addPass(this.ao);
    // night: glow around the step lights and the projected wordmark
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0, 0.55, 0.9);
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    this.renderMode = true; // true = 渲染效果（AO + 后期）；false = 快速显示
    this._settle = SETTLE_FRAMES;

    window.addEventListener('resize', () => this.resize());
    this.controls.addEventListener('change', () => (this.needsRender = true));
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  onFrame(fn) { this._listeners.push(fn); }

  /** something that casts shadows moved / appeared / disappeared */
  shadowsDirty() { this.sun.shadow.needsUpdate = true; this.needsRender = true; }

  /** frame-time governor: lower the pixel ratio when frames are slow, raise it again when there is headroom */
  _govern(now, rendered) {
    const g = this._gov || (this._gov = { last: now, sum: 0, n: 0, t0: now });
    const dt = now - g.last;
    g.last = now;
    if (!rendered || dt > 250) return; // idle or tab switch: not a measurement
    g.sum += dt; g.n++;
    if (now - g.t0 < 1500 || g.n < 30) return;
    const avg = g.sum / g.n;
    g.sum = 0; g.n = 0; g.t0 = now;
    let pr = this.pr;
    if (avg > 26 && pr > this.minPR) pr = Math.max(this.minPR, pr - 0.25);
    else if (avg < 14 && pr < this.maxPR) pr = Math.min(this.maxPR, pr + 0.25);
    if (pr !== this.pr) {
      this.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.composer.setPixelRatio?.(pr);
      this.resize();
    }
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.persp.aspect = w / h;
    this._applyViewShift();
    this._updateOrthoFrustum();
    if (this.bgCanvas) this._drawBackground();
    this.needsRender = true;
  }

  /** 让模型居中于面板之间的可视区域 */
  setViewShift(px) {
    this.viewShift = px;
    this._applyViewShift();
    this.needsRender = true;
  }

  _applyViewShift() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    for (const cam of [this.persp, this.ortho]) {
      if (this.viewShift) cam.setViewOffset(w, h, -this.viewShift, 0, w, h);
      else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
  }

  _updateOrthoFrustum() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const size = this.bounds.getSize(new THREE.Vector3());
    const half = Math.max(size.x, size.y, size.z) * 0.62;
    const a = w / h;
    Object.assign(this.ortho, { left: -half * a, right: half * a, top: half, bottom: -half });
    this.ortho.updateProjectionMatrix();
  }

  /**
   * Night blend 0..1: sky dims to a deep blue, the sun becomes a faint cool moonlight,
   * ambient and reflections drop, bloom comes up for the lamps.
   */
  setNight(k) {
    this.nightK = k;
    const day = this._dayLights || (this._dayLights = { hemi: this.hemi.intensity, sun: this.sun.intensity, env: this.scene.environmentIntensity, ground: this.ground.material.opacity });
    this.hemi.intensity = THREE.MathUtils.lerp(day.hemi, 0.05, k);
    this.hemi.color.lerpColors(new THREE.Color(0xfbfaf7), new THREE.Color(0xb49a80), k);
    this.sun.intensity = THREE.MathUtils.lerp(day.sun, 0.12, k);
    this.sun.color.lerpColors(new THREE.Color(0xfff7ee), new THREE.Color(0xffd9b0), k);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(day.env, 0.05, k);
    this.ground.material.opacity = THREE.MathUtils.lerp(day.ground, 0.55, k);
    this.bloom.enabled = k > 0.01;
    this.bloom.strength = 0.4 * k;
    this.bloom.threshold = 1.0;
    this.bloom.radius = 0.35;
    if (Math.abs((this._bgK ?? -1) - k) > 0.02 || k === 0 || k === 1) { this._bgK = k; this._drawBackground(); }
    this.needsRender = true;
  }

  setTheme(dark) {
    this.dark = dark;
    this._dayLights = null;
    this._drawBackground();
    this.ground.material.opacity = dark ? 0.45 : 0.2;
    this.hemi.groundColor.set(dark ? 0x3a3835 : 0xc9c1b4);
    this.scene.environmentIntensity = dark ? 0.5 : 0.6;
    if (this.grid) {
      this.grid.material.color.set(dark ? 0xffffff : 0x000000);
      this.grid.material.opacity = dark ? 0.07 : 0.07;
    }
    this.needsRender = true;
  }

  /** 影棚背景：竖向渐变 + 淡色 DIAXIS 字标（与视口同比例，截图也会包含） */
  _drawBackground() {
    const dark = this.dark;
    const w = this.container.clientWidth || 1600, h = this.container.clientHeight || 1000;
    const scale = Math.min(1, 2048 / Math.max(w, h));
    const c = this.bgCanvas;
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw; c.height = ch;
      // GPU texture size is immutable: replace the texture when the viewport changes
      this.scene.background?.dispose();
      this.scene.background = new THREE.CanvasTexture(c);
      this.scene.background.colorSpace = THREE.SRGBColorSpace;
    }
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    const day = dark ? ['#2a2b2e', '#1c1d20', '#141517'] : ['#f6f4f0', '#ebe7e0', '#dcd6cc'];
    const night = ['#15110e', '#1c1612', '#231c17']; // warm charcoal
    const k = this.nightK || 0;
    const mix = (a, b) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();
    g.addColorStop(0, mix(day[0], night[0])); g.addColorStop(0.58, mix(day[1], night[1])); g.addColorStop(1, mix(day[2], night[2]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    const H = c.height, W = c.width;
    const ink = (a) => (dark ? `rgba(255,255,255,${a})` : `rgba(62,52,40,${a})`);
    ctx.save();
    const nk = this.nightK || 0;
    if (nk > 0.01 && this.brand) this._drawNeon(ctx, W, H, nk);
    if (this.bgStyle === 'monogram' && this.brand) {
      // fine repeated wordmark, staggered rows — a quiet "brand paper"
      const fs = Math.max(9, H / 88);
      ctx.font = `400 ${fs}px Jost, "Futura", "Helvetica Neue", sans-serif`;
      ctx.letterSpacing = `${fs * 0.45}px`;
      ctx.fillStyle = ink(dark ? 0.05 : 0.06);
      const unit = ctx.measureText(this.brand).width + fs * 4.2;
      const rowH = fs * 4.4;
      for (let r = 0, y = rowH * 0.6; y < H + rowH; r++, y += rowH) {
        for (let x = (r % 2) * unit * 0.5 - unit; x < W + unit; x += unit) ctx.fillText(this.brand, x, y);
      }
    } else if (this.bgStyle === 'sheet') {
      // drawing-sheet dot grid, fading out towards the centre where the model sits
      const step = Math.max(14, H / 42);
      const cx = W / 2, cy = H * 0.5, rMax = Math.hypot(W, H) / 2;
      for (let y = step / 2; y < H; y += step) {
        for (let x = step / 2; x < W; x += step) {
          const d = Math.hypot(x - cx, y - cy) / rMax;
          const a = 0.03 + 0.1 * Math.min(1, Math.max(0, (d - 0.25) / 0.6));
          ctx.fillStyle = ink(a * (dark ? 0.8 : 1));
          ctx.fillRect(x, y, Math.max(1, H / 700), Math.max(1, H / 700));
        }
      }
    } else if (this.bgStyle === 'monolith' && this.brand) {
      // one oversized solid "D", cropped at the lower right
      const size = H * 1.35;
      ctx.font = `300 ${size}px Jost, "Futura", "Helvetica Neue", sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = ink(dark ? 0.03 : 0.035);
      ctx.fillText(this.brand[0], W - size * 0.62, H * 1.12);
    }
    ctx.restore();
    this.scene.background.needsUpdate = true;
    this.needsRender = true;
  }

  /** Night: DIAXIS as a large neon sign on the backdrop — tube glow, halo and a warm spill on the "floor" */
  _drawNeon(ctx, W, H, k) {
    // warm, layered backlit sign: deep copper spill → rose-amber halo → honey glow → soft ivory letters,
    // with a faint cool dusk tone at the top of the backdrop for depth
    const size = Math.min(H * 0.2, W * 0.11);
    const x = W / 2, y = H * 0.4;
    ctx.save();
    ctx.globalAlpha = k;
    const dusk = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    dusk.addColorStop(0, 'rgba(70,82,110,0.22)'); dusk.addColorStop(1, 'rgba(70,82,110,0)');
    ctx.fillStyle = dusk; ctx.fillRect(0, 0, W, H * 0.55);
    const spill = ctx.createRadialGradient(x, y, size * 0.2, x, y, size * 4.4);
    spill.addColorStop(0, 'rgba(255,178,110,0.16)');
    spill.addColorStop(0.35, 'rgba(214,112,86,0.09)');
    spill.addColorStop(0.7, 'rgba(120,60,50,0.05)');
    spill.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = spill; ctx.fillRect(0, 0, W, H);
    // floor bounce under the sign
    const bounce = ctx.createRadialGradient(x, H * 0.95, size * 0.5, x, H * 0.95, size * 5);
    bounce.addColorStop(0, 'rgba(255,170,110,0.08)'); bounce.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bounce; ctx.fillRect(0, H * 0.6, W, H * 0.4);
    ctx.font = `300 ${size}px Jost, Futura, "Helvetica Neue", sans-serif`;
    ctx.letterSpacing = `${size * 0.4}px`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tx = x + size * 0.2;
    for (const [blur, glow, fill] of [
      [size * 0.6, 'rgba(210,100,80,0.5)', 'rgba(210,110,90,0.25)'],   // rose-copper halo
      [size * 0.28, 'rgba(255,165,95,0.65)', 'rgba(255,175,110,0.45)'], // amber glow
      [size * 0.1, 'rgba(255,210,150,0.8)', 'rgba(255,222,180,0.7)'],   // honey
      [size * 0.02, 'rgba(255,245,230,0.9)', 'rgba(255,246,236,0.88)'], // ivory core
    ]) {
      ctx.shadowColor = glow; ctx.shadowBlur = blur;
      ctx.fillStyle = fill;
      ctx.fillText(this.brand, tx, y);
    }
    ctx.restore();
  }

  /** 根据模型范围设置地面、阴影相机、网格与裁切面 */
  fitScene(box) {
    this.bounds.copy(box);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const R = size.length();

    this.ground.scale.set(R * 8, 1, R * 8);
    this.ground.position.set(center.x, box.min.y - 2, center.z);

    this.shadowsDirty();
    const s = this.sun;
    s.position.set(center.x - R * 0.55, box.max.y + R * 1.2, center.z + R * 0.75);
    s.target.position.copy(center);
    const cam = s.shadow.camera;
    const ext = R * 1.4; // 覆盖拆分后的高度
    Object.assign(cam, { left: -ext, right: ext, top: ext, bottom: -ext, near: 10, far: R * 6 });
    cam.updateProjectionMatrix();

    if (this.grid) this.scene.remove(this.grid);
    const gridSize = Math.ceil((Math.max(size.x, size.z) * 3) / 1000) * 1000;
    this.grid = new THREE.GridHelper(gridSize, gridSize / 1000, 0x000000, 0x000000);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.07;
    this.grid.material.depthWrite = false;
    this.grid.position.set(center.x, box.min.y - 1, center.z);
    this.grid.visible = false;
    this.scene.add(this.grid);

    // 近裁切面不宜过小：饰面层之间只有几毫米，深度精度不足会产生闪烁
    this.persp.near = Math.max(20, R / 250);
    this.persp.far = R * 30;
    this.persp.updateProjectionMatrix();
    this.controls.maxDistance = R * 8;
    this.controls.minDistance = 200;
    this._updateOrthoFrustum();
    this.needsRender = true;
  }

  /** 拆分时让阴影相机跟随模型中心 */
  setShadowHeight(extra) {
    const c = this.bounds.getCenter(new THREE.Vector3()).addScaledVector(extra, 0.5);
    const d = this.sun.position.clone().sub(this.sun.target.position);
    if (this.sun.target.position.distanceToSquared(c) < 1) return;
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).add(d);
    this.shadowsDirty();
    this.needsRender = true;
  }

  useCamera(kind) {
    const next = kind === 'ortho' ? this.ortho : this.persp;
    if (next === this.camera) return;
    next.position.copy(this.camera.position);
    next.up.copy(this.camera.up);
    next.quaternion.copy(this.camera.quaternion);
    this.camera = next;
    this.controls.object = next;
    this.ao.camera = next;
    this.needsRender = true;
  }

  /**
   * 视角预设
   * @param {'home'|'top'|'front'|'side'|'under'} name
   * @param {THREE.Box3} [box] 取景范围（默认使用当前可见范围）
   */
  view(name, box = this.bounds, animate = true) {
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const R = size.length() * 0.5;
    const fov = THREE.MathUtils.degToRad(35);
    const dist = (R / Math.sin(fov / 2)) * 1.02;
    let pos, target = c.clone(), up = new THREE.Vector3(0, 1, 0), cam = 'persp', zoom = 1, fovDeg = 35;

    switch (name) {
      case 'top': // 俯视平面：Rhino 的 +Y 朝上
        pos = new THREE.Vector3(c.x, c.y + dist * 2, c.z);
        up = new THREE.Vector3(0, 0, -1);
        cam = 'ortho';
        zoom = this._orthoZoom(size.x, size.z);
        break;
      case 'front': // 正立面：从 Rhino -Y 方向看
        pos = new THREE.Vector3(c.x, c.y, c.z + dist * 2);
        cam = 'ortho';
        zoom = this._orthoZoom(size.x, size.y);
        break;
      case 'side': // 侧立面：从 Rhino +X 方向看
        pos = new THREE.Vector3(c.x + dist * 2, c.y, c.z);
        cam = 'ortho';
        zoom = this._orthoZoom(size.z, size.y);
        break;
      case 'under': // 站在地下室地面（视高约 1.2 m）仰视楼梯底面
        pos = new THREE.Vector3(c.x + size.x * 0.18, box.min.y + 1200, c.z + size.z * 0.75);
        target = new THREE.Vector3(c.x - size.x * 0.12, box.min.y + size.y * 0.7, c.z - size.z * 0.15);
        fovDeg = 72;
        break;
      default: // 鸟瞰
        pos = new THREE.Vector3(c.x + dist * 0.62, c.y + dist * 0.55, c.z + dist * 0.56);
    }

    this.useCamera(cam);
    if (cam === 'ortho') this._updateOrthoFrustum();
    this._fov = { from: this.persp.fov, to: fovDeg };
    this._flyTo(pos, target, up, zoom, animate ? 900 : 0);
    // 仰视时相机在地面下方不应出现地面阴影遮挡
    this.controls.maxPolarAngle = Math.PI;
  }

  _orthoZoom(w, h) {
    const vw = this.ortho.right - this.ortho.left, vh = this.ortho.top - this.ortho.bottom;
    return Math.min(vw / (w * 1.25), vh / (h * 1.25));
  }

  _flyTo(pos, target, up, zoom, ms) {
    const cam = this.camera;
    const from = { pos: cam.position.clone(), target: this.controls.target.clone(), up: cam.up.clone(), zoom: cam.zoom };
    if (!ms) {
      cam.position.copy(pos); this.controls.target.copy(target); cam.up.copy(up); cam.zoom = zoom;
      if (this._fov && cam === this.persp) cam.fov = this._fov.to;
      cam.updateProjectionMatrix(); this.controls.update(); this.needsRender = true;
      return;
    }
    this._frame = null;
    this._tween = { from, to: { pos, target, up, zoom }, t0: performance.now(), ms };
  }

  _stepTween(now) {
    const tw = this._tween;
    if (!tw) return;
    const k = Math.min(1, (now - tw.t0) / tw.ms);
    const e = easeInOut(k);
    const cam = this.camera;
    cam.position.lerpVectors(tw.from.pos, tw.to.pos, e);
    this.controls.target.lerpVectors(tw.from.target, tw.to.target, e);
    cam.up.lerpVectors(tw.from.up, tw.to.up, e).normalize();
    cam.zoom = THREE.MathUtils.lerp(tw.from.zoom, tw.to.zoom, e);
    if (this.firstPerson) cam.lookAt(this.controls.target);
    if (this._fov && cam === this.persp) cam.fov = THREE.MathUtils.lerp(this._fov.from, this._fov.to, e);
    cam.updateProjectionMatrix();
    if (k >= 1) this._tween = null;
    this.needsRender = true;
  }

  /**
   * 保持当前环绕方向，只平滑改变取景中心与距离（演示循环中与自动旋转同时进行）
   */
  frameTo(box, ms = 2500, k = 1.0) {
    this.useCamera('persp');
    const c = box.getCenter(new THREE.Vector3());
    const R = box.getSize(new THREE.Vector3()).length() * 0.5;
    const dist = (R / Math.sin(THREE.MathUtils.degToRad(35) / 2)) * k;
    const cam = this.camera;
    this._tween = null;
    if (cam.position.distanceTo(this.controls.target) < 1) return; // 尚未设置初始视角
    this._fov = { from: cam.fov, to: 35 };
    this._frame = {
      fromT: this.controls.target.clone(), toT: c,
      fromD: cam.position.distanceTo(this.controls.target), toD: dist,
      t0: performance.now(), ms,
    };
  }

  _stepFrame(now) {
    const f = this._frame;
    if (!f) return;
    const k = Math.min(1, (now - f.t0) / f.ms);
    const e = easeInOut(k);
    const cam = this.camera;
    const dir = cam.position.clone().sub(this.controls.target).normalize();
    this.controls.target.lerpVectors(f.fromT, f.toT, e);
    cam.position.copy(this.controls.target).addScaledVector(dir, THREE.MathUtils.lerp(f.fromD, f.toD, e));
    if (this._fov) { cam.fov = THREE.MathUtils.lerp(this._fov.from, this._fov.to, e); cam.updateProjectionMatrix(); }
    if (k >= 1) this._frame = null;
    this.needsRender = true;
  }

  get busy() { return !!this._tween; }

  /**
   * 近景跟随：视点平滑移向 focus，相机保持给定距离与俯角，方位角由自动旋转缓慢变化
   * @param {THREE.Vector3} focus 世界坐标
   * @param {number} dist 相机距离（毫米）
   * @param {number} elevDeg 俯视角（度，自水平面起算）
   */
  follow(focus, dist, elevDeg, dt) {
    this._frame = null;
    this._tween = null;
    const cam = this.camera;
    const k = Math.min(1, dt * 0.9);
    this.controls.target.lerp(focus, k);
    const off = cam.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.radius = THREE.MathUtils.lerp(sph.radius, dist, k);
    sph.phi = THREE.MathUtils.lerp(sph.phi, THREE.MathUtils.degToRad(90 - elevDeg), k);
    cam.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sph));
    this.needsRender = true;
  }

  /** 35 mm 画幅下焦距对应的竖向视角（度） */
  fovForLens(mm) {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    const filmH = 36 / Math.max(aspect, 1) ; // 以 36 mm 画幅宽度为基准
    return THREE.MathUtils.radToDeg(2 * Math.atan(filmH / 2 / mm));
  }

  setFirstPerson(on) {
    this.firstPerson = on;
    this.controls.enabled = !on;
    if (on) { this.useCamera('persp'); this.controls.autoRotate = false; this._frame = null; }
    this.needsRender = true;
  }

  /** 平滑飞到指定相机位置与视点（用于进入第一人称） */
  flyTo(pos, target, fovDeg, ms = 1500) {
    this.useCamera('persp');
    this._fov = { from: this.persp.fov, to: fovDeg };
    this._flyTo(pos, target, new THREE.Vector3(0, 1, 0), 1, ms);
  }

  tick() {
    const now = performance.now();
    this._stepTween(now);
    this._stepFrame(now);
    for (const fn of this._listeners) fn(now);
    const moved = this.firstPerson ? false : this.controls.update();
    const active = moved || this.needsRender || this.controls.autoRotate || this._tween || this._frame || this.animating;
    if (active) this._settle = SETTLE_FRAMES;
    const rendering = active || (this.renderMode && this._settle > 0);
    this._govern(now, rendering && active);
    if (rendering) {
      this.draw();
      if (!active) this._settle--;
      this.labelRenderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  draw() {
    if (this.renderMode) {
      this.ao.camera = this.camera;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  setRenderMode(on) {
    this.renderMode = on;
    this.needsRender = true;
  }

  /** 导出当前视角 PNG（2 倍分辨率，带背景色） */
  screenshot(filename, background = '#efede8') {
    const src = this.renderer.domElement;
    // 静止状态下累积若干帧再截图，环境光遮蔽更干净
    for (let i = 0; i < (this.renderMode ? 24 : 1); i++) this.draw();
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = filename;
    a.click();
  }
}
