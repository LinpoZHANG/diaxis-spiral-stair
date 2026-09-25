// 加载 .3dm，按 Rhino 图层 / 构造分组整理网格，并负责材质、可见性与拆分。
import * as THREE from 'three';
import { createFinishMaterial } from './materials.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const NEUTRAL = '#cdc9c1';
const DARK_SUB = { light: '#4a4a48', dark: '#8c8a85' }; // Rhino 中黑色图层的替代显示色

export class StairModel {
  constructor(config) {
    this.config = config;
    this.root = new THREE.Group(); // Rhino Z-up → three Y-up
    this.root.rotation.x = -Math.PI / 2;
    this.layers = []; // {index, id, name, fullPath, parentId, color, meshes:[], mat, group, ctx, hidden, node}
    this.groups = []; // 构造分组（仅楼梯模式）
    this.meshes = [];
    this.offset = new THREE.Vector3(); // three 坐标 + offset = 以 three 轴表示的 Rhino 坐标
    this.shared = { uCenter: { value: new THREE.Vector2() }, uRot: { value: 0 }, uSection: { value: 0 } };
    this.spiralCenter = null; // Rhino 坐标
  }

  /**
   * Load the baked model (scripts/bake-model.mjs): stair.json + stair.bin.
   * Rebuilds the same object tree three's 3DMLoader produced — meshes with Rhino attributes,
   * block instances as groups carrying their own attributes — so build() is unchanged.
   */
  async load(jsonUrl, onProgress) {
    const meta = await (await fetch(jsonUrl, { cache: 'no-cache' })).json();
    const binUrl = jsonUrl.replace(/\.json$/, '.bin');
    const res = await fetch(binUrl, { cache: 'no-cache' });
    const total = +res.headers.get('content-length') || 0;
    let buf;
    if (res.body && total) {
      const reader = res.body.getReader();
      buf = new Uint8Array(total);
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.set(value, got);
        got += value.byteLength;
        onProgress?.({ loaded: got, total });
      }
    } else {
      buf = new Uint8Array(await res.arrayBuffer());
    }
    const ab = buf.buffer;
    const mat = new THREE.MeshStandardMaterial();

    const makeMesh = (o) => {
      const g = o.g;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ab, g.pos, g.count * 3), 3));
      if (g.nrm >= 0) {
        // stored as Int8 (small download), expanded to Float32 for the normal processing that follows
        const q = new Int8Array(ab, g.nrm, g.count * 3), f = new Float32Array(q.length);
        for (let i = 0; i < q.length; i++) f[i] = q[i] / 127;
        geo.setAttribute('normal', new THREE.BufferAttribute(f, 3));
      }
      geo.setIndex(new THREE.BufferAttribute(g.idx32 ? new Uint32Array(ab, g.idx, g.idxCount) : new Uint16Array(ab, g.idx, g.idxCount), 1));
      const m = new THREE.Mesh(geo, mat);
      m.userData.attributes = o.attr;
      m.userData.objectType = o.type;
      if (o.attr.name) m.name = o.attr.name;
      return m;
    };

    const root = new THREE.Object3D();
    root.userData.layers = meta.layers;
    const defObjects = new Map();
    const refs = [];
    for (const o of meta.objects) {
      if (o.type === 'InstanceReference') { refs.push(o); continue; }
      const m = makeMesh(o);
      if (o.attr.isInstanceDefinitionObject) defObjects.set(o.attr.id, m);
      else root.add(m);
    }
    for (const r of refs) {
      const def = meta.blocks[r.idef];
      if (!def) continue;
      const g = new THREE.Object3D();
      g.applyMatrix4(new THREE.Matrix4().set(...r.xform));
      g.userData = { attributes: r.attr, objectType: 'InstanceReference', blockName: def.name };
      for (const id of def.objectIds) { const d = defObjects.get(id); if (d) g.add(d.clone()); }
      root.add(g);
    }
    return root;
  }

  /** 把 3DMLoader 的输出整理成：root → 图层节点 → 网格 */
  build(obj) {
    const cfg = this.config;
    const rLayers = obj.userData.layers || [];
    const hidden = new Set(cfg.hiddenLayers || []);
    const layerToGroup = new Map();
    cfg.stairGroups.forEach((g, i) => g.layers.forEach((l) => layerToGroup.set(l, i)));

    this.layers = rLayers.map((l, index) => ({
      index,
      id: l.id,
      parentId: l.parentLayerId,
      name: l.name,
      fullPath: l.fullPath || l.name,
      color: `rgb(${l.color.r},${l.color.g},${l.color.b})`,
      isBlack: l.color.r + l.color.g + l.color.b < 30,
      meshes: [],
      hidden: hidden.has(l.fullPath) || hidden.has(l.name),
      ctx: cfg.contextLayers?.[l.fullPath] || null,
      groupIndex: layerToGroup.has(l.fullPath) ? layerToGroup.get(l.fullPath) : undefined,
      node: new THREE.Group(),
    }));

    this.groups = cfg.stairGroups.map((g, i) => ({ ...g, index: i, meshes: [], node: new THREE.Group(), box: new THREE.Box3() }));

    // 收集网格（丢弃线、点、文字），记录图块实例所在图层
    obj.updateMatrixWorld(true);
    const found = [];
    obj.traverse((o) => {
      if (!o.isMesh) return;
      let instLayer = null, blockName = null, p = o.parent;
      while (p && p !== obj) {
        if (p.userData?.objectType === 'InstanceReference') {
          instLayer = p.userData.attributes?.layerIndex ?? null;
          blockName = p.userData.blockName;
        }
        p = p.parent;
      }
      found.push({ o, instLayer, blockName });
    });

    // objectOverrides：把个别对象移到虚拟的“室内其他”图层
    const overrides = cfg.objectOverrides || {};
    const virtual = new Map();
    const virtualLayer = (name, from) => {
      if (!virtual.has(name)) {
        const V = {
          ...from,
          index: this.layers.length,
          id: 'virtual:' + name,
          parentId: null,
          name,
          fullPath: `${from.fullPath} → ${name}`,
          meshes: [],
          instMeshes: undefined,
          hidden: false,
          ctx: { name, ...(cfg.overrideLayers?.[name] || {}) },
          groupIndex: undefined,
          node: new THREE.Group(),
          virtualOf: from,
        };
        this.layers.push(V);
        virtual.set(name, V);
      }
      return virtual.get(name);
    };

    for (const { o, instLayer, blockName } of found) {
      const a = o.userData.attributes || {};
      let L = this.layers[a.layerIndex];
      if (!L) continue;
      if (overrides[a.id]) L = virtualLayer(overrides[a.id], L);
      const IL = instLayer != null ? this.layers[instLayer] : null;
      if (L.hidden || IL?.hidden) continue;

      // 分组：优先几何所在图层，其次图块实例图层
      let gi = L.groupIndex;
      if (gi === undefined && IL) gi = IL.groupIndex;
      o.userData.layer = L;
      o.userData.instLayer = IL;
      o.userData.blockName = blockName;
      o.userData.group = gi !== undefined ? this.groups[gi] : null;
      o.castShadow = true;
      o.receiveShadow = true;
      o.geometry.computeBoundingBox();
      o.geometry.computeBoundingSphere();
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();

      // 保持世界矩阵（Rhino 坐标）
      const world = o.matrixWorld.clone();
      o.removeFromParent();
      o.matrix.copy(world);
      o.matrix.decompose(o.position, o.quaternion, o.scale);
      L.node.add(o);
      L.meshes.push(o);
      if (IL && IL !== L) (IL.instMeshes ||= []).push(o);
      this.meshes.push(o);
    }

    // 图层节点挂在组节点下（楼梯构造组）或 root 下（室内其他）
    for (const g of this.groups) this.root.add(g.node);
    this.contextNode = new THREE.Group();
    this.root.add(this.contextNode);
    for (const L of this.layers) {
      if (!L.meshes.length) continue;
      const g = L.groupIndex !== undefined ? this.groups[L.groupIndex] : null;
      (g ? g.node : this.contextNode).add(L.node);
      L.isStair = !!g;
    }
    for (const m of this.meshes) if (m.userData.group) m.userData.group.meshes.push(m);

    this._centre();
    this._findSpiral();
    this._markGroundFloorParts();
    for (const g of this.groups) if (g.mergeSides) this._mergeBySide(g);
    this._prepareMeshes();
    this._createMaterials();
    // geometry is used exactly as modelled in Rhino (no growing / trimming — that frays the edges);
    // only shading normals are smoothed across block joints
    for (const g of this.groups) if (g.seamless) this._weldNormals(g.meshes);
    // Screen-space AO reads the millimetre steps at block joints as creases (dark lines):
    // seamless finishes and their backing are lit by the sun / soft shadows only.
    for (const g of this.groups) if (g.seamless || g.assembledAs) for (const m of g.meshes) m.userData.cannotReceiveAO = true;
    return this;
  }

  /** 以楼梯范围为中心、地下室完成面为 y=0 */
  _centre() {
    this.root.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const g of this.groups) if (g.meshes.length) box.expandByObject(g.node);
    if (box.isEmpty()) box.setFromObject(this.root);
    const c = box.getCenter(new THREE.Vector3());
    this.offset.set(c.x, box.min.y, c.z);
    this.root.position.set(-c.x, -box.min.y, -c.z);
    this.root.updateMatrixWorld(true);
    for (const g of this.groups) g.box.setFromObject(g.node);
  }

  /**
   * 螺旋中心：踏步多为同一图块绕楼梯轴旋转复制，
   * 由两两实例的相对变换（平面内的旋转）求旋转中心。
   */
  _findSpiral() {
    const count = new Map();
    for (const g of this.groups) for (const m of g.meshes) if (m.userData.blockName) count.set(m.userData.blockName, (count.get(m.userData.blockName) || 0) + 1);
    const block = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const ms = this.meshes.filter((m) => m.userData.blockName === block);
    const xs = [], ys = [];
    if (ms.length > 2) {
      const inv0 = ms[0].matrix.clone().invert();
      for (const m of ms) {
        const e = m.matrix.clone().multiply(inv0).elements;
        const A = 1 - e[0], B = -e[4], C = -e[1], D = 1 - e[5];
        const det = A * D - B * C;
        if (Math.abs(det) < 1e-3) continue;
        xs.push((D * e[12] - B * e[13]) / det);
        ys.push((-C * e[12] + A * e[13]) / det);
      }
    }
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    const box = new THREE.Box3();
    for (const g of this.groups) for (const m of g.meshes) box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrix));
    const c = xs.length ? new THREE.Vector2(med(xs), med(ys)) : new THREE.Vector2((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2);
    this.spiralCenter = c;
    this.stairBoxRhino = box;
    // three 世界坐标：x = X - off.x, z = -Y - off.z
    const cw = new THREE.Vector2(c.x - this.offset.x, -c.y - this.offset.z);
    this.shared.uCenter.value.copy(cw);
    // 楼梯主体相对中心的平均方向 → 旋转使 atan 断缝落在背后
    const bc = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector2(bc.x - this.offset.x - cw.x, -bc.y - this.offset.z - cw.y);
    this.shared.uRot.value = -Math.atan2(dir.y, dir.x);
  }

  /**
   * Merge a group's pieces into one continuous piece per side of the stair (inner / outer),
   * e.g. the handrail, which is modelled in many segments.
   */
  _mergeBySide(g) {
    const ax = this.spiralCenter;
    const items = g.meshes.map((m) => {
      const c = m.geometry.boundingBox.clone().applyMatrix4(m.matrix).getCenter(new THREE.Vector3());
      return { m, r: Math.hypot(c.x - ax.x, c.y - ax.y) };
    });
    if (items.length < 2) return;
    const rs = items.map((x) => x.r);
    const split = (Math.min(...rs) + Math.max(...rs)) / 2;
    const merged = [];
    for (const side of [0, 1]) {
      const part = items.filter((x) => (x.r > split ? 1 : 0) === side).map((x) => x.m);
      if (!part.length) continue;
      const geos = part.map((m) => {
        let geo = m.geometry.clone().applyMatrix4(m.matrix);
        if (geo.index) geo = geo.toNonIndexed();
        for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
        if (!geo.attributes.normal) geo.computeVertexNormals();
        return geo;
      });
      const mg = mergeGeometries(geos);
      mg.computeBoundingBox();
      mg.computeBoundingSphere();
      const first = part[0];
      const mesh = new THREE.Mesh(mg, first.material);
      mesh.userData = { ...first.userData, blockName: null, instLayer: null, objectType: `${part.length} segments, merged` };
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = true;
      const L = first.userData.layer;
      for (const m of part) {
        m.removeFromParent();
        L.meshes.splice(L.meshes.indexOf(m), 1);
        this.meshes.splice(this.meshes.indexOf(m), 1);
      }
      L.node.add(mesh);
      L.meshes.push(mesh);
      this.meshes.push(mesh);
      merged.push(mesh);
    }
    g.meshes = merged;
    this.root.updateMatrixWorld(true);
  }

  /** 楼梯图层上属于一层的构件（楼板边包边、一层扶手等）：仅楼梯时隐藏，随建筑渐显 */
  _markGroundFloorParts() {
    const ex = this.config.stairOnlyExclude || {};
    const ids = new Set(ex.ids || []);
    const boxes = (ex.boxes || []).map((b) => new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)));
    for (const g of this.groups) {
      g.meshes = g.meshes.filter((m) => {
        const c = m.geometry.boundingBox.clone().applyMatrix4(m.matrix).getCenter(new THREE.Vector3());
        const gf = ids.has(m.userData.attributes?.id) || boxes.some((b) => b.containsPoint(c));
        m.userData.gfOnly = gf;
        return !gf;
      });
      g.box.makeEmpty();
      for (const m of g.meshes) g.box.union(new THREE.Box3().setFromObject(m));
    }
  }

  /**
   * 每个网格：
   * - 记录静止位置、构件中心（Rhino 坐标），用于逐块拆分；
   * - 写入静止时的世界坐标属性 aSurf，程序化纹理据此计算，构件移动时纹理不漂移；
   *   共享几何（图块实例）先复制一份。
   */
  _prepareMeshes() {
    this.root.updateMatrixWorld(true);
    const seen = new Set();
    const cfg = this.config.explode || {};
    const axis = this.spiralCenter;
    const zb = this.stairBoxRhino;
    const zMid = (zb.min.z + zb.max.z) / 2;
    for (const m of this.meshes) {
      if (seen.has(m.geometry.uuid)) m.geometry = m.geometry.clone();
      seen.add(m.geometry.uuid);
      StairModel._orientSolid(m);
      const pos = m.geometry.attributes.position;
      const arr = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
      m.geometry.setAttribute('aSurf', new THREE.BufferAttribute(arr, 3));
      // grain / long axis of the part (principal axis of its vertices, three world) for directional textures
      const gdir = StairModel._principalAxis(arr);
      const ga = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { ga[i * 3] = gdir.x; ga[i * 3 + 1] = gdir.y; ga[i * 3 + 2] = gdir.z; }
      m.geometry.setAttribute('aGrain', new THREE.BufferAttribute(ga, 3));

      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
      const c = b.getCenter(new THREE.Vector3());
      m.userData.rest = { p: m.position.clone(), s: m.scale.clone(), c, zMin: b.min.z };
      // 逐块拆分方向：自楼梯轴线沿平面径向外推 + 竖向拉开
      const d = new THREE.Vector2(c.x - axis.x, c.y - axis.y);
      if (d.lengthSq() < 1) d.set(1, 0);
      d.normalize();
      m.userData.horizontal = StairModel._horizontality(m) > 0.3; // panel lies flat (capping) vs. stands (wall panel)
      m.userData.radial = new THREE.Vector3(d.x, d.y, 0);
      m.userData.panelOffset = new THREE.Vector3(d.x * (cfg.panelGap ?? 240), d.y * (cfg.panelGap ?? 240), (c.z - zMid) * (cfg.verticalSpread ?? 0.08));
      m.userData.angle = Math.atan2(d.y, d.x);
    }
  }




  /**
   * Seamless finish: average shading normals of coincident vertices across all blocks of a group
   * (world space, 2 mm grid, only where normals already agree), so block joints shade continuously.
   */
  _weldNormals(meshes) {
    const Q = 2, key = (v) => `${Math.round(v.x / Q)},${Math.round(v.y / Q)},${Math.round(v.z / Q)}`;
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    const buckets = new Map();
    const items = meshes.map((m) => {
      const g = m.geometry;
      if (!g.attributes.normal) g.computeVertexNormals();
      const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
      const p = g.attributes.position, na = g.attributes.normal;
      const keys = [], normals = [];
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        const k = key(v);
        keys.push(k); normals.push(n.clone());
        (buckets.get(k) || buckets.set(k, []).get(k)).push(normals[i]);
      }
      return { m, keys, normals, nm };
    });
    for (const { m, keys, normals } of items) {
      const na = m.geometry.attributes.normal;
      const inv = new THREE.Matrix3().getNormalMatrix(new THREE.Matrix4().copy(m.matrixWorld).invert());
      for (let i = 0; i < keys.length; i++) {
        const own = normals[i], acc = new THREE.Vector3();
        for (const o of buckets.get(keys[i])) if (o.dot(own) > 0.7) acc.add(o);
        if (acc.lengthSq() < 1e-8) continue;
        acc.normalize().applyMatrix3(inv).normalize();
        na.setXYZ(i, acc.x, acc.y, acc.z);
      }
      na.needsUpdate = true;
    }
  }

  /**
   * Render as a solid: closed Rhino solids keep outward faces only (flipped if the mesh is inside-out);
   * open surfaces get an explicit reversed copy so they read from both sides with FrontSide materials.
   * Closedness: area vectors of a closed surface sum to ~0 (robust to T-junction cracks).
   */
  static _orientSolid(m) {
    let g = m.geometry;
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    const p = g.attributes.position, ix = g.index.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cr = new THREE.Vector3();
    const sumN = new THREE.Vector3();
    let area = 0, vol = 0;
    for (let i = 0; i < ix.length; i += 3) {
      a.fromBufferAttribute(p, ix[i]); b.fromBufferAttribute(p, ix[i + 1]); c.fromBufferAttribute(p, ix[i + 2]);
      cr.subVectors(b, a).cross(c.clone().sub(a));
      sumN.add(cr);
      area += cr.length();
      vol += a.dot(new THREE.Vector3().crossVectors(b, c));
    }
    if (area < 1e-9) return;
    const closed = sumN.length() / area < 0.02;
    m.userData.closed = closed;
    const flip = (arr) => { for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; } };
    if (closed) {
      if (vol < 0) {
        const arr = Array.from(ix); flip(arr); g.setIndex(arr);
        const n = g.attributes.normal;
        if (n) { for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); n.needsUpdate = true; }
      }
      return;
    }
    // open surface: append a reversed copy with flipped normals
    const cnt = p.count;
    const dup = (attr, neg) => {
      const out = new attr.array.constructor(attr.array.length * 2);
      out.set(attr.array);
      for (let i = 0; i < attr.array.length; i++) out[attr.array.length + i] = neg ? -attr.array[i] : attr.array[i];
      return new THREE.BufferAttribute(out, attr.itemSize);
    };
    for (const k of Object.keys(g.attributes)) g.setAttribute(k, dup(g.attributes[k], k === 'normal'));
    const arr = Array.from(ix);
    const back = arr.map((v) => v + cnt); flip(back);
    g.setIndex(arr.concat(back));
  }

  /** Principal (longest) axis of a point set, by power iteration on the covariance matrix */
  static _principalAxis(arr) {
    const n = arr.length / 3, step = Math.max(1, Math.floor(n / 3000));
    let mx = 0, my = 0, mz = 0, k = 0;
    for (let i = 0; i < n; i += step) { mx += arr[i * 3]; my += arr[i * 3 + 1]; mz += arr[i * 3 + 2]; k++; }
    mx /= k; my /= k; mz /= k;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let i = 0; i < n; i += step) {
      const x = arr[i * 3] - mx, y = arr[i * 3 + 1] - my, z = arr[i * 3 + 2] - mz;
      xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
    }
    const v = new THREE.Vector3(1, 0.7, 0.4);
    for (let it = 0; it < 24; it++) {
      v.set(xx * v.x + xy * v.y + xz * v.z, xy * v.x + yy * v.y + yz * v.z, xz * v.x + yz * v.y + zz * v.z);
      const l = v.length();
      if (l < 1e-9) return new THREE.Vector3(1, 0, 0);
      v.divideScalar(l);
    }
    return v;
  }

  /** 面积加权的 |法线 Z|（Rhino 坐标）：0 = 竖向板，1 = 水平板 */
  static _horizontality(m) {
    const g = m.geometry, p = g.attributes.position, ix = g.index;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const cnt = ix ? ix.count : p.count;
    let up = 0, tot = 0;
    for (let i = 0; i < cnt; i += 3) {
      a.fromBufferAttribute(p, ix ? ix.getX(i) : i).applyMatrix4(m.matrix);
      b.fromBufferAttribute(p, ix ? ix.getX(i + 1) : i + 1).applyMatrix4(m.matrix);
      c.fromBufferAttribute(p, ix ? ix.getX(i + 2) : i + 2).applyMatrix4(m.matrix);
      n.subVectors(b, a).cross(c.sub(a));
      const area = n.length();
      if (area < 1e-6) continue;
      up += Math.abs(n.z);
      tot += area;
    }
    return tot ? up / tot : 0;
  }

  /**
   * 设置单个构件的拆分状态
   * @param {THREE.Mesh} m
   * @param {number} e 0 = 就位，1 = 完全拆开
   * @param {THREE.Vector3} tierOffset 该构造组完全拆开时的整体位移（Rhino 坐标）
   */
  placeMesh(m, e, tierOffset) {
    const r = m.userData.rest;
    const f = 1 - (this.config.explode?.shrink ?? 0.05) * e; // 以构件中心缩小，拉开板缝
    m.position.copy(r.p).multiplyScalar(f).addScaledVector(r.c, 1 - f)
      .addScaledVector(tierOffset, e).addScaledVector(m.userData.panelOffset, e);
    m.scale.copy(r.s).multiplyScalar(f);
  }

  /** 施工顺序：构件在静止位置基础上平移 offset（Rhino 坐标） */
  placeMeshOffset(m, offset) {
    const r = m.userData.rest;
    m.position.copy(r.p).add(offset);
    m.scale.copy(r.s);
  }

  /** three 场景坐标 → Rhino 世界坐标（毫米） */
  toRhino(v) {
    const w = v.clone().add(this.offset); // three 轴
    return new THREE.Vector3(w.x, -w.z, w.y);
  }

  _createMaterials() {
    for (const L of this.layers) {
      if (!L.meshes.length) continue;
      const g = L.groupIndex !== undefined ? this.groups[L.groupIndex] : null;
      const spec = g ? { ...g } : L.ctx || {};
      L.spec = spec;
      L.mat = createFinishMaterial(spec, this.shared);
      L.baseOpacity = L.mat.userData.baseOpacity;
      if (L.meshes.some((m) => m.userData.gfOnly)) L.gfMat = createFinishMaterial(spec, this.shared);
      if (g?.assembledAs) {
        const src = this.groups.find((x) => x.id === g.assembledAs);
        if (src) L.backMat = createFinishMaterial({ ...src, band: 1 }, this.shared);
      }
      for (const m of L.meshes) {
        m.material = m.userData.gfOnly ? L.gfMat : L.mat;
        m.userData.baseMat = m.material;
        m.castShadow = spec.finish !== 'glass';
      }
    }
  }

  /** Swap layers with a backing finish in / out (assembled stair) */
  setBacking(on) {
    for (const L of this.layers) {
      if (!L.backMat) continue;
      for (const m of L.meshes) {
        if (m.userData.gfOnly) continue;
        const want = on ? L.backMat : L.mat;
        if (m.userData.baseMat !== want) { m.material = want; m.userData.baseMat = want; }
      }
    }
  }

  setColorMode(mode, dark) {
    for (const L of this.layers) {
      for (const mat of [L.mat, L.gfMat, L.backMat]) {
        if (!mat) continue;
        const u = mat.userData.uniforms;
        if (mode === 'layer') {
          mat.color.set(L.isBlack ? DARK_SUB[dark ? 'dark' : 'light'] : L.color);
          if (u) u.uStrength.value = 0;
          if (mat.userData.finish !== 'glass') { mat.metalness = 0; mat.roughness = 0.75; }
        } else {
          const sp = mat.userData.spec || L.spec;
          mat.color.set(sp.color || NEUTRAL);
          if (u) u.uStrength.value = 1;
          if (mat.userData.finish !== 'glass') { mat.metalness = sp.metalness ?? 0; mat.roughness = sp.roughness ?? 0.8; }
        }
      }
    }
  }

  /** Rotating section: clip every finish material with `plane` (null = off) */
  setSection(plane) {
    this.shared.uSection.value = plane ? 1 : 0;
    for (const L of this.layers) for (const mat of [L.mat, L.gfMat, L.backMat]) {
      if (!mat) continue;
      // back faces are only needed to paint the cut (poché)
      const side = plane ? THREE.DoubleSide : mat.userData.finish === 'glass' ? THREE.DoubleSide : THREE.FrontSide;
      if (mat.side !== side) { mat.side = side; mat.needsUpdate = true; }
      const want = plane ? [plane] : null;
      if ((mat.clippingPlanes?.length || 0) !== (want?.length || 0)) { mat.clippingPlanes = want; mat.needsUpdate = true; }
    }
  }

  static _setOpacity(mat, op) {
    const transparent = op < 0.999;
    if (mat.transparent !== transparent) mat.needsUpdate = true;
    mat.transparent = transparent;
    mat.opacity = op;
    mat.depthWrite = mat.userData.finish !== 'glass' && op > 0.5;
  }

  /**
   * 设置图层不透明度（0 = 隐藏）
   * @param {number} opacity 普通构件
   * @param {number} [gfOpacity] 一层构件（stairOnlyExclude），默认同 opacity
   */
  applyLayer(L, opacity, gfOpacity = opacity) {
    L._op = opacity * L.baseOpacity;
    L._gfOp = gfOpacity * L.baseOpacity;
    L.node.visible = L._op > 0.001 || L._gfOp > 0.001;
    StairModel._setOpacity(L.mat, L._op);
    if (L.gfMat) StairModel._setOpacity(L.gfMat, L._gfOp);
    if (L.backMat) StairModel._setOpacity(L.backMat, L._op);
    for (const m of L.meshes) m.castShadow = (m.userData.gfOnly ? L._gfOp : L._op) > 0.5 && L.mat.userData.finish !== 'glass';
  }

  /**
   * 逐个构件的可见性：图层不透明度 + Rhino 实例图层规则（几何图层或实例图层任一关闭即隐藏）
   * + 额外的逐构件条件 extra(m)
   */
  applyMeshVisibility(isInstOn, extra) {
    for (const m of this.meshes) {
      const L = m.userData.layer;
      const op = m.userData.gfOnly ? L._gfOp : L._op;
      const IL = m.userData.instLayer;
      m.visible = op > 0.001 && (IL ? isInstOn(IL) : true) && (extra ? extra(m) : true);
    }
  }
}
