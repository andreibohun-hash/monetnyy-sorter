'use strict';
/* =====================================================================================================
   assets/scene3d.js — сцена «Монетного сортера» на three.js (vendor/three.js, 0.185.1).

   Сцена ничего не знает о правилах: оболочка (index.html) каждый кадр называет, что и где нарисовать
   («монета тут, кошелёк там»), сцена рисует. Массовые предметы — инстансы:
     монеты  — один InstancedMesh на все (столбики, летящие, в кошельках, рассыпанные), свой шейдер;
     бумага  — обёртки у столбиков 9/10, заворачивание и летящие роллы (один шейдер, параметры wrap/crimp);
     тени    — пятна под столбиками, кошельками, роллами;
     лунки   — гнёзда столбиков в лотке и места на прилавке.
   Герои (кошелёк, сейф) — отдельные меши; геометрию можно подменить моделью Tripo (R3.useModel).

   Свет один, «тун»: три ступени + аккуратный блик; тени — пятнами. Цвета приходят как sRGB и уходят
   в кадр без пересчёта (в шейдерах нет colorspace_fragment), текстуры — NoColorSpace.
   Мир: X вправо, Y вверх, Z на зрителя; гекс радиуса 1, сосед на √3. Камера орто, наклон CFG.camPitchDeg.
   ===================================================================================================== */
const R3 = (function(){
const T = window.THREE;
const R = { ready: false, models: {} };
let renderer = null, scene = null, camera = null;
let SP = 0.766, CP = 0.643;                      // sin/cos наклона камеры
const view = { cx: 0, cy: 0, half: 10, W: 1, H: 1 };          // текущий ортобокс (координаты камеры) и размер холста в CSS px
const baseView = { cx: 0, cy: 0, half: 10 };                  // кадр уровня; финал наезжает от него к сейфу
const focusView = { cx: 0, cy: 0, half: 6 };
const LIGHT = new T.Vector3(-0.5, 0.82, 0.2).normalize();     // направление НА свет (сверху-слева, чуть от зрителя)
const U = { uL: { value: LIGHT }, uV: { value: new T.Vector3(0, SP, CP) } };

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function rgb(hex){ const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }
const v3 = (hex) => new T.Vector3(...rgb(hex));

// ------------------------------------------------------------------ общий тун-свет
const GLSL_TOON = `
uniform vec3 uL; uniform vec3 uV;
vec3 toon(vec3 base, vec3 N, float specAmt){
  float ndl = dot(N, uL) * 0.5 + 0.5;
  float ramp = smoothstep(0.34, 0.40, ndl) * 0.55 + smoothstep(0.66, 0.72, ndl) * 0.45;
  vec3 dark = mix(base * base, base * 0.55, 0.4) * vec3(0.92, 0.90, 1.08);      // тень насыщеннее и холоднее, а не серее
  vec3 col = mix(dark, base, ramp);
  float sp = pow(max(dot(N, normalize(uL + uV)), 0.0), 30.0);
  col += specAmt * smoothstep(0.25, 0.38, sp) * vec3(1.0, 0.98, 0.9);
  return col;
}`;

// ------------------------------------------------------------------ монета
// Геометрия монеты: два лица, две фаски, ребро — с жёсткими рёбрами (нормали лица строго вверх/вниз,
// по ним шейдер отличает лицо от ребра). R — радиус, H — толщина, b — фаска, seg — сегментов по кругу.
function coinGeometry(Rc, H, b, seg){
  const pos = [], nor = [], idx = [], h = H / 2, K = Math.SQRT1_2;
  const ring = (r, y, nr, ny) => { const s = pos.length / 3;
    for (let i = 0; i <= seg; i++){ const a = i / seg * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a); pos.push(r * c, y, r * sn); nor.push(nr * c, ny, nr * sn); } return s; };
  const strip = (u, l) => { for (let i = 0; i < seg; i++) idx.push(u + i, u + i + 1, l + i, u + i + 1, l + i + 1, l + i); };
  const tc = pos.length / 3; pos.push(0, h, 0); nor.push(0, 1, 0);
  const t1 = ring(Rc - b, h, 0, 1); for (let i = 0; i < seg; i++) idx.push(tc, t1 + i + 1, t1 + i);
  strip(ring(Rc - b, h, K, K), ring(Rc, h - b, K, K));
  strip(ring(Rc, h - b, 1, 0), ring(Rc, -h + b, 1, 0));
  strip(ring(Rc, -h + b, K, -K), ring(Rc - b, -h, K, -K));
  const bc = pos.length / 3; pos.push(0, -h, 0); nor.push(0, -1, 0);
  const b1 = ring(Rc - b, -h, 0, -1); for (let i = 0; i < seg; i++) idx.push(bc, b1 + i, b1 + i + 1);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
  return g;
}
// Знаки на аверсе — у каждого металла свой (различие не только цветом, PROTO-BASE §9). Рисуются в единичном
// квадрате −1…1 белым по чёрному; атлас — полоса из CFG.metals.length ячеек, шейдер делает из маски чеканку.
const EMBLEMS = {
  star(c){ c.beginPath(); for (let i = 0; i < 10; i++){ const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.36 : 0.8; c[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } c.closePath(); c.fill(); },
  moon(c){ c.beginPath(); c.arc(0, 0, 0.72, 0, 6.2832); c.fill(); c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(0.34, -0.2, 0.6, 0, 6.2832); c.fill(); c.globalCompositeOperation = 'source-over'; },
  leaf(c){ c.beginPath(); c.moveTo(-0.62, 0.62); c.quadraticCurveTo(-0.7, -0.5, 0.62, -0.64); c.quadraticCurveTo(0.56, 0.66, -0.62, 0.62); c.fill();
           c.globalCompositeOperation = 'destination-out'; c.lineWidth = 0.1; c.beginPath(); c.moveTo(-0.5, 0.5); c.lineTo(0.34, -0.36); c.stroke(); c.globalCompositeOperation = 'source-over'; },
  heart(c){ c.beginPath(); c.moveTo(0, 0.74); c.bezierCurveTo(-1.15, -0.02, -0.62, -0.92, 0, -0.34); c.bezierCurveTo(0.62, -0.92, 1.15, -0.02, 0, 0.74); c.fill(); },
  drop(c){ c.beginPath(); c.moveTo(0, -0.82); c.bezierCurveTo(0.2, -0.3, 0.62, 0.0, 0.62, 0.3); c.arc(0, 0.3, 0.62, 0, Math.PI); c.bezierCurveTo(-0.62, 0.0, -0.2, -0.3, 0, -0.82); c.fill(); },
  diamond(c){ c.beginPath(); c.moveTo(0, -0.8); c.lineTo(0.64, 0); c.lineTo(0, 0.8); c.lineTo(-0.64, 0); c.closePath(); c.fill(); },
};
function emblemAtlas(){
  const n = CFG.metals.length, px = 128, cv = document.createElement('canvas'); cv.width = px * n; cv.height = px;
  const c = cv.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, px);
  CFG.metals.forEach((m, i) => {                             // знак рисуется в своём слое, чтобы «вырезы» не задели соседей
    const cell = document.createElement('canvas'); cell.width = cell.height = px; const k = cell.getContext('2d');
    k.translate(px / 2, px / 2); k.scale(px * 0.4, px * 0.4); k.fillStyle = '#fff'; k.strokeStyle = '#fff'; k.lineJoin = 'round';
    EMBLEMS[m.emblem](k);
    c.shadowColor = '#fff'; c.shadowBlur = 3; c.drawImage(cell, i * px, 0); c.shadowBlur = 0; c.drawImage(cell, i * px, 0);
  });
  const t = new T.CanvasTexture(cv); t.colorSpace = T.NoColorSpace; t.flipY = false; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter;
  R.emblemCanvas = cv;
  return t;
}
const COIN_VS = `
attribute vec4 aCol; attribute float aKind;
varying vec3 vN; varying vec3 vLP; varying vec3 vLN; varying vec4 vCol; varying float vKind; varying vec3 vTx; varying vec3 vTz;
void main(){
  mat3 im = mat3(instanceMatrix);
  vN = normalize(im * normal); vLP = position; vLN = normal; vCol = aCol; vKind = aKind;
  vTx = normalize(im[0]); vTz = normalize(im[2]);
  gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(position, 1.0));
}`;
const COIN_FS = GLSL_TOON + `
uniform sampler2D uAtlas; uniform float uKinds; uniform float uR; uniform float uEnamelFrom;
varying vec3 vN; varying vec3 vLP; varying vec3 vLN; varying vec4 vCol; varying float vKind; varying vec3 vTx; varying vec3 vTz;
float mask(vec2 uv){ return texture2D(uAtlas, vec2((clamp(uv.x, 0.02, 0.98) + floor(vKind + 0.05)) / uKinds, clamp(uv.y, 0.02, 0.98))).r; }
void main(){
  vec3 N = normalize(vN);
  vec3 base = vCol.rgb;
  float enamel = step(uEnamelFrom - 0.5, vKind);
  float face = step(0.9, abs(vLN.y));
  if (face > 0.5){
    vec2 p = vLP.xz / uR;                               // точка лица, −1…1
    float r = length(p);
    vec2 uv = p * 0.72 + 0.5;                           // знак занимает ~0,55 диаметра
    float m = mask(uv);
    vec3 g = (mask(uv + vec2(0.02, 0.0)) - m) * vTx + (mask(uv + vec2(0.0, 0.02)) - m) * vTz;   // куда растёт рельеф знака, в мире
    float inside = step(r, 0.7) * (1.0 - step(0.2, fract(vKind)));     // дробная часть вида = «без знака»: на верхней монете столбика вместо знака число (рисует оболочка)
    base = mix(base, base * 0.86 + vec3(0.14, 0.13, 0.10), m * 0.55 * inside);     // знак — выпуклый и чуть светлее поля
    base += clamp(dot(g, uL) * -4.0, -0.22, 0.26) * inside;                          // чеканка: грань к свету светлее, от света темнее
    float rim = smoothstep(0.80, 0.84, r);                                           // буртик
    base *= 1.0 - smoothstep(0.74, 0.78, r) * (1.0 - rim) * 0.2;                     // канавка перед буртиком
    vec3 wp = p.x * vTx + p.y * vTz;
    float toL = dot(normalize(wp + vec3(1e-5)), normalize(vec3(uL.x, 0.0, uL.z)));
    base += rim * smoothstep(0.25, 0.9, toL) * 0.2;                                  // серп блика по буртику со стороны света
    base *= 1.0 - rim * smoothstep(0.2, 0.9, -toL) * 0.16;
  } else if (abs(vLN.y) < 0.1){
    float reed = smoothstep(-0.3, 0.3, sin(atan(vLP.z, vLP.x) * 36.0));              // насечка по ребру; эмаль гладкая
    base *= mix(mix(0.84, 1.0, reed), 1.0, enamel);
  }
  vec3 col = toon(base, N, mix(0.6, 0.95, enamel));
  col += vCol.a * vec3(1.0, 0.86, 0.5) * (0.22 + 0.78 * (1.0 - face));               // свечение ребра у столбика 9/10
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ бумага (обёртка и ролл)
// Сетка-лента: u — вокруг столбика (0…1), v — по высоте (−0,5…0,5). Шейдер сворачивает ленту в дугу длиной
// wrap·360° (центр дуги — за столбиком, со стороны −Z) и сминает торцы (crimp). Плюс два «донышка» — торцы монет в ролле.
function paperGeometry(segU, segV){
  const uvp = [], pos = [], idx = [];
  for (let j = 0; j <= segV; j++) for (let i = 0; i <= segU; i++){ uvp.push(i / segU, j / segV - 0.5, 0); pos.push(0, 0, 0); }
  for (let j = 0; j < segV; j++) for (let i = 0; i < segU; i++){ const a = j * (segU + 1) + i, b = a + segU + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  for (const s of [1, -1]){
    const c0 = pos.length / 3; pos.push(0, 0, 0); uvp.push(0, 0, s);
    for (let i = 0; i <= 20; i++){ const a = i / 20 * Math.PI * 2; pos.push(Math.cos(a) * 0.58, 0, Math.sin(a) * 0.58); uvp.push(0, 0, s); }
    for (let i = 0; i < 20; i++){ if (s > 0) idx.push(c0, c0 + 2 + i, c0 + 1 + i); else idx.push(c0, c0 + 1 + i, c0 + 2 + i); }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('aUVP', new T.Float32BufferAttribute(uvp, 3)); g.setIndex(idx);
  return g;
}
const PAPER_VS = `
attribute vec3 aUVP; attribute vec3 aBand; attribute vec2 aWC;
varying vec3 vN; varying vec2 vUV; varying float vPart; varying vec3 vBand;
void main(){
  vec3 p; vec3 n;
  if (abs(aUVP.z) < 0.5){
    float ang = 3.14159265 + (aUVP.x - 0.5) * 6.2831853 * aWC.x;
    float edge = smoothstep(0.30, 0.5, abs(aUVP.y));
    float r = 1.0 - aWC.y * edge * (0.40 + 0.07 * sin(ang * 9.0));
    p = vec3(sin(ang) * r, aUVP.y, cos(ang) * r);
    n = normalize(vec3(sin(ang), aWC.y * edge * sign(aUVP.y) * 0.9, cos(ang)));
  } else {
    float k = smoothstep(0.5, 1.0, aWC.y);
    p = vec3(position.x * k, aUVP.z * 0.492, position.z * k);
    n = vec3(0.0, aUVP.z, 0.0);
  }
  mat3 im = mat3(instanceMatrix);
  vN = normalize(im * n); vUV = aUVP.xy; vPart = aUVP.z; vBand = aBand;
  gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(p, 1.0));
}`;
const PAPER_FS = GLSL_TOON + `
uniform vec3 uPaper;
varying vec3 vN; varying vec2 vUV; varying float vPart; varying vec3 vBand;
void main(){
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 base = mix(uPaper, vBand, smoothstep(0.13, 0.11, abs(vUV.y)));               // цветной поясок металла
  base = mix(base, vBand, smoothstep(0.03, 0.015, abs(abs(vUV.y) - 0.24)) * 0.55);  // две тонкие линии
  if (abs(vPart) > 0.5) base = vBand * 0.92;                                         // торец: видна монета
  vec3 lit = mix(toon(base, N, 0.0), base, 0.45);                                    // бумага матовая и светлая: тень мягче, чем у металла
  gl_FragColor = vec4(lit * (gl_FrontFacing ? 1.0 : 0.94), 1.0);
}`;

// ------------------------------------------------------------------ пятна-тени и лунки (плоские квадраты, форма — в шейдере)
const QUAD_VS = `
attribute vec4 aQ;                         // x, z, радиус, альфа/состояние
varying vec2 vP; varying float vA;
void main(){ vP = position.xy * 2.0; vA = aQ.w; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(aQ.x + position.x * 2.0 * aQ.z, uY, aQ.y - position.y * 2.0 * aQ.z, 1.0); }`;
const SHADOW_FS = `
uniform vec3 uColor; varying vec2 vP; varying float vA;
void main(){ float d = length(vP); gl_FragColor = vec4(uColor, smoothstep(1.0, 0.25, d) * vA); }`;
// Лунка: тёмное дно, тень у стенки со стороны света, светлая кромка с противоположной — читается как вмятина.
const SOCKET_FS = `
uniform vec3 uIn; uniform vec3 uEdge; uniform vec2 uL2; varying vec2 vP; varying float vA;
void main(){
  float d = length(vP); if (d > 1.0) discard;
  float toL = dot(vP / max(d, 1e-4), uL2);
  vec3 c = mix(uIn, uEdge, smoothstep(0.80, 0.90, d));
  c *= 1.0 - smoothstep(0.35, 0.86, d) * (1.0 - smoothstep(0.80, 0.9, d)) * smoothstep(-0.2, 0.9, toL) * 0.38;
  c += smoothstep(0.82, 0.9, d) * smoothstep(0.1, 0.9, -toL) * 0.10;
  c = mix(c, uEdge * 1.25, vA);                              // vA > 0 — подсветка (пустая лунка мигает звёздочкой)
  gl_FragColor = vec4(c, smoothstep(1.0, 0.96, d));
}`;

// ------------------------------------------------------------------ герои и статика: один материал
const PROP_VS = `
uniform float uOut;                        // > 0 — контур: вершины раздвинуты по нормали (рисуется изнанкой, тёмным)
varying vec3 vN; varying vec2 vUv;
void main(){ vN = normalize(mat3(modelMatrix) * normal); vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * uOut, 1.0); }`;
const PROP_FS = GLSL_TOON + `
uniform vec3 uColor; uniform vec3 uAdd; uniform float uSpec; uniform float uFlat; uniform float uUseMap; uniform sampler2D uMap; uniform float uAlpha; uniform float uMapAmt; uniform float uSoft;
varying vec3 vN; varying vec2 vUv;
void main(){
  vec3 base = uColor; if (uUseMap > 0.5) base *= mix(vec3(1.0), texture2D(uMap, vUv).rgb, uMapAmt);
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 col = uFlat > 0.5 ? base : toon(base, N, uSpec);
  if (uSoft > 0.5){                                           // мягкая ткань: плавный переход вместо ступеней (складки модели не рябят)
    float ndl = dot(N, uL) * 0.5 + 0.5;
    col = mix(mix(base * base, base * 0.55, 0.4) * vec3(0.92, 0.90, 1.08), base, smoothstep(0.18, 0.8, ndl));
  }
  gl_FragColor = vec4(col + uAdd, uAlpha);
}`;
function propMat(hex, o = {}){
  return new T.ShaderMaterial({ vertexShader: PROP_VS, fragmentShader: PROP_FS, side: o.side || T.FrontSide, transparent: !!o.transparent, depthWrite: o.depthWrite !== false,
    uniforms: { uL: U.uL, uV: U.uV, uColor: { value: typeof hex === 'string' ? v3(hex) : hex }, uAdd: { value: new T.Vector3(0, 0, 0) }, uSpec: { value: o.spec || 0 },
                uFlat: { value: o.flat ? 1 : 0 }, uUseMap: { value: o.map ? 1 : 0 }, uMap: { value: o.map || null }, uAlpha: { value: o.alpha === undefined ? 1 : o.alpha },
                uMapAmt: { value: o.mapAmt === undefined ? 1 : o.mapAmt }, uSoft: { value: o.soft ? 1 : 0 }, uOut: { value: o.out || 0 } } });
}
function roundedRect(w, h, r){
  const s = new T.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0); s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI); s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  return s;
}
// Шестиугольник с апофемой ap (расстояние до плоской стороны) и скруглением углов; вершины — сверху и снизу, как у поля ядра.
function hexShape(ap, round){
  const Rv = ap / Math.cos(Math.PI / 6), V = [], s = new T.Shape();
  for (let k = 0; k < 6; k++){ const a = Math.PI / 2 + k * Math.PI / 3; V.push([Math.cos(a) * Rv, Math.sin(a) * Rv]); }
  for (let k = 0; k < 6; k++){
    const p = V[(k + 5) % 6], v = V[k], n = V[(k + 1) % 6], l1 = Math.hypot(v[0] - p[0], v[1] - p[1]), l2 = Math.hypot(n[0] - v[0], n[1] - v[1]);
    const a = [v[0] + (p[0] - v[0]) / l1 * round, v[1] + (p[1] - v[1]) / l1 * round], b = [v[0] + (n[0] - v[0]) / l2 * round, v[1] + (n[1] - v[1]) / l2 * round];
    if (k === 0) s.moveTo(a[0], a[1]); else s.lineTo(a[0], a[1]);
    s.quadraticCurveTo(v[0], v[1], b[0], b[1]);
  }
  s.closePath(); return s;
}
// Плита со скруглёнными углами: лежит в XZ, верх на y = 0, толщина h.
function slabGeometry(w, d, h, r){
  const g = new T.ExtrudeGeometry(roundedRect(w, d, r), { depth: h, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2); g.translate(0, -h, 0); return g;
}

// ------------------------------------------------------------------ инстансные буферы
function makeInst(geo, mat, cap, attrs){
  const m = new T.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.count = 0;
  const out = { mesh: m, n: 0, cap, mx: m.instanceMatrix.array };
  for (const [name, size] of attrs){ const a = new T.InstancedBufferAttribute(new Float32Array(cap * size), size); a.setUsage(T.DynamicDrawUsage); geo.setAttribute(name, a); out[name] = a; }
  return out;
}
function makeQuads(fs, uniforms, cap, y, blend){
  const geo = new T.PlaneGeometry(1, 1);
  const mat = new T.ShaderMaterial({ vertexShader: 'uniform float uY;\n' + QUAD_VS, fragmentShader: fs, transparent: true, depthWrite: false,
    uniforms: Object.assign({ uY: { value: y } }, uniforms) });
  const m = new T.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.count = 0;
  const a = new T.InstancedBufferAttribute(new Float32Array(cap * 4), 4); a.setUsage(T.DynamicDrawUsage); geo.setAttribute('aQ', a);
  return { mesh: m, a, n: 0, cap };
}
let coins, papers, shadows, sockets, seatsQ;
let coinCols = [];                     // цвета монет по видам, sRGB

// ------------------------------------------------------------------ сборка
R.init = function(canvas){
  renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  scene = new T.Scene();
  camera = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
  const p = CFG.camPitchDeg * Math.PI / 180; SP = Math.sin(p); CP = Math.cos(p);
  camera.position.set(0, SP * 90, CP * 90); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  U.uV.value.set(0, SP, CP);
  coinCols = CFG.metals.map(m => rgb(m.coin));
  R.pouchCols = CFG.metals.map(m => v3(m.pouch));

  // статика — раскладка Hexa Glide: лоток-шестиугольник с лунками на всех клетках, лента вплотную к нему, шевроны хода, места прилавка
  const stat = new T.Group(); scene.add(stat); R.stat = stat;
  const flat = (geo, hex, y) => { const m = new T.Mesh(geo, propMat(hex, { flat: true })); m.rotation.x = -Math.PI / 2; m.position.y = y; return m; };
  stat.add(flat(new T.ShapeGeometry(hexShape(CFG.trackAp + 0.17, 1.9), 8), css('--track-edge'), -0.08));
  stat.add(flat(new T.ShapeGeometry(hexShape(CFG.trackAp, 1.8), 8), css('--track'), -0.07));
  stat.add(flat(new T.ShapeGeometry(hexShape(CFG.boardAp + 0.16, 1.3), 8), css('--board-edge'), -0.06));
  stat.add(flat(new T.ShapeGeometry(hexShape(CFG.boardAp, 1.2), 8), css('--board'), -0.05));
  R.slotRings = [];
  for (let i = 0; i < CFG.maxSlots; i++){
    const m = new T.Mesh(new T.RingGeometry(CFG.slotR * 0.97, CFG.slotR * 1.13, 44), propMat(css('--accent'), { flat: true, transparent: true, alpha: 0, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set((i - (CFG.maxSlots - 1) / 2) * CFG.slotDX, 0.03, CFG.slotZ); stat.add(m); R.slotRings.push(m);
  }
  const L2 = new T.Vector2(LIGHT.x, -LIGHT.z).normalize();          // свет в плоскости квадрата (его +y смотрит в −Z мира)
  sockets = makeQuads(SOCKET_FS, { uIn: { value: v3(css('--well')) }, uEdge: { value: v3(css('--well-edge')) }, uL2: { value: L2 } }, 96, 0.0);
  seatsQ = makeQuads(SOCKET_FS, { uIn: { value: v3(css('--slot')) }, uEdge: { value: v3(css('--slot-edge')) }, uL2: { value: new T.Vector2(0, 0) } }, 16, 0.0);
  scene.add(sockets.mesh, seatsQ.mesh);
  // шевроны хода ленты: по одному между клетками, волна яркости бежит по ходу; в разгоне — ярче и быстрее
  { const geo = new T.PlaneGeometry(1, 1), a = new T.InstancedBufferAttribute(new Float32Array(64 * 4), 4); geo.setAttribute('aQ', a);
    const mat = new T.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uColor: { value: v3(css('--chev')) }, uPhase: { value: 0 }, uGlow: { value: 0 }, uS: { value: 0.42 } },
      vertexShader: 'attribute vec4 aQ; uniform float uS; varying vec2 vP; varying float vI; void main(){ float c = cos(aQ.z), s = sin(aQ.z); vec2 p = position.xy * 2.0; vP = p; vI = aQ.w; vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c) * uS; gl_Position = projectionMatrix * viewMatrix * vec4(aQ.x + r.x, -0.04, aQ.y - r.y, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uPhase; uniform float uGlow; varying vec2 vP; varying float vI; void main(){ float d = abs(vP.y - 0.3 + abs(vP.x) * 0.8); float a = smoothstep(0.3, 0.18, d) * smoothstep(1.0, 0.82, abs(vP.x)); float wave = 0.5 + 0.5 * sin(6.2831853 * (vI * 3.0 - uPhase)); gl_FragColor = vec4(mix(uColor, vec3(1.0), wave * uGlow * 0.6), a * mix(0.55, 1.0, wave)); }' });
    const m = new T.InstancedMesh(geo, mat, 64); m.frustumCulled = false; m.count = 0; m.renderOrder = 1; scene.add(m); R.chev = { mesh: m, a }; }
  shadows = makeQuads(SHADOW_FS, { uColor: { value: v3(css('--shadow')) } }, 160, 0.012);
  scene.add(shadows.mesh);
  sockets.mesh.renderOrder = 1; seatsQ.mesh.renderOrder = 1; shadows.mesh.renderOrder = 3; for (const m of R.slotRings) m.renderOrder = 2;
  // затемнение поля под финальный фонтан монет: тёмная плоскость чуть выше лотка — монеты над ней остаются яркими
  R.veil = new T.Mesh(new T.PlaneGeometry(80, 120), propMat(css('--veil'), { flat: true, transparent: true, alpha: 0, depthWrite: false }));
  R.veil.rotation.x = -Math.PI / 2; R.veil.position.set(0, 0.07, 4); R.veil.renderOrder = 4; R.veil.visible = false; scene.add(R.veil);
  R.colAccent = v3(css('--accent')); R.colDanger = v3(css('--danger')); R.colAmber = v3(css('--amber'));

  // монеты и бумага
  const atlas = emblemAtlas();
  const coinMat = new T.ShaderMaterial({ vertexShader: COIN_VS, fragmentShader: COIN_FS,
    uniforms: { uL: U.uL, uV: U.uV, uAtlas: { value: atlas }, uKinds: { value: CFG.metals.length }, uR: { value: CFG.coinR }, uEnamelFrom: { value: CFG.metals.findIndex(m => m.enamel) } } });
  coins = makeInst(coinGeometry(CFG.coinR, CFG.coinH, CFG.coinBevel, CFG.coinSeg), coinMat, CFG.maxCoins, [['aCol', 4], ['aKind', 1]]);
  scene.add(coins.mesh);
  const paperMat = new T.ShaderMaterial({ vertexShader: PAPER_VS, fragmentShader: PAPER_FS, side: T.DoubleSide, uniforms: { uL: U.uL, uV: U.uV, uPaper: { value: v3(css('--paper')) } } });
  papers = makeInst(paperGeometry(28, 6), paperMat, CFG.maxPapers, [['aBand', 3], ['aWC', 2]]);
  scene.add(papers.mesh);

  buildWallets();
  R.ready = true;
};

// ------------------------------------------------------------------ кошельки
// Мешок для монет, собранный под читаемость в 40–60 px с камеры сверху: силуэт «груша с оборкой», а не шар.
//   тело     — пузатый низ, сужается к горлу; цвет металла, три ступени тона и блик;
//   оборка   — раструб над завязкой с волной по краю; светлее тела — видно, что это горловина;
//   завязка  — толстое кремовое кольцо и две бусины спереди: контраст на любом цвете;
//   контур   — тёмная изнанка, раздвинутая по нормали: отделяет мешок от фона и соседей.
// Монета его металла лежит в горле (рисуется общим мешем монет), число — на пузе (2D-слой оболочки).
function pouchParts(){
  const lathe = (P) => { const g = new T.LatheGeometry(P.map(p => new T.Vector2(p[0], p[1])), 32); g.computeVertexNormals(); return g; };
  const body = lathe([[0, 0], [0.5, 0], [0.84, 0.08], [1.0, 0.36], [1.0, 0.66], [0.86, 0.96], [0.62, 1.16], [0.5, 1.26], [0.47, 1.34]]);
  const ruff = lathe([[0.45, 1.3], [0.48, 1.38], [0.57, 1.5], [0.66, 1.6], [0.69, 1.65], [0.62, 1.67], [0.5, 1.54], [0.38, 1.46], [0, 1.44]]);
  const rp = ruff.attributes.position;                              // волна по краю оборки: шесть складок
  for (let i = 0; i < rp.count; i++){ const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i), k = 1 + Math.max(0, (y - 1.44) / 0.23) * 0.1 * Math.sin(Math.atan2(z, x) * 6); rp.setX(i, x * k); rp.setZ(i, z * k); }
  ruff.computeVertexNormals();
  const tie = new T.TorusGeometry(0.52, 0.12, 10, 28); tie.rotateX(Math.PI / 2); tie.translate(0, 1.28, 0);
  const bead = (x, y, z) => { const g = new T.SphereGeometry(0.14, 12, 10); g.translate(x, y, z); return g; };
  return { body, ruff, tie, extra: [bead(-0.19, 0.98, 0.74), bead(0.19, 0.98, 0.74)] };
}
const wallets = [];
function buildWallets(){
  const P = pouchParts(), cream = propMat(css('--tie'), { spec: 0.3 }), mix = (a, b, k) => new T.Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
  const white = new T.Vector3(1, 1, 1), ink = v3(css('--ink-edge'));
  R.pouchLight = R.pouchCols.map(c => mix(c, white, 0.3)); R.pouchDark = R.pouchCols.map(c => mix(c, ink, 0.72));
  R.secretCol = v3(css('--secret')); R.secretLight = mix(R.secretCol, white, 0.4); R.secretDark = mix(R.secretCol, ink, 0.72);
  for (let i = 0; i < CFG.maxWallets; i++){
    const g = new T.Group(), body = new T.Mesh(P.body, propMat('#888888', { spec: 0.5 })), ruff = new T.Mesh(P.ruff, propMat('#aaaaaa', { side: T.DoubleSide }));
    const o1 = new T.Mesh(P.body, propMat('#222222', { flat: true, side: T.BackSide, out: CFG.pouchOutline })), o2 = new T.Mesh(P.ruff, propMat('#222222', { flat: true, side: T.BackSide, out: CFG.pouchOutline }));
    o2.material = o1.material;
    g.add(o1, o2, body, ruff, new T.Mesh(P.tie, cream)); for (const e of P.extra) g.add(new T.Mesh(e, cream));
    g.visible = false; scene.add(g); wallets.push({ g, body, ruff, out: o1 });
  }
  R.wn = 0; R.pouchTop = 1.5; R.pouchMid = 0.42;
}
// Кошелёк кадра: позиция низа, масштаб по ширине и высоте, наклоны (опрокидывание), вид металла (−1 — закрытый «?»), вспышка.
R.wallet = function(x, y, z, sxz, sy, rx, rz, kind, flash){
  if (R.wn >= wallets.length) return;
  const w = wallets[R.wn++]; w.g.visible = true;
  w.g.position.set(x, y, z); w.g.scale.set(sxz, sy, sxz); w.g.rotation.set(rx || 0, 0, rz || 0);
  const sec = kind < 0, f = flash || 0, u = w.body.material.uniforms;
  u.uColor.value = sec ? R.secretCol : R.pouchCols[kind]; u.uAdd.value.set(f, f, f * 0.8);
  w.ruff.material.uniforms.uColor.value = sec ? R.secretLight : R.pouchLight[kind]; w.ruff.material.uniforms.uAdd.value.set(f, f, f * 0.8);
  w.out.material.uniforms.uColor.value = sec ? R.secretDark : R.pouchDark[kind];
};

// ------------------------------------------------------------------ уровень: лунки, сиденья обода, кадр
R.buildLevel = function(lay){
  let a = sockets.a.array, n = 0;
  for (const p of lay.wells){ a[n * 4] = p[0]; a[n * 4 + 1] = p[1]; a[n * 4 + 2] = CFG.wellR; a[n * 4 + 3] = 0; n++; }
  sockets.mesh.count = n; sockets.a.needsUpdate = true;
  a = seatsQ.a.array; n = 0;
  for (const p of lay.slots){ a[n * 4] = p[0]; a[n * 4 + 1] = p[1]; a[n * 4 + 2] = CFG.slotR; a[n * 4 + 3] = 0; n++; }
  seatsQ.mesh.count = n; seatsQ.a.needsUpdate = true;
  a = R.chev.a.array; n = 0;
  for (const c of lay.chev){ a[n * 4] = c[0]; a[n * 4 + 1] = c[1]; a[n * 4 + 2] = c[2]; a[n * 4 + 3] = n / lay.chev.length; n++; }
  R.chev.mesh.count = n; R.chev.a.needsUpdate = true;
  // кадр: габариты содержимого в координатах камеры (x вправо, y = Y·cos − Z·sin)
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const b of lay.bounds){ const cy = b[1] * CP - b[2] * SP; x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[0]); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
  baseView.cx = (x0 + x1) / 2; baseView.cy = (y0 + y1) / 2; baseView.hw = (x1 - x0) / 2 * CFG.camPad; baseView.hh = (y1 - y0) / 2 * CFG.camPad;
  focusView.cx = baseView.cx; focusView.cy = baseView.cy; focusView.hw = baseView.hw; focusView.hh = baseView.hh;
  R.setView(0);
};
// Подсветка лунки (звёздочка в пустой лунке): i — номер лунки уровня, a — 0…1.
R.socketGlow = function(i, a){ sockets.a.array[i * 4 + 3] = a; sockets.a.needsUpdate = true; };

R.resize = function(w, h, dpr){ view.W = w; view.H = h; renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); R.setView(R.focus || 0); };
// Кадр: f = 0 — весь уровень, f = 1 — наезд на сейф (финал).
R.pad = [0, 0];                                   // px: сверху под панель цели, снизу под панель бустеров
R.setPad = function(top, bottom){ R.pad = [top, bottom]; R.setView(R.focus || 0); };
R.setView = function(f){
  R.focus = f;
  const v = f > 0.5 ? focusView : baseView, pt = f > 0.5 ? 0 : R.pad[0], pb = f > 0.5 ? 0 : R.pad[1], He = Math.max(50, view.H - pt - pb);
  const k = Math.min(view.W / (2 * v.hw), He / (2 * v.hh)), asp = view.W / Math.max(1, view.H);
  const extra = Math.max(0, He - 2 * v.hh * k) * (f > 0.5 ? 0 : CFG.topBias);            // лишнюю высоту отдаём низу: поле ближе к цели, очереди больше места
  view.k = k; view.half = view.H / (2 * k); view.cx = v.cx; view.cy = v.cy + (pt - pb) / (2 * k) - extra / (2 * k);
  camera.left = view.cx - view.half * asp; camera.right = view.cx + view.half * asp; camera.top = view.cy + view.half; camera.bottom = view.cy - view.half;
  camera.updateProjectionMatrix();
  view.left = camera.left; view.top = camera.top;
};
// Крупный план для проверки и съёмки: центр кадра в мире и полувысота; R3.setView(0) возвращает кадр уровня.
R.look = function(x, y, z, half){ focusView.cx = x; focusView.cy = y * CP - z * SP; focusView.hh = half; focusView.hw = half * 0.5; R.setView(1); };
// Мир → экран (CSS px от левого верхнего угла игрового поля).
R.project = function(x, y, z){ return [(x - view.left) * view.k, (view.top - (y * CP - z * SP)) * view.k]; };
// Экран → мир на высоте y (куда лететь роллу, чтобы попасть в значок сейфа на панели).
R.unproject = function(sx, sy, y){ return [sx / view.k + view.left, (y * CP - (view.top - sy / view.k)) / SP]; };
R.pxPerUnit = function(){ return view.k; };
R.SP = () => SP; R.CP = () => CP;

// ------------------------------------------------------------------ кадр: подача предметов
R.begin = function(){
  coins.n = 0; papers.n = 0; shadows.n = 0;
  for (let i = 0; i < R.wn; i++) wallets[i].g.visible = false;
  R.wn = 0;
};
function coinAttr(i, kind, glow){
  const c = coinCols[Math.floor(kind + 0.05)] || coinCols[0], a = coins.aCol.array;
  a[i * 4] = c[0]; a[i * 4 + 1] = c[1]; a[i * 4 + 2] = c[2]; a[i * 4 + 3] = glow || 0; coins.aKind.array[i] = kind;
}
// Лежащая монета: центр, поворот вокруг вертикали, вид металла, свечение ребра, сжатие по высоте, масштаб.
R.coinFlat = function(x, y, z, yaw, kind, glow, sy, s){
  const i = coins.n; if (i >= coins.cap) return; coins.n++;
  const m = coins.mx, o = i * 16, k = s === undefined ? 1 : s, c = Math.cos(yaw) * k, sn = Math.sin(yaw) * k;
  m[o] = c; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0; m[o + 4] = 0; m[o + 5] = k * (sy === undefined ? 1 : sy); m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0; m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
  coinAttr(i, kind, glow);
};
function quatMatrix(m, o, x, y, z, qx, qy, qz, qw, sx, sy, sz){
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz, xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  m[o] = (1 - (yy + zz)) * sx; m[o + 1] = (xy + wz) * sx; m[o + 2] = (xz - wy) * sx; m[o + 3] = 0;
  m[o + 4] = (xy - wz) * sy; m[o + 5] = (1 - (xx + zz)) * sy; m[o + 6] = (yz + wx) * sy; m[o + 7] = 0;
  m[o + 8] = (xz + wy) * sz; m[o + 9] = (yz - wx) * sz; m[o + 10] = (1 - (xx + yy)) * sz; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}
// Монета в произвольной ориентации (катится на ребре, качается, летит): кватернион q.
R.coinQ = function(x, y, z, q, kind, glow, s){
  const i = coins.n; if (i >= coins.cap) return; coins.n++;
  const k = s === undefined ? 1 : s; quatMatrix(coins.mx, i * 16, x, y, z, q[0], q[1], q[2], q[3], k, k, k); coinAttr(i, kind, glow);
};
// Бумага: центр, кватернион (или null — стоит ровно), радиус, высота, wrap 0…1 (дуга), crimp 0…1 (смятые торцы), вид металла (поясок).
R.paper = function(x, y, z, q, rad, h, wrap, crimp, kind){
  const i = papers.n; if (i >= papers.cap) return; papers.n++;
  if (q) quatMatrix(papers.mx, i * 16, x, y, z, q[0], q[1], q[2], q[3], rad, h, rad); else quatMatrix(papers.mx, i * 16, x, y, z, 0, 0, 0, 1, rad, h, rad);
  const c = coinCols[kind] || coinCols[0], b = papers.aBand.array, w = papers.aWC.array;
  b[i * 3] = c[0]; b[i * 3 + 1] = c[1]; b[i * 3 + 2] = c[2]; w[i * 2] = wrap; w[i * 2 + 1] = crimp;
};
R.shadow = function(x, z, r, a){
  const i = shadows.n; if (i >= shadows.cap) return; shadows.n++;
  const q = shadows.a.array; q[i * 4] = x - LIGHT.x * r * 0.22; q[i * 4 + 1] = z - LIGHT.z * r * 0.22 + r * 0.1; q[i * 4 + 2] = r; q[i * 4 + 3] = a;
};
R.setVeil = function(al){ R.veil.visible = al > 0.01; R.veil.material.uniforms.uAlpha.value = al; };
// Лента: фаза волны шевронов (в клетках хода) и сила свечения 0…1.
R.setTrack = function(phase, glow){ const u = R.chev.mesh.material.uniforms; u.uPhase.value = phase; u.uGlow.value = glow; };
R.setSlotRing = function(i, col, a){ const m = R.slotRings[i]; if (!m) return; m.visible = a > 0.01; m.material.uniforms.uAlpha.value = a; if (col) m.material.uniforms.uColor.value = col; };

R.render = function(){
  coins.mesh.count = coins.n; coins.mesh.instanceMatrix.needsUpdate = true; coins.aCol.needsUpdate = true; coins.aKind.needsUpdate = true;
  papers.mesh.count = papers.n; papers.mesh.instanceMatrix.needsUpdate = true; papers.aBand.needsUpdate = true; papers.aWC.needsUpdate = true;
  shadows.mesh.count = shadows.n; shadows.a.needsUpdate = true;
  renderer.render(scene, camera);
};
R.stats = function(){ return { coins: coins.n, papers: papers.n, shadows: shadows.n, wallets: R.wn, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; };
// Прогрев (урок lesson-threejs-first-draw-warmup): один раз нарисовать всё, что появится позже — бумагу, тени, все кошельки,
// кольца мест, тревогу, полосы — крошечным, чтобы первый ролл и первый проигрыш не дёргали кадр.
R.warmUp = function(){
  R.begin();
  for (let k = 0; k < CFG.metals.length; k++){ R.coinFlat(0, -50, 0, 0, k, 0, 1, 0.001); R.paper(0, -50, 0, null, 0.001, 0.001, 0.5, 0.5, k); }
  R.shadow(0, 0, 0.001, 0.01);
  for (let i = 0; i < wallets.length; i++) R.wallet(0, -50, 0, 0.001, 0.001, 0, 0, i % CFG.metals.length, 0);
  for (const m of R.slotRings) m.visible = true;
  R.render();
  for (const m of R.slotRings) m.visible = false;
  R.begin();
};

// ------------------------------------------------------------------ модели Tripo (GLB)
// Разбор GLB без GLTFLoader (как в stykovka-3d): одна сетка, узлы запекаются в геометрию, вершины с учётом byteStride.
R.loadGLB = async function(url){
  const res = await fetch(url); if (!res.ok) throw new Error('нет файла ' + url);
  const buf = await res.arrayBuffer(), dv = new DataView(buf);
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength){
    const len = dv.getUint32(off, true), typ = dv.getUint32(off + 4, true); off += 8;
    if (typ === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, len)));
    else if (typ === 0x004E4942) bin = buf.slice(off, off + len);
    off += len;
  }
  const CT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }, NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const acc = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], Ty = CT[a.componentType], n = NC[a.type], start = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride;
    if (!stride || stride === n * Ty.BYTES_PER_ELEMENT) return new Ty(bin, start, a.count * n);
    const out = new Ty(a.count * n), dv2 = new DataView(bin), get = Ty === Float32Array ? 'getFloat32' : Ty === Uint32Array ? 'getUint32' : Ty === Uint16Array ? 'getUint16' : 'getUint8';
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv2[get](start + k * stride + c * Ty.BYTES_PER_ELEMENT, true);
    return out;
  };
  let map = null;
  const m = (json.materials || [])[0], pbr = m && m.pbrMetallicRoughness;
  if (pbr && pbr.baseColorTexture){
    const im = json.images[json.textures[pbr.baseColorTexture.index].source], bv = json.bufferViews[im.bufferView];
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bin, bv.byteOffset || 0, bv.byteLength)], { type: im.mimeType || 'image/png' }), { imageOrientation: 'none' });
    map = new T.CanvasTexture(bmp); map.flipY = false; map.colorSpace = T.NoColorSpace; map.anisotropy = 4;
  }
  const geos = [];
  const walk = (ni, parent) => { const nd = json.nodes[ni], mx = new T.Matrix4();
    if (nd.matrix) mx.fromArray(nd.matrix); else mx.compose(new T.Vector3().fromArray(nd.translation || [0, 0, 0]), new T.Quaternion().fromArray(nd.rotation || [0, 0, 0, 1]), new T.Vector3().fromArray(nd.scale || [1, 1, 1]));
    mx.premultiply(parent);
    if (nd.mesh !== undefined) for (const pr of json.meshes[nd.mesh].primitives){ const g = new T.BufferGeometry(), at = pr.attributes;
      g.setAttribute('position', new T.BufferAttribute(acc(at.POSITION).slice(), 3)); g.setAttribute('normal', new T.BufferAttribute(acc(at.NORMAL).slice(), 3));
      if (at.TEXCOORD_0 !== undefined) g.setAttribute('uv', new T.BufferAttribute(acc(at.TEXCOORD_0).slice(), 2));
      g.setIndex(new T.BufferAttribute(acc(pr.indices).slice(), 1)); g.applyMatrix4(mx); geos.push(g); }
    for (const c of (nd.children || [])) walk(c, mx); };
  for (const n of json.scenes[json.scene || 0].nodes) walk(n, new T.Matrix4());
  return { geo: geos[0], map };
};
// Привести геометрию к месту: повернуть, поставить низом на y = 0, центр в нуле, вписать в габарит (по ширине X или по высоте).
R.fitGeo = function(geo, o){
  if (o.rx) geo.rotateX(o.rx); if (o.ry) geo.rotateY(o.ry);
  geo.computeBoundingBox(); const bb = geo.boundingBox, sz = bb.getSize(new T.Vector3()), c = bb.getCenter(new T.Vector3());
  geo.translate(-c.x, -bb.min.y, -c.z);
  const k = o.height ? o.height / sz.y : o.width / Math.max(sz.x, sz.z); geo.scale(k, k, k); geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
};
// Подобрать поворот, при котором габаритный ящик модели минимален (Tripo строит модель «лицом к камере картинки»,
// лист GPT снят чуть сверху и вполоборота): перебор наклона rx и рысканья ry, сначала грубо, потом точно. Для коробок (сейф, дверца).
R.squareUp = function(geo, span){
  const pa = geo.attributes.position, n = pa.count, st = Math.max(1, Math.floor(n / 3000));
  const vol = (rx, ry) => { const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry); let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9, c0 = 1e9, c1 = -1e9;
    for (let i = 0; i < n; i += st){ const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), y1 = y * cx - z * sx, z1 = y * sx + z * cx, x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
      if (x2 < a0) a0 = x2; if (x2 > a1) a1 = x2; if (y1 < b0) b0 = y1; if (y1 > b1) b1 = y1; if (z2 < c0) c0 = z2; if (z2 > c1) c1 = z2; }
    return (a1 - a0) * (b1 - b0) * (c1 - c0); };
  let best = [0, 0], bv = 1e18; const S = span || 0.8;
  for (let rx = -S; rx <= S; rx += 0.06) for (let ry = -S; ry <= S; ry += 0.06){ const v = vol(rx, ry); if (v < bv){ bv = v; best = [rx, ry]; } }
  const c = best.slice();
  for (let rx = c[0] - 0.06; rx <= c[0] + 0.06; rx += 0.01) for (let ry = c[1] - 0.06; ry <= c[1] + 0.06; ry += 0.01){ const v = vol(rx, ry); if (v < bv){ bv = v; best = [rx, ry]; } }
  geo.rotateX(best[0]); geo.rotateY(best[1]); return best;
};
// Зеркало по X (дверца: ручка на листе слева, а петля у нас слева — ручке место справа); порядок вершин треугольников переворачивается.
R.mirrorX = function(geo){ geo.scale(-1, 1, 1); const ix = geo.index.array; for (let i = 0; i < ix.length; i += 3){ const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } geo.index.needsUpdate = true; geo.computeVertexNormals(); return geo; };
// Герои Tripo: мешочек, корпус сейфа, дверца. Нет файла — остаётся процедурная заглушка. Параметры посадки — CFG.models.
R.useModels = async function(){
  const M = CFG.models, done = [];
  return done;                                      // с v0.4 кошелёк — свой процедурный мешок (читается лучше модели Tripo); GLB лежат в assets/models про запас, загрузчик — R.loadGLB
};
R.T = T; R.propMat = propMat; R.scene = () => scene; R.wallets = wallets; R.v3 = v3; R.css = css;
return R;
})();
