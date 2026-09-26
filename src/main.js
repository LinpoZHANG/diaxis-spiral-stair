import '@fontsource/jost/200.css';
import '@fontsource/jost/300.css';
import '@fontsource/jost/400.css';
import '@fontsource/jost/500.css';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Viewer } from './scene.js';
import { StairModel } from './model.js';
import { Walker, stairPath } from './person.js';

const MODEL_URL = './model/stair.json'; // baked by `npm run bake` from the Rhino .3dm
const CONFIG_URL = './config/layers.json';
const PERSON_PATH = './models/person/';

// removed controls resolve to a detached stub, so leftover bindings are harmless
const $ = (s, r = document) => r.querySelector(s) || Object.assign(document.createElement('div'), { hidden: true });
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
const pad = (n) => String(n).padStart(2, '0');
const fmt = (v) => Math.round(v).toLocaleString('en-GB');
const smooth = (k) => k * k * (3 - 2 * k);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const TBC = ' <span class="tag">TBC</span>';

const store = {
  get(k, d) { try { const v = localStorage.getItem('stair3d.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stair3d.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  mode: 'stair', // stair = presentation, context = coordination
  color: 'material',
  explode: 0, // 0 = assembled, 1 = exploded
  explodeMode: 'axial', // axial (vertical, along the stair axis) | diagonal
  assembly: null, // construction sequence progress 0..1 (null = off)
  solo: null,
  groupOn: [],
  groupOp: [],
  layerOn: {},
  layerOp: {},
  ctxFade: 0, // building visibility in stair mode 0..1
  building: false,
  person: true,
  showcase: true,
  walk: null, // first-person walk-through: { s, dir, wait }
  night: false, // night mode (bird's-eye and walk-through only)
  section: null, // rotating section through the stair axis: { sweep, paused, angle }
  lens: 24, // mm (35 mm format)
  grid: false,
  rotate: true,
  dark: false, // always the light studio look (no theme switch; night is a separate mode)
};

const viewer = new Viewer($('#viewport'), $('#labels'));
// background style (temporary switch for review): ?bg=clean|monogram|sheet|monolith
viewer.bgStyle = new URLSearchParams(location.search).get('bg') || 'clean';
const canvas = viewer.renderer.domElement;
let model;
let ready = false;
let selected = null;
let walker = null;
let walkCurve = null; // stair centre-line (three world coordinates, floor level)
const EYE = 1600; // eye height (mm)
const WALK_SPEED = 430; // mm/s along the path
const LOOKBACK_START = 1900; // start turning round this far (mm) before the top
const TOP_HOLD = 3.0; // seconds holding the look-back at the top (showcase)
let ctxBox = new THREE.Box3();
let sequence = []; // stair meshes in construction order
const labels = [];
const explodeStep = new THREE.Vector3(); // diagonal explode step per group (Rhino, mm)
let axialGap = 1000; // vertical explode step per tier (mm)

// ---------- Theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  viewer.setTheme(state.dark);
  if (model) model.setColorMode(state.color, state.dark);
}
applyTheme();
// redraw the background once the brand font is available (canvas text needs the loaded face)
document.fonts?.load('200 100px Jost').then(() => viewer.setTheme(state.dark)).catch(() => {});

// ---------- Loading ----------
const bootT0 = performance.now();
async function boot() {
  const setStep = (text, num = '', pct = null) => {
    $('#load-step').textContent = text;
    $('#load-num').textContent = num;
    $('.bar').classList.toggle('indeterminate', pct == null);
    if (pct != null) $('#bar-fill').style.width = `${pct}%`;
  };
  try {
    setStep('Reading configuration…');
    const config = await (await fetch(CONFIG_URL, { cache: 'no-cache' })).json();
    model = new StairModel(config);

    setStep('Downloading model', '', 0);
    const obj = await model.load(MODEL_URL, (e) => {
      setStep('Downloading model', `${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`, (e.loaded / e.total) * 100);
    });

    setStep('Building scene…');
    await new Promise((r) => setTimeout(r, 30));
    model.build(obj);
    viewer.scene.add(model.root);

    const stairBox = stairBounds(0);
    const sz = stairBox.getSize(new THREE.Vector3());
    explodeStep.set(0, sz.z * 1.0, sz.y * 0.1);
    axialGap = sz.y * 0.55;
    viewer.fitScene(stairBox);

    initState();
    ctxBox = contextBounds();
    makeWalkCurve();
    prepareParts();
    buildSequence();
    buildGroupList();
    buildLayerList();
    buildLabels();
    applyTheme();
    setMode('stair', false);
    initWalker();
    buildNight();

    if (state.showcase) {
      $('#panel-left').classList.add('collapsed'); // cinematic opening: panels tucked away
      $('#panel-right').classList.add('collapsed');
      updateViewShift();
      viewer.view('home', ctxBox, false);
      ready = true;
      startShowcase();
    } else {
      viewer.view('home', stairBounds(0), false);
      ready = true;
    }
    // title card: hold briefly, then fade into the showcase
    const shown = performance.now() - bootT0;
    setTimeout(() => $('#loader').classList.add('done'), Math.max(0, 2600 - shown) + 700);
  } catch (err) {
    console.error(err);
    setStep('Failed to load: ' + (err.message || err), '', 0);
  }
}

function initState() {
  state.groupOn = model.groups.map(() => true);
  state.groupOp = model.groups.map(() => 1);
  for (const L of model.layers) {
    if (!L.meshes.length && !L.instMeshes) continue;
    const g = L.groupIndex !== undefined ? model.groups[L.groupIndex] : null;
    // inner layers (hidden behind finishes) are off by default in the coordination view
    state.layerOn[L.index] = !g?.hiddenWhenAssembled && !L.ctx?.inner;
    state.layerOp[L.index] = 1;
  }
}

let walkPts = null;
let walkStartS = 0; // arc length of the first tread (the path starts a little before it, on the floor)
function makeWalkCurve() {
  const g = model.groups.find((x) => x.id === 'tread');
  if (!g) return;
  const off = model.offset;
  const toWorld = (v) => new THREE.Vector3(v.x - off.x, v.z - off.y, -v.y - off.z);
  walkPts = stairPath(g.meshes, toWorld, 0);
  if (walkPts) {
    walkCurve = new THREE.CatmullRomCurve3(walkPts, false, 'centripetal', 0.5);
    const L = walkCurve.getLength(), P1 = walkPts[1];
    let bu = 0, bd = Infinity;
    for (let i = 0; i <= 600; i++) { const d = walkCurve.getPointAt(i / 600).distanceToSquared(P1); if (d < bd) { bd = d; bu = i / 600; } }
    walkStartS = Math.max(0, bu * L - 250); // standing at the foot of the first tread
  }
}
async function initWalker() {
  if (!walkPts) return;
  const w = new Walker(walkPts);
  try {
    await w.load(PERSON_PATH);
    walker = w;
    viewer.scene.add(w.group);
  } catch (e) {
    console.warn('Scale figure could not be loaded', e);
  }
}

// ---------- Explode ----------
const toWorldDir = (v) => new THREE.Vector3(v.x, v.z, -v.y);
/** Explode offset of one part when fully exploded (Rhino coordinates) */
function meshOffset(m) {
  if (state.explodeMode === 'axial') return m.userData.exVec;
  return explodeStep.clone().multiplyScalar(m.userData.group.index);
}
/** Mean explode offset of a group (labels, shadows) */
function groupOffset(i) {
  const g = model.groups[i];
  if (state.explodeMode === 'axial') return g.meanEx || new THREE.Vector3();
  return explodeStep.clone().multiplyScalar(i);
}

/**
 * Per part: where it sits relative to the stair (zone: soffit under the flight / cap on the wall heads /
 * tread / wall), which side of the flight (inside / outside of the spiral), and its explode vector.
 */
function prepareParts() {
  const off = model.offset;
  const toWorld = (v) => new THREE.Vector3(v.x - off.x, v.z - off.y, -v.y - off.z);
  const ax = model.spiralCenter;
  const samples = walkCurve ? Array.from({ length: 301 }, (_, i) => walkCurve.getPointAt(i / 300)) : [];
  for (const g of model.groups) {
    for (const m of g.meshes) {
      const r = m.userData.rest;
      const rb = m.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().compose(r.p, m.quaternion, r.s));
      m.userData.restBoxWorld = new THREE.Box3().setFromPoints([toWorld(rb.min), toWorld(rb.max)]);
      const w = toWorld(r.c);
      m.userData.restWorld = w;
      // nearest point of the walking line (horizontally)
      let best = null, bd = Infinity;
      for (const p of samples) { const d = (p.x - w.x) ** 2 + (p.z - w.z) ** 2; if (d < bd) { bd = d; best = p; } }
      const pathY = best ? best.y : 0;
      const rPath = best ? Math.hypot(best.x + off.x - ax.x, -best.z - off.z - ax.y) : 0;
      const rMesh = Math.hypot(r.c.x - ax.x, r.c.y - ax.y);
      const side = rMesh >= rPath ? 1 : -1;
      m.userData.side = side;
      // walking direction here (Rhino coordinates, horizontal): risers face down-stairs
      if (best) {
        const u = samples.indexOf(best) / 300;
        const tw = walkCurve.getTangentAt(Math.min(0.999, Math.max(0.001, u)));
        m.userData.upStair = new THREE.Vector3(tw.x, -tw.z, 0).normalize();
      }
      const flat = m.userData.horizontal;
      m.userData.zone = !flat ? 'wall' : w.y < pathY - 40 ? 'soffit' : w.y > pathY + 300 ? 'cap' : 'tread';
      m.userData.rMesh = rMesh;
    }
  }
  explodeLayout();
  unrollCurvedPanels();
}

/**
 * Curved sheet materials (plywood, plasterboard) wrap round the spiral: a single straight grain direction
 * cannot describe them. Their texture coordinates are re-computed in the unrolled surface — arc length
 * round the stair axis, radius, and height (minus the helix pitch for soffit sheets) — all in real mm,
 * with the grain along the arc. Proportions stay 1:1 however far the sheet turns.
 */
function unrollCurvedPanels() {
  const c = model.shared.uCenter.value; // spiral axis (three world x, z)
  const UNROLL = new Set(['ply', 'plasterboard']);
  for (const g of model.groups) {
    if (!UNROLL.has(g.finish)) continue;
    for (const m of g.meshes) {
      const surf = m.geometry.attributes.aSurf;
      if (!surf) continue;
      const n = surf.count, th = new Float32Array(n), rr = new Float32Array(n);
      let sx = 0, sz = 0;
      for (let i = 0; i < n; i++) { const dx = surf.getX(i) - c.x, dz = surf.getZ(i) - c.y; sx += dx; sz += dz; }
      const tm = Math.atan2(sz, sx);
      let tMin = Infinity, tMax = -Infinity, rSum = 0;
      for (let i = 0; i < n; i++) {
        const dx = surf.getX(i) - c.x, dz = surf.getZ(i) - c.y;
        const t = tm + Math.atan2(Math.sin(Math.atan2(dz, dx) - tm), Math.cos(Math.atan2(dz, dx) - tm));
        th[i] = t; rr[i] = Math.hypot(dx, dz); rSum += rr[i];
        tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
      }
      if (tMax - tMin < THREE.MathUtils.degToRad(18)) continue; // flat-ish piece: straight grain is right
      const rRef = rSum / n;
      // soffit sheets climb with the flight: remove the helix pitch (least squares of height on arc length)
      let pitch = 0;
      if (m.userData.zone === 'soffit') {
        let su = 0, sy = 0, suu = 0, suy = 0;
        for (let i = 0; i < n; i++) { const u = th[i] * rRef, y = surf.getY(i); su += u; sy += y; suu += u * u; suy += u * y; }
        const den = n * suu - su * su;
        if (Math.abs(den) > 1e-6) pitch = (n * suy - su * sy) / den;
      }
      const arr = new Float32Array(n * 3), gr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const u = th[i] * rRef;
        arr[i * 3] = u; arr[i * 3 + 1] = surf.getY(i) - pitch * u; arr[i * 3 + 2] = rr[i];
        gr[i * 3] = 1; // grain along the arc
      }
      m.geometry.setAttribute('aSurf', new THREE.BufferAttribute(arr, 3));
      m.geometry.setAttribute('aGrain', new THREE.BufferAttribute(gr, 3));
      m.userData.unrolled = true;
    }
  }
}

/**
 * Exploded view following the real build-up. Only the outer wall is opened; its layers leave the steel core in
 * their true order on each face — stair side: PLY then PB towards the stair; outside: PLY then PB outwards.
 * Soffit layers drop in order (timber, PLY, PB); tread layers and the wall-head layers rise in order.
 * The steel frame, timber battens, the inner wall and the micro-cement coat stay (the coat is hidden where opened).
 */
const EXPLODE = {
  wall: { ply: 380, pb: 760 },
  soffit: { soffit: 320, ply: 640, pb: 960 },
  up: { treadply: 300, tread: 640, steelcap: 320, ply: 640, pb: 960, railpost: 1280, handrail: 1600 },
};
function explodeLayout() {
  const posts = model.groups.find((g) => g.id === 'posts')?.meshes.filter((m) => m.userData.side > 0) || [];
  const rs = posts.map((m) => m.userData.rMesh).sort((a, b) => a - b);
  const rCore = rs.length ? rs[rs.length >> 1] : 0;
  for (const g of model.groups) {
    const mean = new THREE.Vector3();
    for (const m of g.meshes) {
      const u = m.userData, rad = u.radial;
      const out = new THREE.Vector3(rad.x, rad.y, 0); // away from the stair axis
      const v = new THREE.Vector3();
      const zone = u.zone;
      if (zone === 'soffit' && EXPLODE.soffit[g.id] != null) v.set(0, 0, -EXPLODE.soffit[g.id]);
      else if ((zone === 'tread' || g.id === 'treadply' || g.id === 'tread') && EXPLODE.up[g.id] != null && (g.id === 'treadply' || g.id === 'tread')) v.set(0, 0, EXPLODE.up[g.id]);
      else if (u.side > 0 && zone === 'wall' && EXPLODE.wall[g.id] != null) {
        const face = u.rMesh < rCore ? -1 : 1; // stair-facing face moves in, outside face moves out
        v.copy(out).multiplyScalar(face * EXPLODE.wall[g.id]);
      } else if (u.side > 0 && EXPLODE.up[g.id] != null && !(g.id === 'treadply' || g.id === 'tread')) v.set(0, 0, EXPLODE.up[g.id]);
      u.exVec = v;
      u.panelOffset = new THREE.Vector3();
      mean.add(v);
    }
    g.meanEx = g.meshes.length ? mean.divideScalar(g.meshes.length) : mean;
  }
}

/**
 * Construction sequence plan, from config.sequence: each step selects parts (group + block /
 * orientation filters), a motion and a duration. Within a step parts go in bottom-up, round the stair.
 */
let plan = { steps: [], total: 1 };
const TRAVEL = 1.1; // seconds a part takes to travel into place
const seqTime = () => (state.assembly ?? 0) * plan.total;
function buildSequence() {
  for (const m of model.meshes) m.userData.seq = null;
  const byId = new Map(model.groups.map((g, i) => [g.id, i]));
  const hits = (m, f) => (!f.blocks || f.blocks.includes(m.userData.blockName)) && (!f.orientation || (f.orientation === 'horizontal') === !!m.userData.horizontal) && (!f.zone || m.userData.zone === f.zone);
  const used = new Set();
  const steps = [];
  let t = 0;
  const addStep = (st, ms) => {
    ms.sort((p, q) => Math.round((p.userData.rest.zMin - q.userData.rest.zMin) / 60) || p.userData.angle - q.userData.angle);
    // "with: previous" shares the time slot (and caption) of the step before
    const host = st.with === 'previous' && steps.length ? steps[steps.length - 1] : null;
    if (host) t = host.t0;
    else if (st.delay) t += st.delay;
    const D = host ? host.t1 - host.t0 : st.seconds ?? 2.5;
    const motion = st.motion || 'drop';
    // mitre: pair each tread with the riser below its nosing (riser top ≈ tread underside)
    const pairIdx = new Map();
    let pairCount = 0;
    if (motion === 'mitre' || motion === 'corner') {
      const key = (m) => {
        const b = m.userData.restBoxWorld;
        return Math.round((motion === 'corner' ? b.max.y : m.userData.horizontal ? b.min.y : b.max.y) / 60);
      };
      const keys = [...new Set(ms.map(key))].sort((a, b) => a - b);
      ms.forEach((m) => pairIdx.set(m, keys.indexOf(key(m))));
      pairCount = keys.length;
    }
    const step = { label: st.label, hint: !!st.hint, motion, camera: st.camera, t0: t, t1: t + D, meshes: ms, groups: [...new Set(ms.map((m) => m.userData.group.index))] };
    ms.forEach((m, i) => {
      used.add(m);
      const r = m.userData.radial;
      let offset = new THREE.Vector3(), t0 = t, t1 = t + D;
      if (motion === 'drop') offset.set(r.x * 150, r.y * 150, st.drop ?? 1800);
      else if (motion === 'rise') offset.set(0, 0, -(st.drop ?? 1500));
      else if (motion === 'slide') offset.set(r.x * (st.slide ?? 1400), r.y * (st.slide ?? 1400), 200);
      else if (motion === 'mitre') {
        // a step at a time, never through the stair: the tread settles from above, the riser slides in
        // from the front along the tread below — the two 45° cut faces close on the nosing edge
        const u = m.userData.upStair || new THREE.Vector3(1, 0, 0);
        if (m.userData.horizontal) offset.set(0, 0, 70);
        else offset.copy(u).multiplyScalar(-70);
      }
      else if (motion === 'corner') {
        // steel corner joints pushed diagonally (front-and-up) straight into the step's right angle
        const u = m.userData.upStair || new THREE.Vector3(1, 0, 0);
        const out = m.userData.radial.clone().multiplyScalar(m.userData.side || 1);
        offset.copy(out).multiplyScalar(320).setZ(-260);
      }
      if (motion === 'appear' || motion === 'grow') t1 = t0;
      else if (motion === 'fade') {
        // large panels appear where they are, one after another
        // the large panels fade in over exactly the same span as the panels being placed
        t0 = t; t1 = t + D;
      }
      else if (motion === 'mitre' || motion === 'corner') {
        const tr = motion === 'mitre' ? 2.6 : 1.6, k = pairIdx.get(m), n = pairCount;
        t0 = t + Math.max(0, D - tr) * (n > 1 ? k / (n - 1) : 0); t1 = t0 + tr;
      }
      else if (motion !== 'coat') {
        t0 = t + Math.max(0, D - TRAVEL) * (ms.length > 1 ? i / (ms.length - 1) : 0); t1 = t0 + Math.min(TRAVEL, D);
      }
      m.userData.seq = { t0, t1, motion, offset };
    });
    if (motion === 'grow' && ms.length) {
      const b = new THREE.Box3();
      ms.forEach((m) => b.union(m.userData.restBoxWorld));
      step.grow = { y0: b.min.y - 5, y1: b.max.y + 5, plane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0) };
    }
    if (host) {
      host.meshes.push(...ms);
      for (const gi of step.groups) if (!host.groups.includes(gi)) host.groups.push(gi);
      t = host.t1 + 0.3;
    } else if (ms.length) { steps.push(step); t += D + 0.3; }
  };
  for (const st of model.config.sequence || []) {
    if (st.motion === 'hint') { steps.push({ label: st.label, motion: 'hint', t0: t, t1: t + st.seconds, meshes: [], groups: [] }); t += st.seconds + 0.3; continue; }
    const gis = (st.groups || [st.group]).map((id) => byId.get(id)).filter((x) => x !== undefined);
    const ms = [];
    for (const gi of gis) for (const m of model.groups[gi].meshes) {
      if (used.has(m) || (st.include && !hits(m, st.include)) || (st.exclude && hits(m, st.exclude))) continue;
      ms.push(m);
    }
    addStep(st, ms);
  }
  // anything not covered by the configured steps appears at the end
  const rest = model.groups.flatMap((g) => g.meshes).filter((m) => !used.has(m));
  if (rest.length) addStep({ label: 'Remaining parts', motion: 'appear', seconds: 1 }, rest);
  plan = { steps, total: Math.max(1, t) };
  for (const g of model.groups) g.coatStep = steps.find((x) => x.motion === 'coat' && x.groups.includes(g.index)) || null;
}
/** Progress of one part in the sequence: −1 = not started, 0..1 = travelling, 1 = in place */
function seqK(m) {
  const q = m.userData.seq;
  if (!q) return 1;
  const tt = seqTime();
  if (tt < q.t0) return -1;
  return q.t1 > q.t0 ? clamp01((tt - q.t0) / (q.t1 - q.t0)) : 1;
}
function currentStepIndex() {
  if (state.assembly == null) return -1;
  const tt = seqTime();
  let idx = 0;
  plan.steps.forEach((st, i) => { if (tt >= st.t0) idx = i; });
  return idx;
}

/**
 * Construction-sequence camera (reference view): inside the stair, below the work, looking UP the
 * flight so the risers face the camera, pitched down onto the treads. It climbs as the work rises.
 */
let seqCamS = null;
const at = (x) => walkCurve.getPointAt(clamp01(x / walkCurve.getLength()));
/** Main view: inside the stair, below the work, looking up the flight. Drifts up very slowly, one way only. */
function seqCameraPose() {
  const L = walkCurve.getLength();
  const k = smooth(clamp01(seqTime() / plan.total));
  const sPos = THREE.MathUtils.lerp(1500, 1500 + L * 0.3, k);
  return { pos: at(sPos - 1400).add(new THREE.Vector3(0, 2600, 0)), look: at(sPos + 900).add(new THREE.Vector3(0, 150, 0)) };
}
/** Soffit view: standing in the basement under the flight, looking up at the soffit framing */
let _soffitPose = null;
function soffitPose() {
  if (_soffitPose) return _soffitPose;
  const g = model.groups.find((x) => x.id === 'soffit');
  const ms = (g?.meshes || []).filter((m) => m.userData.restWorld.y > 1700 && m.userData.restWorld.y < 3000);
  const C = new THREE.Vector3();
  ms.forEach((m) => C.add(m.userData.restWorld));
  if (ms.length) C.divideScalar(ms.length); else C.set(0, 2200, 0);
  const axis = sectionAxis();
  const out = new THREE.Vector3(C.x - axis.x, 0, C.z - axis.z).normalize();
  const tan = new THREE.Vector3(-out.z, 0, out.x);
  // stand under the higher part of the flight (head-room) and look back down along the soffit
  const pos = C.clone().addScaledVector(out, -300).addScaledVector(tan, -1300 * soffitSide(C, tan)).setY(1400); // under the higher part: head-room
  _soffitPose = { pos, look: C.clone().add(new THREE.Vector3(0, 120, 0)) };
  return _soffitPose;
}
/** which way along the tangent the flight goes down (stand on the lower side) */
function soffitSide(C, tan) {
  const L = walkCurve.getLength();
  let best = 0, bd = Infinity;
  for (let i = 0; i <= 200; i++) { const p = walkCurve.getPointAt(i / 200); const d = p.distanceToSquared(new THREE.Vector3(C.x, p.y, C.z)); if (d < bd) { bd = d; best = i / 200; } }
  const down = walkCurve.getPointAt(Math.max(0, best - 0.06)).sub(walkCurve.getPointAt(best));
  return Math.sign(down.dot(tan)) || 1;
}
/**
 * Mitre view: the stair is cut along the walking line (vertical plane) and seen square-on,
 * so the tread / riser profile and the 45° mitred nosings read as a section. Tracks slowly up.
 */
const mitrePlane = new THREE.Plane();
let seqCut = false;
function mitrePose() {
  const st = plan.steps.find((x) => x.camera === 'mitre');
  const L = walkCurve.getLength();
  const k = st ? smooth(clamp01((seqTime() - st.t0) / (st.t1 - st.t0))) : 0;
  const sAt = THREE.MathUtils.lerp(L * 0.2, L * 0.45, k);
  const P = at(sAt);
  const tan = walkCurve.getTangentAt(clamp01(sAt / L)).setY(0).normalize();
  const n = new THREE.Vector3(-tan.z, 0, tan.x); // horizontal, square to the walking line
  mitrePlane.normal.copy(n).negate(); // keep the far half (dot(x - P, n) < 0)
  mitrePlane.constant = n.dot(P);
  const pos = P.clone().addScaledVector(n, 1300).addScaledVector(tan, -350).add(new THREE.Vector3(0, 650, 0));
  return { pos, look: P.clone().add(new THREE.Vector3(0, 150, 0)).addScaledVector(tan, 200) };
}

/** 0..1 weight of the soffit view (eases in before the soffit step, out after it) */
function soffitWeight() { return camWeight('soffit'); }
function camWeight(name) {
  const sts = plan.steps.filter((x) => x.camera === name);
  if (!sts.length) return 0;
  const a = Math.min(...sts.map((x) => x.t0)), b = Math.max(...sts.map((x) => x.t1));
  const tt = seqTime(), ramp = name === 'mitre' ? 2.6 : 1.8;
  return smooth(clamp01((tt - (a - ramp)) / ramp)) * (1 - smooth(clamp01((tt - (b + 0.4)) / ramp)));
}
function seqCamera(dt, fly = false) {
  if (!walkCurve) return;
  const main = seqCameraPose();
  const w = soffitWeight();
  let pos = main.pos, look = main.look;
  if (w > 0) { const sp = soffitPose(); pos = main.pos.clone().lerp(sp.pos, w); look = main.look.clone().lerp(sp.look, w); }
  const wm = camWeight('mitre');
  if (wm > 0) { const mp = mitrePose(); pos = pos.clone().lerp(mp.pos, wm); look = look.clone().lerp(mp.look, wm); }
  // mitre view: everything but the treads and their base is set aside
  const focusOn = wm > 0.35;
  if (focusOn !== !!seqCut) { seqCut = focusOn; applyVisibility(); }
  if (fly) { viewer.setFirstPerson(true); viewer.flyTo(pos, look, viewer.fovForLens(20), 1800); return; }
  if (viewer.busy) return;
  const cam = viewer.camera;
  const k = Math.min(1, dt * 2.5);
  cam.position.lerp(pos, k);
  viewer.controls.target.lerp(look, k);
  cam.lookAt(viewer.controls.target);
  const fov = viewer.fovForLens(w > 0.5 ? 18 : 20);
  if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 2); cam.updateProjectionMatrix(); }
  viewer.needsRender = true;
}

/** Applied finish (coat): fades in place over its step */
function coatFade(g) {
  const st = g.coatStep;
  if (!st) return 1;
  return smooth(clamp01((seqTime() - st.t0) / (st.t1 - st.t0)));
}
/** Where the parts now being installed will land (world coordinates) */
const _focus = new THREE.Vector3();
function landingFocus() {
  const tt = seqTime();
  const sum = new THREE.Vector3();
  let n = 0;
  for (const st of plan.steps) for (const m of st.meshes) {
    const q = m.userData.seq;
    if (tt >= q.t0 - 0.2 && tt <= Math.max(q.t1, q.t0 + 1.2) + 0.3) { sum.add(m.userData.restWorld); n++; }
  }
  if (n) _focus.copy(sum.divideScalar(n));
  return _focus;
}

/** Explode amount of a single mesh (0 = in place) */
function meshExplode(m) {
  if (state.assembly == null) return state.explode;
  const k = seqK(m);
  return k < 0 ? 1 : 1 - smooth(k);
}

/**
 * "grow" steps: reveal their parts from the bottom up with a rising clipping plane (a mask sweeping up
 * the flight, so a soffit board appears to be laid out). While its step runs, each part draws with its
 * own copy of its material carrying that plane — parts already in place share the original and are not cut.
 */
function growMaterial(mesh, plane) {
  const base = mesh.userData.baseMat;
  let gm = mesh.userData.growMat;
  if (!gm || gm.userData.src !== base) {
    const ud = base.userData;
    base.userData = {}; // userData holds circular references (spec → meshes); clone() would JSON-copy it
    gm = base.clone();
    base.userData = ud;
    gm.onBeforeCompile = base.onBeforeCompile;
    gm.customProgramCacheKey = base.customProgramCacheKey;
    gm.userData = { ...ud, src: base };
    mesh.userData.growMat = gm;
  }
  gm.clippingPlanes = [plane];
  gm.clipShadows = true;
  return gm;
}
/** per-part opacity (fade / mitre steps): a private material copy while the part fades in */
function fadeMaterial(mesh, k) {
  const base = mesh.userData.baseMat;
  let fm = mesh.userData.fadeMat;
  if (!fm || fm.userData.src !== base) {
    const ud = base.userData;
    base.userData = {};
    fm = base.clone();
    base.userData = ud;
    fm.onBeforeCompile = base.onBeforeCompile;
    fm.customProgramCacheKey = base.customProgramCacheKey;
    fm.userData = { ...ud, src: base };
    fm.transparent = true;
    mesh.userData.fadeMat = fm;
  }
  fm.opacity = k;
  fm.depthWrite = false; // stays see-through for the whole fade (no pop half way)
  return fm;
}
/**
 * Large panels (fade) follow the placing of the small pre-blocked panels in the same step:
 * opacity = share of those panels already in place (0 % → 100 %), linear, no shadow while fading.
 */
function updateFades() {
  for (const st of plan.steps) {
    if (st.motion !== 'fade' && st.motion !== 'mitre' && !st.meshes.some((m) => m.userData.seq?.motion === 'fade')) continue;
    const placers = st.meshes.filter((m) => m.userData.seq && m.userData.seq.motion !== 'fade');
    let progress = null;
    if (placers.length && state.assembly != null) {
      let sum = 0;
      for (const m of placers) sum += Math.max(0, seqK(m));
      progress = sum / placers.length;
    }
    for (const m of st.meshes) {
      const q = m.userData.seq;
      if (!q || (q.motion !== 'fade' && q.motion !== 'mitre')) continue;
      let k = state.assembly == null ? 1 : seqK(m);
      if (q.motion === 'fade' && progress != null && k >= 0) k = progress;
      const fading = state.assembly != null && k >= 0 && k < 1;
      const op = q.motion === 'fade' ? k : smooth(k);
      const want = fading ? fadeMaterial(m, op) : m.userData.baseMat;
      if (m.material !== want && (want !== m.userData.baseMat || m.material === m.userData.fadeMat)) m.material = want;
      m.castShadow = !fading;
    }
  }
}
function updateGrow() {
  updateFades();
  const tt = seqTime();
  for (const st of plan.steps) {
    if (!st.grow) continue;
    const g = st.grow;
    const active = state.assembly != null && tt >= st.t0 && tt < st.t1;
    if (active) g.plane.constant = THREE.MathUtils.lerp(g.y0, g.y1, smooth(clamp01((tt - st.t0) / (st.t1 - st.t0))));
    for (const m of st.meshes) {
      const want = active ? growMaterial(m, g.plane) : m.userData.baseMat;
      if (m.material !== want && (active || m.material === m.userData.growMat)) m.material = want;
    }
  }
}
function updatePositions() {
  const seq = state.assembly != null;
  for (const g of model.groups) {
    for (const m of g.meshes) {
      if (seq) model.placeMeshOffset(m, m.userData.seq ? m.userData.seq.offset.clone().multiplyScalar(1 - smooth(Math.max(0, seqK(m)))) : new THREE.Vector3());
      else model.placeMesh(m, state.explode, meshOffset(m));
    }
  }
  updateGrow();
  // labels follow their group
  for (const l of labels) {
    const i = l.userData.i;
    l.position.copy(l.userData.anchor).addScaledVector(groupOffset(i), seq ? 0 : state.explode);
  }
  let far = new THREE.Vector3();
  model.groups.forEach((g, i) => { const o = toWorldDir(groupOffset(i)).multiplyScalar(seq ? 0 : state.explode); if (o.y > far.y) far = o; });
  viewer.setShadowHeight(far);
  viewer.shadowsDirty();
}
function groupExplode(i) {
  const ms = model.groups[i].meshes;
  if (!ms.length) return 0;
  let s = 0;
  for (const m of ms) s += meshExplode(m);
  return s / ms.length;
}
/** Group currently being installed during the construction sequence */
function currentGroup() {
  const i = currentStepIndex();
  return i < 0 ? null : plan.steps[i]?.groups[0] ?? null;
}
/** Caption for the construction sequence: "Step n / N — label" */
function updateSeqCaption() {
  const i = currentStepIndex();
  if (i < 0) return;
  const txt = `Step ${i + 1} / ${plan.steps.length}`;
  if ($('#cap-en').textContent !== txt) {
    $('#cap-num').textContent = '03';
    $('#cap-en').textContent = txt;
    $('#cap-title').textContent = plan.steps[i].label;
  }
  const st = plan.steps[i];
  $('#caption').classList.toggle('hint', st.motion === 'hint' || !!st.hint);
  $('#cap-fill').style.width = `${Math.min(100, ((seqTime() - st.t0) / (st.t1 - st.t0)) * 100)}%`;
}

let explodeAnim = null;
function setExplode(t) {
  const was = isAssembled();
  state.explode = t;
  updatePositions();
  if (was !== isAssembled() || t < 0.3) applyVisibility();
  $('#explode').value = Math.round(t * 100);
  $('#explode-val').textContent = `${Math.round(t * 100)}%`;
  $('#btn-explode').textContent = t > 0.5 ? 'Assemble' : 'Explode';
  $('[data-action="explode"]').classList.toggle('on', t > 0.5 && state.assembly == null);
  $('[data-action="explode"] span').textContent = t > 0.5 ? 'Assemble' : 'Explode';
  updateLabels();
}
function animateExplode(to, ms = 1100, refit = false) {
  explodeAnim = { from: state.explode, to, t0: performance.now(), ms };
  if (refit) viewer.view('home', stairBounds(to));
}
function setExplodeMode(m) {
  state.explodeMode = m;
  $$('[data-exmode]').forEach((b) => b.classList.toggle('active', b.dataset.exmode === m));
  setExplode(state.explode);
}
const isAssembled = () => state.explode < 0.005 && state.assembly == null && state.solo == null && !state.section;

// ---------- Construction sequence (manual) ----------
let seqAnim = null;
let seqFollow = false; // manual sequence: camera follows until the user takes over
const SEQ_SECONDS = 30;
function startSequence() {
  stopShowcase();
  exitSection();
  exitWalk(false);
  if (state.building) { state.building = false; $('[data-toggle="building"]').classList.remove('on'); }
  state.solo = null;
  $('[data-action="build"]').classList.add('on');
  const begin = () => {
    state.assembly = 0; seqAnim = { time: 0, playing: true }; seqFollow = true; seqCamS = null; _focus.set(0, 0, 0);
    setRotate(false); seqCamera(0, true); applyVisibility(); openBuildHud();
  };
  explodeAnim = null;
  if (state.explode > 0) setExplode(0);
  begin();
}
function stopSequence(finish = false) {
  if (state.assembly == null && !seqAnim) return;
  seqAnim = null;
  $('#build-hud').hidden = true;
  if (seqFollow && !state.walk) viewer.setFirstPerson(false);
  seqFollow = false;
  if (!state.showcase) $('#caption').hidden = true;
  $('#caption').classList.remove('hint');
  state.assembly = null;
  updateGrow();
  if (seqCut) seqCut = false;
  if (finish) state.explode = 0;
  $('[data-action="build"]').classList.remove('on');
  setExplode(state.explode);
  applyVisibility();
  refreshGroupList();
}

// ---------- Build HUD: play / pause, step back / forward, scrub the installation ----------
function openBuildHud() {
  const ticks = $('#bh-ticks');
  ticks.innerHTML = plan.steps.map((st) => `<i style="left:${(st.t0 / plan.total) * 100}%" title="${st.label}"></i>`).join('');
  $('#build-hud').hidden = false;
  updateBuildHud();
}
function updateBuildHud() {
  if (!seqAnim) return;
  const i = Math.max(0, currentStepIndex());
  const st = plan.steps[i];
  $('#bh-num').textContent = `Step ${i + 1} / ${plan.steps.length}`;
  const t = $('#bh-title');
  if (t.textContent !== st.label) t.textContent = st.label;
  t.classList.toggle('hint', !!st.hint);
  const f = `${Math.min(100, (seqAnim.time / plan.total) * 100)}%`;
  $('#bh-fill').style.width = f;
  $('#bh-head').style.left = f;
  const done = seqAnim.time >= plan.total;
  $('#bh-play-icon').innerHTML = seqAnim.playing ? '<path d="M9 6v12M15 6v12"/>' : done ? '<path d="M5 12a7 7 0 1 0 2-5M5 4v4h4"/>' : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>';
}
function seekBuild(time) {
  if (!seqAnim) return;
  seqAnim.time = THREE.MathUtils.clamp(time, 0, plan.total + 0.5);
  seqFollow = true;
  viewer.setFirstPerson(true);
}
function stepBuild(dir) {
  if (!seqAnim) return;
  const i = Math.max(0, currentStepIndex());
  const into = seqAnim.time - plan.steps[i].t0;
  const j = dir < 0 ? (into > 0.8 ? i : i - 1) : i + 1;
  seekBuild(j < 0 ? 0 : j >= plan.steps.length ? plan.total : plan.steps[j].t0);
}
$('#bh-play').addEventListener('click', () => {
  if (!seqAnim) return;
  if (seqAnim.time >= plan.total) seekBuild(0);
  seqAnim.playing = !seqAnim.playing || seqAnim.time === 0;
});
$('#bh-prev').addEventListener('click', () => stepBuild(-1));
$('#bh-next').addEventListener('click', () => stepBuild(1));
$('#bh-exit').addEventListener('click', () => { stopSequence(true); viewer.view('home', stairBounds(0)); });
{
  const track = $('#bh-track');
  const at = (e) => { const r = track.getBoundingClientRect(); return clamp01((e.clientX - r.left) / r.width) * plan.total; };
  track.addEventListener('pointerdown', (e) => { if (!seqAnim) return; seqAnim.drag = true; track.setPointerCapture(e.pointerId); seekBuild(at(e)); });
  track.addEventListener('pointermove', (e) => { if (seqAnim?.drag) seekBuild(at(e)); });
  track.addEventListener('pointerup', () => { if (seqAnim) seqAnim.drag = false; });
}

// ---------- Bounds ----------
function stairBounds(t = state.explode) {
  const box = new THREE.Box3();
  const gap = model.config.explode?.panelGap ?? 240;
  model.groups.forEach((g, i) => {
    if (!g.meshes.length || !state.groupOn[i]) return;
    if (t < 1e-3 || !g.meshes[0].userData.restBoxWorld) { box.union(g.box); return; }
    for (const m of g.meshes) box.union(m.userData.restBoxWorld.clone().translate(toWorldDir(meshOffset(m)).multiplyScalar(t)));
  });
  if (box.isEmpty()) model.groups.forEach((g) => box.union(g.box));
  return box.expandByVector(new THREE.Vector3(gap, gap, gap).multiplyScalar(t));
}
function allBounds() {
  model.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of model.meshes) if (m.visible) box.union(new THREE.Box3().setFromObject(m));
  return box.isEmpty() ? stairBounds() : box;
}
/** Building + stair (default layers), independent of current visibility */
function contextBounds() {
  model.root.updateMatrixWorld(true);
  const box = stairBounds(0);
  for (const L of model.layers) if (L.meshes.length && !L.isStair && state.layerOn[L.index]) box.expandByObject(L.node);
  return box;
}
const currentBounds = () => (state.mode === 'stair' ? (state.ctxFade > 0.5 ? ctxBox : stairBounds()) : allBounds());

// ---------- Visibility ----------
const MITRE_KEEP = new Set(['step', 'treadply', 'tread']);
let outerCoatOp = 1;
function applyVisibility() {
  const assembled = isAssembled();
  outerCoatOp = 1;
  const backing = assembled && state.color === 'material';
  model.setBacking(backing);
  for (const L of model.layers) {
    if (!L.mat) continue;
    if (state.mode === 'stair') {
      let ctxOp = state.layerOn[L.index] ? state.ctxFade * state.layerOp[L.index] : 0;
      if (L.ctx?.buried && state.ctxFade < 0.999) ctxOp = 0; // only the visible surfaces take part in the fade
      // slabs the stair connects to: shown with the assembled stair, fading out as it comes apart
      const withStair = L.ctx?.withStair && state.layerOn[L.index] ? state.layerOp[L.index] * (state.assembly != null ? 0 : clamp01(1 - state.explode * 4)) : 0;
      if (!L.isStair) { model.applyLayer(L, Math.max(withStair, ctxOp)); continue; }
      const i = L.groupIndex;
      let op = state.groupOn[i] ? state.groupOp[i] : 0;
      // assembled: hide layers enclosed by finishes (avoids mesh-seam sparkle, faster);
      // a layer with a backing finish stays, dressed as that finish, so joints never show through
      if (assembled && model.groups[i].hiddenWhenAssembled && !model.groups[i].assembledAs) op = 0;
      if (state.solo != null && state.solo !== i) op *= 0.06;
      if (state.assembly != null && model.groups[i].coat) op *= coatFade(model.groups[i]);
      // mitre view: parts other than the treads fade away as the camera turns (and back after)
      if (state.assembly != null && !MITRE_KEEP.has(model.groups[i].id)) op *= 1 - smooth(camWeight('mitre'));
      // exploded: an applied coat is not a panel — it stays with its substrate (not shown separately)
      // (on the outer, exploded side only — the assembled inner wall keeps its finish)
      if (state.assembly == null && model.groups[i].coat) outerCoatOp = clamp01(1 - state.explode * 6);
      // ground-floor parts on stair layers follow the building
      model.applyLayer(L, op, state.groupOn[i] ? state.ctxFade : 0);
    } else {
      let op = state.layerOn[L.index] ? state.layerOp[L.index] : 0;
      // hidden layer with a backing finish: keep it as backing while its finish layer is shown
      if (!op && backing && L.backMat) {
        const src = model.groups.find((x) => x.id === model.groups[L.groupIndex].assembledAs);
        const srcL = src && model.layers.find((x) => x.groupIndex === src.index);
        if (srcL && state.layerOn[srcL.index]) op = state.layerOp[srcL.index];
      }
      model.applyLayer(L, op);
    }
  }
  const coatVis = state.assembly == null && state.explode > 0.02 ? (m) => !(m.userData.group?.coat && m.userData.side > 0 && outerCoatOp < 0.5) : null;
  const seqVis = state.assembly != null ? (m) => {
    const g = m.userData.group;
    if (!g) return !seqCut;
    if (m.userData.gfOnly) return true;
    return seqK(m) >= 0;
  } : null;
  model.applyMeshVisibility((IL) => (state.mode === 'context' ? !!state.layerOn[IL.index] : true), seqVis || coatVis);
  if (selected && !isPickable(selected)) select(null);
  updateLabels();
  viewer.shadowsDirty();
}

// ---------- Modes ----------
function setMode(mode, fly = true) {
  state.mode = mode;
  $$('.segmented [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('[data-show]').forEach((s) => (s.hidden = s.dataset.show !== mode));
  $('#mode-hint').textContent = mode === 'stair' ? 'Presentation · view only' : 'Coordination';
  stopSequence();
  if (mode === 'context') { exitWalk(false); exitSection(); }
  if (mode === 'context') {
    stopShowcase();
    state.solo = null;
    explodeAnim = null;
    setExplode(0);
  }
  setRotate(mode === 'stair');
  setGrid(false);
  applyVisibility();
  refreshGroupList();
  refreshLayerList();
  renderProps(selected);
  if (fly) viewer.view('home', mode === 'stair' ? stairBounds() : allBounds());
}

// ---------- Showcase loop ----------
// context → building fades → stair → exploded → construction sequence → building returns
const CHAPTERS = [
  { num: '01', kicker: 'Context', title: 'The stair in its setting' },
  { num: '02', kicker: 'Object', title: 'The stair' },
  { num: '03', kicker: 'Sequence', title: 'How it is built' },
  { num: '04', kicker: 'Section', title: 'Cut through the build-up' },
  { num: '05', kicker: 'Exploded view', title: 'Layer by layer' },
  { num: '06', kicker: 'Walk-through', title: 'At eye level' },
];
const TIMELINE = [
  { dur: 6.0, cap: 0, ctx: [1, 1], frame: 'context' },
  { dur: 3.0, cap: 1, ctx: [1, 0], frame: 'stair' },
  { dur: 4.0, cap: 1, ctx: [0, 0] },
  { dur: 30.0, cap: 2, asm: [0, 1], follow: true }, // duration set from the plan
  { dur: 2.0, cap: 2, frame: 'stair' },
  { dur: 14.0, cap: 3, section: true, frame: 'section' },
  { dur: 3.5, cap: 4, ex: [0, 1], frame: 'exploded' },
  { dur: 5.0, cap: 4, ex: [1, 1] },
  { dur: 2.5, cap: 4, ex: [1, 0], frame: 'stair' },
  { dur: 2.0, cap: 5, ctx: [0, 1], walk: 'enter' },
  { dur: 14.0, cap: 5, ctx: [1, 1], walk: 'go' }, // duration set from the path length
  { dur: 16.0, cap: 5, ctx: [1, 1], walk: 'exit', night: true, spin: true }, // one night orbit from the opening angle
];
let CYCLE = TIMELINE.reduce((a, s) => a + s.dur, 0);
let showT = 0, lastSeg = -1, lastCap = -1, lastFrameTime = performance.now();

function startShowcase() {
  $('#panel-left').classList.add('collapsed');
  updateViewShift();
  if (state.mode !== 'stair') setMode('stair', false);
  stopSequence();
  state.solo = null;
  select(null);
  state.showcase = true;
  if (state.explode > 0) setExplode(0);
  showT = 0; lastSeg = -1; lastCap = -1;
  if (state.walk) exitWalk(false);
  exitSection();
  TIMELINE.find((x) => x.asm).dur = plan.total + 1;
  if (walkCurve) { TIMELINE.find((x) => x.walk === 'go').dur = walkCurve.getLength() / WALK_SPEED + TOP_HOLD; CYCLE = TIMELINE.reduce((a, x) => a + x.dur, 0); }
  explodeAnim = null;
  if (state.explodeMode !== 'axial') setExplodeMode('axial');
  setRotate(true);
  viewer.controls.autoRotateSpeed = 0.9;
  $('#caption').hidden = false;
  $('[data-toggle="showcase"]').classList.add('on');
  refreshGroupList();
}
function stopShowcase() {
  if (!state.showcase) return;
  state.showcase = false;
  state.tourNight = false;
  if (innerWidth >= 900) { $('#panel-left').classList.remove('collapsed'); updateViewShift(); }
  if (state.walk) state.walk.loop = true; // keep walking, now manually
  if (state.section) $('#sec-hud').hidden = false;
  state.building = state.ctxFade > 0.5;
  if (state.assembly != null) { state.assembly = null; setExplode(state.explode); }
  if (!state.walk) viewer.setFirstPerson(false);
  $('[data-toggle="building"]').classList.toggle('on', state.building);
  $('[data-toggle="showcase"]').classList.remove('on');
  $('#caption').hidden = true;
  viewer.controls.autoRotateSpeed = 0.6;
  applyVisibility();
  refreshGroupList();
}

function stepShowcase(dt) {
  showT = (showT + dt) % CYCLE;
  let t = showT, i = 0;
  while (t > TIMELINE[i].dur) { t -= TIMELINE[i].dur; i++; }
  const seg = TIMELINE[i];
  const k = smooth(Math.min(1, t / seg.dur));
  const lin = Math.min(1, t / seg.dur);
  const lerp = (r, dflt) => (r ? THREE.MathUtils.lerp(r[0], r[1], k) : dflt);

  // building
  const ctx = lerp(seg.ctx, i === 0 ? 1 : 0);
  if (!seg.walk && state.walk) exitWalk(false);
  // explode / assembly
  const ex = lerp(seg.ex, 0);
  const asm = seg.asm ? THREE.MathUtils.lerp(seg.asm[0], seg.asm[1], lin) : null;
  const leftSeq = state.assembly != null && asm == null;
  const visChange = (state.assembly == null) !== (asm == null) || Math.abs(state.ctxFade - ctx) > 1e-4;
  state.ctxFade = ctx;
  state.assembly = asm;
  if (Math.abs(ex - state.explode) > 1e-4 || asm != null) {
    const was = isAssembled();
    state.explode = ex;
    updatePositions();
    if (was !== isAssembled() || ex < 0.3) applyVisibility();
  }
  if (leftSeq) { state.explode = ex; updatePositions(); } // every part back in place, whatever was skipped
  if (visChange) applyVisibility();
  if (asm != null) { applyVisibility(); refreshGroupList(); updateSeqCaption(); }
  // construction sequence: view down the flight from inside the stair, rising with the work
  if (seg.follow && asm != null) {
    if (lastSeg !== i) { seqCamS = null; _focus.set(0, 0, 0); seqCamera(dt, true); }
    else seqCamera(dt);
  }

  state.tourNight = !!seg.night;
  viewer.controls.autoRotateSpeed = seg.spin ? 60 / (seg.dur - 1) : 0.9; // one full turn over the segment
  // first-person chapter
  if (seg.walk === 'go' && !state.walk) enterWalk(true);
  if (seg.walk === 'go' && state.walk) {
    // tour: from the basement up to the ground floor; dusk falls half way and the step lights come on
    const walkT = Math.min(1, t / Math.max(1, seg.dur - TOP_HOLD));
    state.walk.dir = 1;
    const L = walkCurve.getLength();
    state.walk.s = walkStartS + (L - walkStartS) * smooth(walkT);
    state.tourNight = walkT > 0.5;
    state.walk.wait = 0;
    stepWalk(dt);
  }

  if (i !== lastSeg) {
    lastSeg = i;
    if (seqCut && !seg.follow) seqCut = false;
    if (seg.section && !state.section) enterSection(true);
    if (!seg.section && state.section) exitSection();
    if (!seg.follow && !seg.walk && viewer.firstPerson) {
      // leaving the inside view: fly back out to the bird's-eye before orbiting again
      viewer.setFirstPerson(false);
      viewer.view('home', stairBounds(0));
      setRotate(true);
    }
    if (seg.walk === 'enter') enterWalk(true);
    if (seg.walk === 'exit') { exitWalk(false); viewer.view('home', ctxBox, true); setRotate(true); }
    if (seg.frame && !viewer.busy) {
      const box = seg.frame === 'context' ? ctxBox : seg.frame === 'exploded' ? stairBounds(1) : seg.frame === 'sequence' ? stairBounds(0.6) : stairBounds(0);
      if (seg.frame === 'section') box.expandByScalar(-250); // a touch closer for the section
      viewer.frameTo(box, Math.min(seg.dur, 6) * 1000, seg.frame === 'exploded' ? 1.05 : seg.frame === 'sequence' ? 1.0 : 0.92);
    }
  }
  if (seg.cap !== lastCap) {
    lastCap = seg.cap;
    const c = CHAPTERS[seg.cap];
    $('#cap-num').textContent = c.num;
    $('#cap-en').textContent = c.kicker;
    $('#cap-title').textContent = c.title;
  }
  // chapter progress
  let a = 0, b = 0;
  TIMELINE.forEach((s, j) => { if (s.cap === seg.cap && Math.abs(j - i) <= 2) { if (j <= i) a += j < i ? s.dur : t; b += s.dur; } });
  $('#cap-fill').style.width = `${Math.min(100, (a / b) * 100)}%`;
}

viewer.onFrame((now) => {
  const rawDt = Math.min(0.5, (now - lastFrameTime) / 1000); // real time (slow phones: fades keep their duration)
  const dt = Math.min(0.1, rawDt);
  lastFrameTime = now;
  if (!ready) return;

  if (explodeAnim) {
    const { from, to, t0, ms } = explodeAnim;
    const k = Math.min(1, (now - t0) / ms);
    setExplode(from + (to - from) * smooth(k));
    if (k >= 1) explodeAnim = null;
  }
  if (seqAnim) {
    if (seqAnim.playing && !seqAnim.drag) seqAnim.time += dt;
    if (seqAnim.time >= plan.total + 0.5) { seqAnim.time = plan.total + 0.5; seqAnim.playing = false; }
    state.assembly = Math.min(1, seqAnim.time / plan.total);
    $('#caption').hidden = true;
    updateBuildHud();
    updatePositions();
    applyVisibility();
    if (seqFollow) seqCamera(dt);
    updateLabels();
    refreshGroupList();
  }

  if (state.showcase && state.mode === 'stair') { stepShowcase(dt); updateGrow(); }
  else if (state.mode === 'stair') {
    const target = state.building ? 1 : 0;
    if (Math.abs(state.ctxFade - target) > 1e-3) {
      state.ctxFade += (target - state.ctxFade) * Math.min(1, dt * 3);
      if (Math.abs(state.ctxFade - target) < 2e-3) state.ctxFade = target;
      applyVisibility();
    }
  }

  if (state.walk && !state.showcase) stepWalk(dt);
  if (state.section) updateSection(dt);
  stepNight(rawDt);

  // scale figure: only on the finished stair, not in first person
  if (walker) {
    // hidden while the camera is inside the stair (sequence view / walk-through)
    const busy = state.assembly != null || state.walk || viewer.firstPerson || state.section || night.k > 0.3 ? 1 : state.explode;
    const op = state.person ? clamp01(1 - busy * 8) : 0;
    walker.setOpacity(op);
    if (op > 0) walker.update(dt);
    viewer.animating = op > 0;
  }
});

// ---------- First-person walk-through ----------
const _look = new THREE.Vector3();
let lookOff = { yaw: 0, pitch: 0 }, dragLook = null;
function eyePose(s, dir) {
  const L = walkCurve.getLength();
  const u = clamp01(s / L);
  const p = walkCurve.getPointAt(u);
  // look along the direction of travel (average tangent over the next ~0.6 m), not at a chord across the spiral
  const t = walkCurve.getTangentAt(u).add(walkCurve.getTangentAt(clamp01((s + dir * 600) / L))).multiplyScalar(dir);
  const h = new THREE.Vector2(t.x, t.z);
  const rise = t.y / Math.max(h.length(), 1e-3);
  h.normalize();
  // natural head pitch: slightly up when climbing, looking down to the treads when descending
  const pitch = dir > 0 ? Math.min(rise, 1) * 0.35 - 0.05 : Math.max(rise, -1) * 0.7 - 0.2;
  // approaching the ground-floor slab: turn round and look back down the flight just climbed
  const pos = new THREE.Vector3(p.x, p.y + EYE, p.z);
  let az = Math.atan2(h.y, h.x), el = Math.atan(pitch);
  if (dir > 0) {
    const b = smooth(clamp01((s - (L - LOOKBACK_START)) / (LOOKBACK_START - 250)));
    if (b > 0) {
      const back = walkCurve.getPointAt(clamp01((s - 2600) / L)).add(new THREE.Vector3(0, 250, 0)).sub(pos);
      const azB = Math.atan2(back.z, back.x);
      const elB = Math.atan2(back.y, Math.hypot(back.x, back.z));
      let d = azB - az;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      az += d * b;
      el += (elB - el) * b;
    }
  }
  const tgt = pos.clone().add(new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(1000));
  return { pos, tgt };
}
function enterWalk(showcase = false) {
  if (!walkCurve) return;
  if (!showcase) stopShowcase();
  exitSection();
  stopSequence();
  explodeAnim = null;
  if (state.explode > 0) setExplode(0);
  if (state.mode !== 'stair') setMode('stair', false);
  state.walk = { s: walkStartS, dir: 1, wait: showcase ? 0 : 1.6, loop: !showcase };
  if (!showcase) { state.building = true; $('[data-toggle="building"]').classList.add('on'); }
  const { pos, tgt } = eyePose(state.walk.s, state.walk.dir);
  viewer.setFirstPerson(true);
  viewer.flyTo(pos, tgt, viewer.fovForLens(state.lens), 1500);
  lookOff = { yaw: 0, pitch: 0 };
  $('#fp-hud').hidden = false;
  $('[data-toggle="walk"]').classList.add('on');
}
function exitWalk(fly = true) {
  if (!state.walk) return;
  state.walk = null;
  viewer.setFirstPerson(false);
  $('#fp-hud').hidden = true;
  $('[data-toggle="walk"]').classList.remove('on');
  if (fly) viewer.view('home', state.ctxFade > 0.5 ? ctxBox : stairBounds(0));
}
function stepWalk(dt) {
  const w = state.walk;
  if (!w || viewer.busy) return; // wait for the fly-in
  const L = walkCurve.getLength();
  if (w.wait > 0) w.wait -= dt;
  else {
    w.s += WALK_SPEED * dt * w.dir;
    if (w.s >= L) { w.s = L; if (w.loop) { w.dir = -1; w.wait = 2.5; } }
    if (w.s <= walkStartS) { w.s = walkStartS; w.dir = 1; w.wait = 2.5; }
  }
  const { pos, tgt } = eyePose(w.s, w.dir);
  // gentle head bob while walking
  const moving = w.wait <= 0 && w.s > 0 && w.s < L;
  pos.y += moving ? Math.sin((w.s / 330) * Math.PI) * 8 : 0;
  // smooth look direction + manual look-around offset (decays when released)
  if (!dragLook) { lookOff.yaw *= 0.96; lookOff.pitch *= 0.96; }
  const dirV = tgt.clone().sub(pos);
  const sph = new THREE.Spherical().setFromVector3(dirV);
  sph.theta += lookOff.yaw;
  sph.phi = THREE.MathUtils.clamp(sph.phi - lookOff.pitch, 0.3, Math.PI - 0.3);
  const want = pos.clone().add(new THREE.Vector3().setFromSpherical(sph));
  _look.lerp(want, _look.lengthSq() ? Math.min(1, dt * 4) : 1);
  const cam = viewer.camera;
  cam.position.copy(pos);
  cam.lookAt(_look);
  viewer.controls.target.copy(_look);
  const fov = viewer.fovForLens(state.lens);
  if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 5); cam.updateProjectionMatrix(); }
  viewer.needsRender = true;
}
function setLens(mm) {
  state.lens = mm;
  $$('[data-lens]').forEach((b) => b.classList.toggle('active', +b.dataset.lens === mm));
  $('#fp-lens').textContent = `${mm} mm`;
}
canvas.addEventListener('pointerdown', (e) => { if (state.walk) dragLook = { x: e.clientX, y: e.clientY }; });
addEventListener('pointermove', (e) => {
  if (!dragLook) return;
  lookOff.yaw -= (e.clientX - dragLook.x) * 0.004;
  lookOff.pitch -= (e.clientY - dragLook.y) * 0.004;
  lookOff.pitch = THREE.MathUtils.clamp(lookOff.pitch, -0.9, 0.9);
  dragLook = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { dragLook = null; });

// ---------- Rotating section (section perspective through the stair axis) ----------
const secPlane = new THREE.Plane();
let secHelper = null;
const SWEEP = THREE.MathUtils.degToRad(55); // sweep either side of facing the camera
const SWEEP_PERIOD = 14; // seconds for one full sweep cycle
function buildSectionHelper() {
  const box = stairBounds(0);
  const size = box.getSize(new THREE.Vector3());
  const w = Math.hypot(size.x, size.z) * 1.08, h = size.y * 1.12;
  const g = new THREE.Group();
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xc2541d, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide }));
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => new THREE.Vector3(x, y, 0));
  const frame = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xc2541d, transparent: true, opacity: 0.85 }));
  // axis line
  const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -h / 2, 0), new THREE.Vector3(0, h / 2, 0)]),
    new THREE.LineDashedMaterial({ color: 0xc2541d, dashSize: 60, gapSize: 50, transparent: true, opacity: 0.6 }));
  axis.computeLineDistances();
  g.add(fill, frame, axis);
  g.userData.midY = (box.min.y + box.max.y) / 2;
  g.visible = false;
  g.traverse((o) => { o.raycast = () => {}; });
  viewer.scene.add(g);
  secHelper = g;
}
function sectionAxis() {
  const c = model.shared.uCenter.value; // spiral axis, world xz
  return new THREE.Vector3(c.x, 0, c.y);
}
/** Plane through the stair axis; the camera-side half is cut away so the section faces the viewer */
function updateSection(dt) {
  const sec = state.section;
  if (!sec) return;
  const p = sectionAxis();
  if (!sec.paused) {
    sec.sweep += dt;
    const cam = viewer.camera.position;
    const az = Math.atan2(cam.z - p.z, cam.x - p.x); // camera direction around the axis
    sec.angle = az + SWEEP * Math.sin((sec.sweep / SWEEP_PERIOD) * Math.PI * 2);
  }
  const n = new THREE.Vector3(Math.cos(sec.angle), 0, Math.sin(sec.angle)); // points towards the camera side
  secPlane.normal.copy(n).negate();
  secPlane.constant = n.dot(p);
  if (secHelper) {
    secHelper.position.set(p.x, secHelper.userData.midY, p.z);
    secHelper.rotation.set(0, Math.atan2(n.x, n.z), 0);
  }
  viewer.shadowsDirty(); // the cut moves: its shadow does too
  $('#sec-angle').textContent = `${Math.round(((THREE.MathUtils.radToDeg(sec.angle) % 360) + 360) % 360)}°`;
  viewer.needsRender = true;
}
function enterSection(showcase = false) {
  if (!showcase) stopShowcase();
  exitWalk(false);
  stopSequence();
  if (state.mode !== 'stair') setMode('stair', false);
  explodeAnim = null;
  if (state.explode > 0) setExplode(0);
  if (!secHelper) buildSectionHelper();
  state.section = { sweep: 0, paused: false, angle: 0 };
  model.setSection(secPlane);
  secHelper.visible = true;
  updateSection(0);
  applyVisibility();
  $('#sec-hud').hidden = showcase;
  $('#sec-pause').textContent = 'Pause';
  $('[data-toggle="section"]').classList.add('on');
}
function exitSection() {
  if (!state.section) return;
  state.section = null;
  model.setSection(null);
  if (secHelper) secHelper.visible = false;
  $('#sec-hud').hidden = true;
  $('[data-toggle="section"]').classList.remove('on');
  applyVisibility();
}

// ---------- Night: recessed step lights + a DIAXIS wordmark projected on the stair wall ----------
const night = { k: 0, group: new THREE.Group(), lamps: [], gobo: null };
const LAMP_COLOR = 0xffb468;
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const NIGHT = { lamp: 4.5e3, fill: 0.5, neon: 0.35 }; // candela-ish, scene units are mm
function buildNight() {
  if (!walkCurve) return;
  model.root.updateMatrixWorld(true);
  const walls = model.groups.filter((g) => g.id === 'microcement').flatMap((g) => g.meshes);
  const ray = new THREE.Raycaster();
  const fixtureGeo = new THREE.CircleGeometry(28, 32); // round recessed step light
  const fixtureMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(LAMP_COLOR).multiplyScalar(2.2), toneMapped: false, transparent: true });
  night.fixtureMat = fixtureMat;
  const L = walkCurve.getLength();
  const pts = walkPts.slice(1, -1); // one light per tread
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i];
    let u = 0, bd = Infinity;
    for (let j = 0; j <= 300; j++) { const d = walkCurve.getPointAt(j / 300).distanceToSquared(P); if (d < bd) { bd = d; u = j / 300; } }
    const tan = walkCurve.getTangentAt(u).setY(0).normalize();
    const n = new THREE.Vector3(-tan.z, 0, tan.x); // the balustrade on one side of the flight
    const o = P.clone().add(new THREE.Vector3(0, 220, 0));
    ray.set(o, n); ray.far = 1600;
    const hit = ray.intersectObjects(walls, false)[0];
    if (!hit) continue;
    const wn = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (wn.dot(n) > 0) wn.negate(); // face back into the stair
    const fx = new THREE.Mesh(fixtureGeo, fixtureMat);
    fx.position.copy(hit.point).addScaledVector(wn, 2);
    fx.lookAt(fx.position.clone().add(wn));
    fx.raycast = () => {};
    night.group.add(fx);
    // phones: every 3rd lamp carries a real light (mobile GPUs cap the number of lights per material)
    if (!IS_TOUCH || i % 3 === 1) {
      const light = new THREE.PointLight(LAMP_COLOR, 0, IS_TOUCH ? 2600 : 1500, 2);
      light.position.copy(hit.point).addScaledVector(wn, 70).add(new THREE.Vector3(0, -40, 0));
      night.group.add(light);
      night.lamps.push(light);
    }
  }
  // overall night light: warm interior fill + the neon wordmark behind the stair as a coloured rim light
  night.fill = new THREE.HemisphereLight(0xffc790, 0x2a1d18, 0);
  night.neon = new THREE.DirectionalLight(0xffc48a, 0);
  night.neon2 = new THREE.DirectionalLight(0xffe2c0, 0);
  night.group.add(night.fill, night.neon, night.neon.target, night.neon2, night.neon2.target);
  night.group.visible = false;
  viewer.scene.add(night.group);
}
/** night only for the bird's-eye / walk-through views: not in section, build sequence or exploded view */
const nightAllowed = () => (state.night || (state.showcase && state.tourNight)) && !state.section && state.assembly == null && state.explode < 0.02;
function stepNight(dt) {
  // the neon sign hangs behind the stair as seen from the camera: rim light from there
  if (night.neon && night.k > 0) {
    const t = viewer.controls.target, d = viewer.camera.position.clone().sub(t).setY(0).normalize();
    const side = new THREE.Vector3(-d.z, 0, d.x);
    night.neon.position.copy(t).addScaledVector(d, -6000).addScaledVector(side, 1500).add(new THREE.Vector3(0, 2500, 0));
    night.neon.target.position.copy(t);
    night.neon2.position.copy(t).addScaledVector(d, -6000).addScaledVector(side, -2500).add(new THREE.Vector3(0, 800, 0));
    night.neon2.target.position.copy(t);
  }
  const want = nightAllowed() ? 1 : 0;
  if (night.k === want) return;
  // linear in real time (2 s dusk / dawn), eased for display
  night.k = want > night.k ? Math.min(want, night.k + dt / 2) : Math.max(want, night.k - dt / 2);
  const k = smooth(night.k);
  viewer.setNight(k);
  night.group.visible = k > 0.01;
  for (const l of night.lamps) l.intensity = NIGHT.lamp * (IS_TOUCH ? 2.6 : 1) * k;
  if (night.fill) { night.fill.intensity = NIGHT.fill * k; night.neon.intensity = NIGHT.neon * k; night.neon2.intensity = NIGHT.neon * 0.45 * k; }
  if (night.fixtureMat) night.fixtureMat.opacity = k;
}
function setNightMode(on) {
  state.night = on;
  $('[data-toggle="night"]').classList.toggle('on', on);
  viewer.needsRender = true;
}

// ---------- Build-up list ----------
function buildGroupList() {
  const ol = $('#group-list');
  ol.innerHTML = '';
  let n = 0;
  model.groups.forEach((g, i) => {
    if (!g.meshes.length) return;
    g.num = ++n;
    const li = document.createElement('li');
    li.dataset.i = i;
    li.innerHTML = `
      <span class="num">${pad(g.num)}</span>
      <span class="swatch" style="background:${g.color}"></span>
      <span class="g-name"><b>${g.name}${g.tbc ? TBC : ''}</b><small>${g.sub || ''}</small></span>
      <button class="eye" title="Show / hide">${EYE_ON}</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.eye') || e.target.matches('input')) return;
      stopSequence();
      state.solo = state.solo === i ? null : i;
      applyVisibility();
      refreshGroupList();
    });
    $('.eye', li).addEventListener('click', () => {
      state.groupOn[i] = !state.groupOn[i];
      applyVisibility();
      refreshGroupList();
    });
    li.addEventListener('pointerenter', () => hoverGroup(i));
    li.addEventListener('pointerleave', () => hoverGroup(null));
    ol.appendChild(li);
  });
}
function refreshGroupList() {
  const cur = currentGroup();
  $$('#group-list li').forEach((li) => {
    const i = +li.dataset.i;
    li.classList.toggle('off', !state.groupOn[i]);
    li.classList.toggle('solo', state.solo === i);
    li.classList.toggle('current', cur === i);
    li.classList.toggle('dim', cur != null && i !== cur && groupExplode(i) > 0.5);
    $('.eye', li).innerHTML = state.groupOn[i] ? EYE_ON : EYE_OFF;
  });
}
function hoverGroup(i) {
  labels.forEach((l) => l.element.classList.toggle('current', l.userData.i === i));
}

// ---------- Rhino layer list (coordination mode) ----------
function buildLayerList() {
  const ul = $('#layer-list');
  ul.innerHTML = '';
  const byId = new Map(model.layers.map((L) => [L.id, L]));
  const shown = model.layers.filter((L) => state.layerOn[L.index] !== undefined);
  const parents = new Set();
  for (const L of shown) {
    const parent = byId.get(L.parentId);
    if (parent && !parents.has(parent.id)) {
      parents.add(parent.id);
      const h = document.createElement('li');
      h.className = 'parent';
      h.textContent = parent.name;
      ul.appendChild(h);
    }
    const li = document.createElement('li');
    if (parent) li.classList.add('child');
    li.dataset.i = L.index;
    const label = L.ctx?.name || (L.isStair ? model.groups[L.groupIndex].name : '');
    li.innerHTML = `
      <span class="swatch" style="background:${L.color}"></span>
      <span class="g-name"><b>${L.name}</b><small>${label || '—'}${L.meshes.length ? '' : ' · block instances only'}</small>
        <input type="range" min="0" max="100" value="100" title="Opacity" /></span>
      <button class="eye" title="Show / hide">${EYE_ON}</button>`;
    $('.eye', li).addEventListener('click', () => { state.layerOn[L.index] = !state.layerOn[L.index]; applyVisibility(); refreshLayerList(); });
    const r = $('input', li);
    r.addEventListener('input', () => { state.layerOp[L.index] = r.value / 100; applyVisibility(); });
    ul.appendChild(li);
  }
  refreshLayerList();
}
function refreshLayerList() {
  $$('#layer-list li[data-i]').forEach((li) => {
    const on = state.layerOn[+li.dataset.i];
    li.classList.toggle('off', !on);
    $('.eye', li).innerHTML = on ? EYE_ON : EYE_OFF;
  });
}
function setAllLayers(on) {
  for (const k in state.layerOn) state.layerOn[k] = on;
  applyVisibility();
  refreshLayerList();
}

// ---------- 3D labels ----------
function buildLabels() {
  model.groups.forEach((g, i) => {
    if (!g.meshes.length) return;
    const el = document.createElement('div');
    el.className = 'g-label';
    const coat = model.groups.find((x) => x.coat && x.assembledAs == null && model.groups.some((y) => y.assembledAs === x.id && y === g));
    el.innerHTML = `<span class="dot"></span><span class="leader"></span><span class="txt"><b>${pad(g.num)}</b>${g.name}${coat ? ` <i>+ ${coat.name.toLowerCase()} coat</i>` : ''}</span>`;
    const obj = new CSS2DObject(el);
    obj.center.set(0, 0.5);
    const b = g.box;
    const anchor = new THREE.Vector3(b.max.x, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    model.root.worldToLocal(anchor);
    obj.userData.anchor = anchor.clone();
    obj.position.copy(anchor);
    obj.userData.i = i;
    model.root.add(obj);
    labels.push(obj);
  });
}
// screen-space de-overlap
const _p = new THREE.Vector3();
viewer.onFrame(() => {
  const vis = labels.filter((l) => l.visible);
  if (!vis.length) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const items = vis.map((l) => {
    l.getWorldPosition(_p).project(viewer.camera);
    return { l, x: (_p.x * 0.5 + 0.5) * w, y: (-_p.y * 0.5 + 0.5) * h };
  }).sort((a, b) => a.y - b.y);
  const placed = [];
  for (const it of items) {
    let y = it.y;
    for (const p of placed) if (Math.abs(p.x - it.x) < 170 && y < p.y + 26) y = p.y + 26;
    placed.push({ x: it.x, y });
    const dy = Math.round(y - it.y);
    if (it.l.userData.dy !== dy) { it.l.userData.dy = dy; it.l.element.style.marginTop = dy + 'px'; }
  }
});
function updateLabels() {
  const cur = currentGroup();
  const show = state.mode === 'stair' && state.solo != null && state.assembly == null;
  for (const l of labels) {
    const i = l.userData.i;
    let vis = show && state.groupOn[i] && !(model.groups[i].coat && state.assembly == null);
    if (state.solo != null && state.explode <= 0.35) vis = vis && i === state.solo;
    if (state.assembly != null) vis = vis && i === cur; // during the sequence: only the trade being installed
    l.visible = vis;
    l.element.classList.toggle('current', cur === i || state.solo === i);
  }
}

// ---------- Picking ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;
function isPickable(m) {
  let o = m;
  while (o) { if (!o.visible) return false; o = o.parent; }
  return m.userData.baseMat.opacity > 0.15;
}
function select(mesh) {
  if (selected) selected.material = selected.userData.baseMat;
  selected = mesh;
  if (mesh) {
    const base = mesh.userData.baseMat;
    const ud = base.userData;
    base.userData = {}; // avoid JSON-copying circular userData in clone()
    const hl = base.clone();
    base.userData = ud;
    hl.userData = { ...ud };
    hl.onBeforeCompile = base.onBeforeCompile; // keep procedural finish
    hl.customProgramCacheKey = () => base.customProgramCacheKey() + '-hl';
    hl.emissive = new THREE.Color(state.dark ? 0xe7743a : 0xc2541d);
    hl.emissiveIntensity = 0.45;
    hl.opacity = Math.max(base.opacity, 0.85);
    mesh.material = hl;
  }
  renderProps(mesh);
  $('#panel-right').classList.toggle('collapsed', !mesh);
  viewer.needsRender = true;
}
function renderProps(m) {
  const el = $('#props');
  if (!m) {
    el.className = 'props empty';
    el.innerHTML = '<p>Click a part of the model to see its layer, type and size.</p>';
    return;
  }
  const a = m.userData.attributes || {};
  const L = m.userData.layer, IL = m.userData.instLayer, g = m.userData.gfOnly ? null : m.userData.group;
  const box = m.geometry.boundingBox.clone().applyMatrix4(m.userData.rest ? new THREE.Matrix4().compose(m.userData.rest.p, m.quaternion, m.userData.rest.s) : m.matrix);
  const size = box.getSize(new THREE.Vector3());
  const title = g ? g.name : L.ctx?.name || (m.userData.gfOnly ? 'Ground-floor part' : L.name);
  const sub = g ? g.sub || '' : 'Building';
  const specSrc = g || L.ctx || {};
  const user = { ...(a.userStrings ? Object.fromEntries(a.userStrings) : {}), ...(a.geometry?.userStrings ? Object.fromEntries(a.geometry.userStrings) : {}) };
  const userRows = Object.entries(user).filter(([k]) => !k.startsWith('$')).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  el.className = 'props';
  el.innerHTML = `
    <div class="p-title"><span class="swatch" style="background:${m.userData.baseMat.color.getStyle()}"></span>${title}</div>
    <div class="p-sub">${sub}${specSrc.tbc ? TBC : ''}</div>
    ${specSrc.spec ? `<p class="spec">${specSrc.spec}</p>` : ''}
    <dl>
      <dt>Rhino layer</dt><dd>${L.fullPath}</dd>
      ${IL && IL !== L ? `<dt>Block</dt><dd>${m.userData.blockName || '—'} (instance on ${IL.fullPath})</dd>` : m.userData.blockName ? `<dt>Block</dt><dd>${m.userData.blockName}</dd>` : ''}
      <dt>Type</dt><dd>${m.userData.objectType || '—'}</dd>
      <dt>Name</dt><dd>${a.name || '—'}</dd>
      <dt>Size</dt><dd class="mono">${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm</dd>
      <dt>Levels</dt><dd class="mono">Z ${fmt(box.min.z)} / ${fmt(box.max.z)} mm</dd>
      ${userRows ? `<dt style="grid-column:1/-1;margin-top:6px">User text</dt>${userRows}` : '<dt>User text</dt><dd>—</dd>'}
    </dl>
    ${state.mode === 'stair' ? '<div class="note">Presentation mode is view-only. Switch to “With interior” for mark-ups, measuring and sections.</div>' : ''}`;
}
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, viewer.camera);
  const hit = ray.intersectObjects(model.meshes.filter(isPickable), false)[0];
  select(hit ? hit.object : null);
  if (hit && state.mode === 'stair' && hit.object.userData.group) hoverGroup(hit.object.userData.group.index);
});

// ---------- Rotate / grid ----------
function setRotate(on) {
  state.rotate = on;
  viewer.controls.autoRotate = on;
}
function setGrid(on) {
  state.grid = on;
  if (viewer.grid) viewer.grid.visible = on;
  viewer.needsRender = true;
}
viewer.controls.addEventListener('start', () => { stopShowcase(); seqFollow = false; if (state.rotate) setRotate(false); });
canvas.addEventListener('pointerdown', () => {
  if (state.walk && state.showcase) stopShowcase();
  if (seqFollow) { seqFollow = false; viewer.setFirstPerson(false); }
  if (state.showcase && state.assembly != null) stopShowcase();
});

// ---------- Bindings ----------
$$('[data-color]').forEach((b) => b.addEventListener('click', () => {
  state.color = b.dataset.color;
  $$('[data-color]').forEach((x) => x.classList.toggle('active', x === b));
  model.setColorMode(state.color, state.dark);
  if (selected) select(selected);
  viewer.needsRender = true;
}));
$('#explode').addEventListener('input', (e) => { explodeAnim = null; stopSequence(); setExplode(e.target.value / 100); });
$('#explode').addEventListener('change', () => viewer.view('home', stairBounds()));
$('#btn-explode').addEventListener('click', () => { stopSequence(); exitSection(); animateExplode(state.explode > 0.5 ? 0 : 1, 1100, true); });
$('#btn-build').addEventListener('click', () => (state.assembly != null || seqAnim ? stopSequence() : startSequence()));
$('#btn-all-on').addEventListener('click', () => setAllLayers(true));
$('#btn-all-off').addEventListener('click', () => setAllLayers(false));
$$('[data-view]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.view;
  exitWalk(false);
  if (v !== 'home') setRotate(false);
  const box = v === 'under' ? (state.mode === 'stair' ? stairBounds(0) : allBounds()) : currentBounds();
  if (v === 'under' && state.explode > 0) animateExplode(0, 700);
  viewer.view(v, box);
}));
$('[data-toggle="night"]').addEventListener('click', () => setNightMode(!state.night));
$('[data-toggle="walk"]').addEventListener('click', () => (state.walk ? exitWalk() : enterWalk()));
$('[data-toggle="section"]').addEventListener('click', () => (state.section ? exitSection() : enterSection()));
$('#sec-exit').addEventListener('click', () => exitSection());
$('#sec-pause').addEventListener('click', (e) => {
  if (!state.section) return;
  state.section.paused = !state.section.paused;
  e.currentTarget.textContent = state.section.paused ? 'Resume' : 'Pause';
});
$('#fp-exit').addEventListener('click', () => exitWalk());
$$('[data-lens]').forEach((b) => b.addEventListener('click', () => setLens(+b.dataset.lens)));
$('[data-toggle="showcase"]').addEventListener('click', () => (state.showcase ? stopShowcase() : startShowcase()));
$('[data-toggle="building"]').addEventListener('click', (e) => {
  stopShowcase();
  state.building = !state.building;
  e.currentTarget.classList.toggle('on', state.building);
  if (state.mode === 'stair') viewer.frameTo(state.building ? ctxBox : stairBounds(), 1200, 0.92);
});
$('[data-toggle="person"]').addEventListener('click', (e) => {
  state.person = !state.person;
  e.currentTarget.classList.toggle('on', state.person);
  viewer.needsRender = true;
});
$$('[data-exmode]').forEach((b) => b.addEventListener('click', () => {
  stopShowcase();
  setExplodeMode(b.dataset.exmode);
  if (state.explode > 0.01) viewer.view('home', stairBounds());
}));
// any manual action stops the showcase
for (const el of $$('.panel, .topbar, .viewbar')) {
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-toggle="showcase"], [data-toggle="person"], [data-toggle="night"], #btn-theme, #btn-shot, .panel-toggle, #fp-hud, #sec-hud')) stopShowcase();
  }, true);
}
$('[data-action="build"]').addEventListener('click', () => (state.assembly != null || seqAnim ? stopSequence() : startSequence()));
$('[data-action="explode"]').addEventListener('click', () => {
  stopShowcase(); stopSequence(); exitSection(); exitWalk(false);
  if (state.mode !== 'stair') setMode('stair', false);
  if (state.building) { state.building = false; $('[data-toggle="building"]').classList.remove('on'); }
  animateExplode(state.explode > 0.5 ? 0 : 1, 1100, true);
});
$('#btn-theme').addEventListener('click', () => { state.dark = !state.dark; applyTheme(); });
$('#btn-shot').addEventListener('click', () => {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  viewer.screenshot(`28SR-stair-${stamp}.png`, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  toast('PNG exported');
});
function updateViewShift() {
  // the left panel is full-height; the right card is short, so only offset for the left
  const L = $('#panel-left');
  const lw = L.classList.contains('collapsed') || innerWidth < 760 ? 0 : L.offsetWidth + 16;
  viewer.setViewShift(lw / 2);
}
$$('.panel-toggle').forEach((b) => b.addEventListener('click', () => { $('#' + b.dataset.panel).classList.toggle('collapsed'); updateViewShift(); }));
$('#panel-right').classList.add('collapsed'); // opens with a selection
if (innerWidth < 760) $('#panel-left').classList.add('collapsed');
addEventListener('resize', updateViewShift);
updateViewShift();

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 1800);
}

// debugging hook
window.__app = {
  viewer, state, seekBuild, get seqAnim() { return seqAnim; }, get walkStartS() { return walkStartS; }, get CYCLE() { return CYCLE; }, TIMELINE, setNightMode, night, NIGHT, soffitPose: () => soffitPose(), enterWalk, exitWalk, enterSection, exitSection, seek: (t) => { showT = t; lastSeg = -1; lastCap = -1; }, startShowcase, stopShowcase, startSequence, stopSequence, setExplode, setMode, stairBounds,
  refresh: () => applyVisibility(), get plan() { return plan; }, get model() { return model; }, get walker() { return walker; },
};
boot();
