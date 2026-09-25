// 展示用材质：在 MeshStandardMaterial 上注入程序化纹理（微水泥、橡木、木材等）。
// 纹理基于 3D 噪声、以毫米为单位按世界坐标计算，不依赖 UV，因此曲面、转角处没有接缝。
import * as THREE from 'three';

const NOISE = /* glsl */ `
// Ashima 3D simplex noise
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float f=0.0,a=0.5;for(int i=0;i<4;i++){f+=a*snoise(p);p=p*2.03+17.1;a*=0.5;}return f;}
`;

// 各材质的程序化外观：输出 颜色系数 tone、粗糙度 rough、高度 h（毫米）
const SURFACES = {
  // 微水泥：大尺度云纹 + 抹刀纹 + 细砂粒，哑光且粗糙度有变化
  microcement: /* glsl */ `
    vec3 p = sp;
    float cloud = fbm(p / 1100.0);
    float mid   = fbm(p / 260.0 + 3.7);
    // 抹刀痕：沿随机方向拉伸的噪声
    vec3 q = p + 40.0 * vec3(snoise(p / 700.0), snoise(p / 700.0 + 9.0), 0.0);
    float trowel = snoise(vec3(q.x / 90.0 + q.z / 140.0, q.y / 420.0, q.z / 90.0));
    float grain = snoise(p / 2.0) * fineFade(px, 2.0);
    // 抹刀留下的半透明“叠层”：阈值化的噪声形成深浅斑块
    float blot = smoothstep(-0.15, 0.35, fbm(q / 380.0 + 11.0));
    tone = 1.0 + cloud * 0.12 + mid * 0.055 + trowel * 0.035 + (blot - 0.5) * 0.05 + grain * 0.018;
    rough = clamp(0.78 + mid * 0.12 - abs(trowel) * 0.18 - blot * 0.08, 0.45, 0.95);
    h = mid * 0.25 + trowel * 0.1 * fineFade(px, 40.0);
  `,
  // 橡木：沿纹理方向拉伸的年轮条纹（踏步 / 踢面 / 扶手）
  oak: /* glsl */ `
    // handrail (tangential): the rail climbs, so height must not feed the grain noise
    oakGrain(ga.x, ga.y, uGrainMode < 0.5 ? sp.y : 0.0, px, tone, rough, h);
  `,
  // 长条木地板：190 宽 × 1800 长错缝铺装，板缝细深线，每块板色差
  floor: /* glsl */ `
    floorBoards(sp, px, tone, rough, h);
  `,
  // 房间完成面：朝上的面为木地板，其余为白色涂料
  room: /* glsl */ `
    if (nw.y > 0.9 && sp.y < 800.0) { floorBoards(sp, px, tone, rough, h); alt = 1.0; } // 仅地下室地面高度附近
    else { float n = fbm(sp / 600.0); tone = 1.0 + n * 0.02; rough = 0.9; h = 0.0; }
  `,
  // Plywood face veneer (rotary cut): soft broad figure along the panel's long axis, fine straight grain
  ply: /* glsl */ `
    // face veneer: pale earlywood with thin darker latewood lines running along the sheet,
    // gently wandering, opening into the odd cathedral arch — no blotches
    float a = dot(sp, gd);
    vec3 pp = sp - a * gd;
    float across = dot(pp, normalize(vec3(0.3, 0.8, 0.5)));
    float wob = fbm(vec3(a / 1400.0, across / 400.0, 1.3)) * 45.0 + snoise(vec3(a / 320.0, across / 120.0, 3.7)) * 5.0;
    float cat = 55.0 * pow(abs(sin(a / 820.0 + fbm(vec3(across / 500.0, 2.0, a / 3000.0)) * 1.6)), 3.0);
    float flow = across + wob + cat;
    float spacing = 14.0 * (1.0 + 0.45 * fbm(vec3(across / 180.0, a / 4000.0, 7.0)));
    float f = fract(flow / spacing);
    float lw = smoothstep(0.55, 0.9, f) * (1.0 - smoothstep(0.93, 1.0, f));
    lw *= 0.35 + 0.65 * fineFade(px, 4.0);
    // wider soft bands following the same flow, so the figure still reads from a distance
    float band = (sin(flow / 55.0 + fbm(vec3(a / 2000.0, across / 800.0, 4.0)) * 2.0) * 0.5 + 0.5);
    float fibre = snoise(grainSpace(sp, gd, 45.0, 0.8)) * fineFade(px, 0.8);
    float broad = fbm(sp / 1400.0);
    tone = 1.02 + broad * 0.03 - lw * 0.13 - band * 0.06 + fibre * 0.02;
    rough = 0.74 + lw * 0.03;
    h = -lw * 0.02 + fibre * 0.012;
  `,
  // Sawn softwood (spruce / pine battens): pale, straight grain along the member, darker orange end grain
  wood: /* glsl */ `
    float a = dot(sp, gd);
    vec3 pp = sp - a * gd;
    float streak = fbm(grainSpace(sp, gd, 380.0, 5.0));
    float bands = sin((pp.x * 0.8 + pp.y * 0.55 + pp.z * 0.62) * 0.32 + fbm(grainSpace(sp, gd, 900.0, 20.0)) * 5.0) * 0.5 + 0.5;
    bands *= fineFade(px, 3.0);
    float fine = snoise(grainSpace(sp, gd, 60.0, 0.9)) * fineFade(px, 0.9);
    tone = 1.0 + streak * 0.1 - smoothstep(0.55, 0.95, bands) * 0.1 + fine * 0.04;
    rough = 0.8;
    h = fine * 0.05;
    float endg = smoothstep(0.6, 0.85, abs(dot(nw, gd)));
    if (endg > 0.0) {
      float rings = sin(length(pp - floor(pp / 400.0) * 400.0) * 0.9 + snoise(sp / 6.0) * 2.0) * 0.5 + 0.5;
      float pores = snoise(sp / 0.7) * fineFade(px, 0.7);
      tone = mix(tone, 0.85 + rings * 0.18 + pores * 0.1, endg);
      rough = mix(rough, 0.95, endg);
      h += pores * 0.08 * endg;
      alt = endg;
    }
  `,
  // Plasterboard: paper face — very even, faint paper fibre and mottling
  plasterboard: /* glsl */ `
    float mott = fbm(sp / 350.0);
    float fibre = snoise(grainSpace(sp, gd, 14.0, 0.6)) * fineFade(px, 0.6);
    tone = 1.0 + mott * 0.035 + fibre * 0.02;
    rough = 0.86;
    h = fibre * 0.015;
  `,
  // Cast concrete: mid grey, cloudy, with small pores
  concrete: /* glsl */ `
    float cloud = fbm(sp / 420.0), mid = fbm(sp / 45.0);
    float pore = smoothstep(0.62, 0.8, snoise(sp / 2.6)) * fineFade(px, 2.6);
    tone = 1.0 + cloud * 0.09 + mid * 0.045 - pore * 0.28;
    rough = 0.9;
    h = mid * 0.1 - pore * 0.3;
  `,
  // 石膏 / 抹灰：几乎均匀，极轻微的起伏
  plaster: /* glsl */ `
    float n = fbm(sp / 600.0);
    tone = 1.0 + n * 0.02;
    rough = 0.9;
    h = snoise(sp / 3.0) * 0.02 * fineFade(px, 3.0);
  `,
  // Steel: mill finish with fine brushing along the member; roughness varies so reflections break up
  steel: /* glsl */ `
    float brush = snoise(grainSpace(sp, gd, 220.0, 1.2)) * fineFade(px, 1.2);
    float patchy = fbm(sp / 600.0);
    tone = 1.0 + patchy * 0.06 + brush * 0.02;
    rough = clamp(0.3 + patchy * 0.08 + brush * 0.05, 0.18, 0.5);
    h = brush * 0.02;
  `,
  // 影缝：深色哑光
  plain: `tone = 1.0; rough = -1.0; h = 0.0;`,
};

/**
 * 创建展示材质
 * @param {object} spec  {finish, color, roughness, metalness, opacity, grain}
 * @param {object} shared 共享 uniform：uCenter（螺旋中心，three 世界坐标 xz）、uRot
 */
export function createFinishMaterial(spec, shared) {
  const finish = spec.finish || 'plain';
  if (finish === 'glass') {
    const m = new THREE.MeshPhysicalMaterial({
      color: spec.color || '#dfeeee',
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      opacity: spec.opacity ?? 0.12,
      envMapIntensity: 1.6,
      specularIntensity: 1,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    m.userData.finish = 'glass';
    m.userData.spec = spec;
    m.userData.baseOpacity = spec.opacity ?? 0.12;
    return m;
  }

  const m = new THREE.MeshStandardMaterial({
    color: spec.color || '#cdc9c1',
    roughness: spec.roughness ?? 0.8,
    metalness: spec.metalness ?? 0,
    // Rhino solids: outer faces only (open surfaces get explicit back faces in the geometry)
    side: THREE.FrontSide,
    // Coincident faces: a small, fixed priority by construction band (finish in front, steel behind).
    // Kept small so it never overrides real depth at grazing angles.
    polygonOffset: true, polygonOffsetFactor: 0.25 * band(spec), polygonOffsetUnits: 2 * band(spec),
  });
  m.userData.finish = finish;
  m.userData.spec = spec;
  m.userData.baseOpacity = spec.opacity ?? 1;
  m.envMapIntensity = spec.envIntensity ?? 1;
  const uniforms = {
    uCenter: shared.uCenter,
    uRot: shared.uRot,
    uStrength: { value: 1 }, // 0 = 关闭程序化纹理（图层色模式）
    uGrainMode: { value: spec.grain === 'tangential' ? 1 : 0 },
    uBump: { value: spec.bump ?? 1 },
    uAltColor: { value: new THREE.Color(spec.floorColor || spec.endColor || '#8f6844') }, // room：朝上面的木地板颜色
    // section: back faces seen through the cut are painted flat in the material's section colour (poché)
    uSection: shared.uSection,
    uSectionColor: { value: new THREE.Color(spec.sectionColor || sectionColorFor(spec)) },
  };
  m.userData.uniforms = uniforms;
  if (finish === 'plain') return m;

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSurf;\nattribute vec3 aGrain;\nvarying vec3 vSurfPos;\nvarying vec3 vSurfNrm;\nvarying vec3 vGrain;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfPos = aSurf;\nvGrain = aGrain;\nvSurfNrm = mat3(modelMatrix) * objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec2 uCenter; uniform float uRot; uniform vec3 uAltColor; uniform float uStrength;
uniform float uSection; uniform vec3 uSectionColor; uniform float uGrainMode; uniform float uBump;
varying vec3 vSurfPos;
varying vec3 vSurfNrm;
varying vec3 vGrain;
${NOISE}
// 纹理尺度小于约 2 像素时淡出，避免远处闪烁噪点
float fineFade(float px, float scale){ return 1.0 - smoothstep(0.25, 0.8, px / scale); }
float hash1(float n){ return fract(sin(n) * 43758.5453); }
// coordinates stretched along a grain direction gd (sAlong) and compressed across it (sAcross), in mm
vec3 grainSpace(vec3 sp, vec3 gd, float sAlong, float sAcross){ float a = dot(sp, gd); return (sp - a * gd) / sAcross + gd * (a / sAlong); }
void oakGrain(float along, float across, float y, float px, out float tone, out float rough, out float h){
  // plain-sawn oak: wavy growth rings, cathedral arches, long darker streaks, fine pores
  float warp = fbm(vec3(along / 1300.0, across / 60.0, y / 60.0)) * 7.0;
  float rings = sin((across + warp * 14.0) * 0.16) * 0.5 + 0.5;          // ~40 mm growth bands
  float cathedral = sin((across * 0.045 + abs(sin(along / 600.0 + fbm(vec3(across / 120.0, 0.0, y / 120.0)) * 2.0)) * 5.0)) * 0.5 + 0.5;
  float streak = fbm(vec3(across / 9.0 + warp * 0.25, along / 380.0, y / 9.0));
  float pores = snoise(vec3(across / 0.8, along / 10.0, y / 0.8));
  float ringsV = rings * fineFade(px, 10.0) + 0.5 * (1.0 - fineFade(px, 10.0));
  float cathV = cathedral * fineFade(px, 28.0) + 0.5 * (1.0 - fineFade(px, 28.0));
  float late = smoothstep(0.45, 0.95, ringsV);
  tone = 1.0 + streak * 0.22 * (0.4 + 0.6 * fineFade(px, 4.0)) - late * 0.17 - smoothstep(0.6, 1.0, cathV) * 0.1 + pores * 0.06 * fineFade(px, 1.0);
  rough = 0.46 + late * 0.12 + streak * 0.06;
  h = -late * 0.06 + pores * 0.05 * fineFade(px, 0.8);
}
void floorBoards(vec3 sp, float px, out float tone, out float rough, out float h){
  // long boards 190 wide, random lengths 1.2–2.4 m, staggered joints, per-board colour and figure
  const float BW = 190.0;
  float row = floor(sp.z / BW);
  float BL = 1200.0 + hash1(row * 3.17) * 1200.0;
  float off = hash1(row * 12.9898) * BL;
  float u = sp.x + off;
  float col = floor(u / BL);
  float rnd = hash1(row * 78.233 + col * 12.9898);
  float rnd2 = hash1(row * 9.1 + col * 41.7);
  float sx = u - col * BL, sy = sp.z - row * BW;
  float edge = min(min(sy, BW - sy), min(sx, BL - sx));
  float seam = 1.0 - smoothstep(0.0, 1.2, edge);
  float bevel = 1.0 - smoothstep(0.0, 3.0, edge); // micro-bevel darkening along the joints
  oakGrain(u + rnd * 9000.0, sp.z + rnd2 * 400.0, sp.y + rnd * 50.0, px, tone, rough, h);
  tone *= (0.86 + rnd * 0.26) * (1.0 - (seam * 0.5 + bevel * 0.12) * fineFade(px, 4.0));
  rough += (rnd2 - 0.5) * 0.1;
  h -= (seam * 0.5 + bevel * 0.15) * fineFade(px, 4.0);
}
void surface(vec3 sp, vec3 nw, vec3 gd, float px, out float tone, out float rough, out float h, out float alt){
  alt = 0.0;
  vec2 d = sp.xz - uCenter;
  d = vec2(cos(uRot) * d.x - sin(uRot) * d.y, sin(uRot) * d.x + cos(uRot) * d.y); // 把 atan 的断缝转到楼梯背后
  float r = max(length(d), 1.0);
  float ang = atan(d.y, d.x) * 1400.0;
  // ga.x 沿木纹方向，ga.y 垂直木纹方向（踏步：沿径向；扶手：沿切向）
  vec2 ga = uGrainMode < 0.5 ? vec2(r, ang) : vec2(ang, r);
  ${SURFACES[finish]}
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float sTone, sRough, sH, sAlt;
surface(vSurfPos, normalize(vSurfNrm), normalize(vGrain), length(fwidth(vSurfPos)), sTone, sRough, sH, sAlt);
diffuseColor.rgb = mix(diffuseColor.rgb, uAltColor, sAlt * uStrength) * mix(1.0, sTone, uStrength);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if (sRough > 0.0) roughnessFactor = mix(roughnessFactor, sRough, uStrength);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // 基于高度的凹凸（屏幕空间导数）
  float hh = sH * uBump * uStrength;
  vec2 dHdxy = vec2(dFdx(hh), dFdy(hh));
  vec3 vSigmaX = dFdx(-vViewPosition), vSigmaY = dFdy(-vViewPosition);
  vec3 R1 = cross(vSigmaY, normal), R2 = cross(normal, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  normal = normalize(abs(fDet) * normal - vGrad);
}`);
  };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
if (uSection > 0.5 && !gl_FrontFacing) gl_FragColor = vec4(uSectionColor, gl_FragColor.a);
// back faces (only drawn for the section poché) lose every tie against a coincident front face
gl_FragDepth = gl_FragCoord.z + ((uSection > 0.5 && !gl_FrontFacing) ? 0.00003 : 0.0);`);
  };
  m.customProgramCacheKey = () => 'finish-' + finish;
  m.clipShadows = true;
  return m;
}

/** Construction band for coincident-face priority: 0 = visible finish … 4 = structure */
function band(spec) {
  if (spec.band != null) return spec.band;
  return { microcement: 0, oak: 0, floor: 0, room: 0, plaster: 0, plain: 1, plasterboard: 1, ply: 2, wood: 3, concrete: 3, steel: 4 }[spec.finish || 'plain'] ?? 0;
}

/** Section (poché) colour: a flatter, deeper version of the finish colour */
function sectionColorFor(spec) {
  const c = new THREE.Color(spec.color || '#cdc9c1');
  const hsl = {};
  c.getHSL(hsl);
  const fin = spec.finish;
  if (fin === 'steel') return new THREE.Color('#1f262d');
  if (fin === 'microcement') return new THREE.Color('#a39b8f');
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.25 + 0.05), hsl.l * 0.72);
}
