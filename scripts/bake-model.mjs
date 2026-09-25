// Bake the Rhino model into a compact web format (run after every model update):
//
//   npm run bake                 → reads ../STAIR.3dm
//   npm run bake -- path/to/x.3dm
//
// The browser then downloads only the render meshes (a few MB) instead of the full .3dm with its NURBS
// (~90 MB) plus the rhino3dm WebAssembly parser. Output, same structure the viewer used to get from
// three's 3DMLoader:
//   public/model/stair.json  layers, blocks, objects (attributes + offsets into the .bin)
//   public/model/stair.bin   Float32 positions · Int8 normals · Uint16/32 indices
// Render meshes are those saved in the .3dm (Rhino: save with render meshes, not "small").

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import rhino3dm from 'rhino3dm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const ifStale = args.includes('--if-stale');
const src = resolve(root, args.find((a) => !a.startsWith('--')) || '../STAIR.3dm');
const outDir = resolve(root, 'public/model');
const outJson = resolve(outDir, 'stair.json');
const outBin = resolve(outDir, 'stair.bin');

if (!existsSync(src)) {
  if (existsSync(outJson)) { console.log(`bake: ${src} not found — keeping the existing baked model.`); process.exit(0); }
  console.error(`bake: model not found: ${src}`);
  process.exit(1);
}
if (ifStale && existsSync(outJson) && statSync(outJson).mtimeMs > statSync(src).mtimeMs) {
  console.log('bake: baked model is up to date.');
  process.exit(0);
}

const rh = await rhino3dm();
const t0 = Date.now();
const doc = rh.File3dm.fromByteArray(new Uint8Array(readFileSync(src)));
if (!doc) { console.error('bake: could not read the .3dm file'); process.exit(1); }

const typeName = (t) => { for (const [k, v] of Object.entries(rh.ObjectType)) if (v === t || (v && t && v.value === t.value)) return k; return String(t); };

// ---------- binary writer (4-byte aligned chunks) ----------
const chunks = [];
let offset = 0;
function push(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const at = offset;
  chunks.push(bytes);
  offset += bytes.byteLength;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
  return at;
}

/** rhino mesh → { pos, nrm, idx } offsets into the .bin */
function packMesh(mesh) {
  const j = mesh.toThreejsJSON();
  const d = j.data || j;
  const pos = new Float32Array(d.attributes.position.array);
  const n = d.attributes.normal ? d.attributes.normal.array : null;
  const nrm = new Int8Array(pos.length);
  if (n) for (let i = 0; i < n.length; i++) nrm[i] = Math.round(Math.max(-1, Math.min(1, n[i])) * 127);
  const count = pos.length / 3;
  const idxSrc = d.index ? d.index.array : Array.from({ length: count }, (_, i) => i);
  const idx = count < 65536 ? new Uint16Array(idxSrc) : new Uint32Array(idxSrc);
  return {
    count,
    pos: push(pos),
    nrm: n ? push(nrm) : -1,
    idx: push(idx), idxCount: idx.length, idx32: idx instanceof Uint32Array,
  };
}

function meshOf(geom, type) {
  if (type === 'Mesh') return geom;
  if (type === 'Extrusion') return geom.getMesh(rh.MeshType.Any);
  if (type === 'Brep') {
    const faces = geom.faces();
    const m = new rh.Mesh();
    for (let i = 0; i < faces.count; i++) {
      const fm = faces.get(i).getMesh(rh.MeshType.Any);
      if (fm) m.append(fm);
    }
    if (m.faces().count === 0) return null;
    m.compact();
    return m;
  }
  return null;
}

// ---------- layers & blocks ----------
const layers = [];
for (let i = 0; i < doc.layers().count; i++) {
  const l = doc.layers().get(i);
  layers.push({ index: i, id: l.id, parentLayerId: l.parentLayerId, name: l.name, fullPath: l.fullPath, color: l.color, visible: l.visible });
}
const blocks = {};
for (let i = 0; i < doc.instanceDefinitions().count; i++) {
  const d = doc.instanceDefinitions().get(i);
  blocks[d.id] = { name: d.name, objectIds: d.getObjectIds() };
}

// ---------- objects ----------
const objects = [];
let meshes = 0, skipped = 0, noMesh = 0;
for (let i = 0; i < doc.objects().count; i++) {
  const o = doc.objects().get(i);
  const a = o.attributes(), g = o.geometry();
  const type = typeName(g.objectType);
  const attr = {
    id: a.id, name: a.name || '', layerIndex: a.layerIndex,
    isInstanceDefinitionObject: a.isInstanceDefinitionObject,
  };
  if (a.userStringCount > 0) attr.userStrings = a.getUserStrings();
  if (g.userStringCount > 0) attr.geometry = { userStrings: g.getUserStrings() };

  if (type === 'InstanceReference') {
    objects.push({ type, attr, idef: g.parentIdefId, xform: Array.from(g.xform.toFloatArray(true)) });
    continue;
  }
  if (!['Brep', 'Extrusion', 'Mesh'].includes(type)) { skipped++; continue; } // curves, points, text … are not shown
  const m = meshOf(g, type);
  if (!m) { noMesh++; continue; }
  objects.push({ type, attr, g: packMesh(m) });
  meshes++;
}

mkdirSync(outDir, { recursive: true });
const bin = new Uint8Array(offset);
let p = 0;
for (const c of chunks) { bin.set(c, p); p += c.byteLength; }
writeFileSync(outBin, bin);
writeFileSync(outJson, JSON.stringify({ version: 1, source: src.split('/').pop(), units: 'mm', layers, blocks, objects }));

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
console.log(`bake: ${meshes} meshes, ${objects.length - meshes} block instances, ${skipped} curves/points skipped` +
  (noMesh ? `, ${noMesh} surfaces WITHOUT render mesh (re-save in Rhino with render meshes)` : '') +
  ` → ${mb(bin.byteLength)} (from ${mb(statSync(src).size)}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
