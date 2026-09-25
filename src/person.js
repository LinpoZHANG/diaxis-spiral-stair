// 配景人物：沿踏步中线上下往返行走。尺寸单位：毫米。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const H = 1600; // 人物身高（毫米）
const SLIM = 0.9; // X Bot 体型偏壮，水平方向略收窄

/**
 * 配景人物（Mixamo X Bot，见 public/models/person/LICENSE.md），统一为白色哑光。
 */
export class Walker {
  /**
   * @param {THREE.Vector3[]} points 行走路径（three 世界坐标），自下而上
   */
  constructor(points) {
    this.group = new THREE.Group();
    this.group.name = 'walker';
    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
    this.length = this.curve.getLength();
    this.s = 0; // 沿路径距离
    this.dir = 1; // 1 上楼，-1 下楼
    this.wait = 1.5; // 停顿计时（秒）
    this.heading = 0;
    this.speed = 520; // 楼梯上的行进速度 mm/s
    this.ready = false;
    this.materials = [];
    this._place(0, true);
  }

  async load(basePath) {
    const gltf = await new GLTFLoader().loadAsync(basePath + 'Xbot.glb');
    const model = gltf.scene;
    // 统一尺寸为 1.6 m（模型单位为米，场景为毫米）
    model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const k = H / size.y;
    model.scale.set(k * SLIM, k, k * SLIM);
    // 配景人物不是视觉重点：统一为简洁的白色哑光
    const mat = new THREE.MeshStandardMaterial({ color: 0xefece6, roughness: 0.7, metalness: 0, transparent: true });
    this.materials.push(mat);
    model.traverse((o) => {
      if (o.isMesh) { o.material = mat; o.castShadow = false; o.frustumCulled = false; } // a moving caster would force a shadow re-render every frame
    });
    this.group.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    const clip = (name) => {
      const c = gltf.animations.find((a) => a.name === name).clone();
      // 原地动画：去掉髋部位移，由路径控制前进
      c.tracks = c.tracks.filter((t) => !/Hips\.position$/.test(t.name));
      return c;
    };
    this.walk = this.mixer.clipAction(clip('walk'));
    this.idle = this.mixer.clipAction(clip('idle'));
    this.walk.play();
    this.idle.play();
    this.walk.setEffectiveWeight(0);
    this.idle.setEffectiveWeight(1);
    this.ready = true;
    return this;
  }

  _place(dt, snap = false) {
    const u = THREE.MathUtils.clamp(this.s / this.length, 0, 1);
    const p = this.curve.getPointAt(u);
    const t = this.curve.getTangentAt(u);
    this.group.position.copy(p);
    const fwd = Math.atan2(t.x, t.z);
    const target = this.dir > 0 ? fwd : fwd + Math.PI;
    if (snap) this.heading = target;
    let d = target - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * (this.wait > 0 ? 2.5 : 6));
    this.group.rotation.y = this.heading;
  }

  update(dt) {
    if (!this.ready) return;
    dt = Math.min(dt, 0.05);
    let moving = false;
    if (this.wait > 0) {
      this.wait -= dt;
    } else {
      this.s += this.speed * dt * this.dir;
      moving = true;
      if (this.s >= this.length) { this.s = this.length; this.dir = -1; this.wait = 2.5; }
      if (this.s <= 0) { this.s = 0; this.dir = 1; this.wait = 2.5; }
    }
    // 走 / 停之间平滑过渡
    this._w = THREE.MathUtils.lerp(this._w ?? 0, moving ? 1 : 0, Math.min(1, dt * 5));
    this.walk.setEffectiveWeight(this._w);
    this.idle.setEffectiveWeight(1 - this._w);
    this.walk.timeScale = 0.85;
    this.mixer.update(dt);
    this._place(dt);
  }

  setOpacity(o) {
    this.group.visible = o > 0.01;
    for (const m of this.materials) { m.opacity = o; m.depthWrite = o > 0.6; }
  }
}

/**
 * 由踏步面层（薄板）求行走路径：按标高排序，每级取中心点，并在上下各延伸一段平台。
 * @param {THREE.Mesh[]} meshes 踏步面层网格
 * @param {(v: THREE.Vector3) => THREE.Vector3} rhinoToWorld Rhino 坐标 → three 世界坐标
 * @param {number} baseZ 地下室地面标高（Rhino Z）
 */
export function stairPath(meshes, rhinoToWorld, baseZ = 0) {
  const levels = new Map();
  for (const m of meshes) {
    const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
    const s = b.getSize(new THREE.Vector3());
    if (s.z > 40 || Math.max(s.x, s.y) > 1400) continue; // 只要水平踏步板
    const key = Math.round(b.max.z / 20);
    const c = b.getCenter(new THREE.Vector3());
    const e = levels.get(key) || { x: 0, y: 0, z: b.max.z, n: 0 };
    e.x += c.x; e.y += c.y; e.n++;
    levels.set(key, e);
  }
  const pts = [...levels.values()].sort((a, b) => a.z - b.z).map((e) => new THREE.Vector3(e.x / e.n, e.y / e.n, e.z));
  if (pts.length < 3) return null;
  // 上下平台延伸
  const first = pts[0], second = pts[1];
  const d0 = first.clone().sub(second).setZ(0).normalize();
  const start = first.clone().addScaledVector(d0, 700).setZ(baseZ);
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const d1 = last.clone().sub(prev).setZ(0).normalize();
  const end = last.clone().addScaledVector(d1, 450); // 顶部只走上平台，不穿出 U 形墙
  return [start, ...pts, end].map(rhinoToWorld);
}
