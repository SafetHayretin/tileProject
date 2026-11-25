"use strict";

/* ============================================================
   КОНСТАНТИ И ГЛОБАЛНО СЪСТОЯНИЕ
   ============================================================ */

const EPS = 1e-7;                  // епсилон за плаваща запетая
const VERTEX_PICK_PX = 10;         // радиус за избор на връх (екранни пиксели)
const OPENING_PICK_PX = 8;         // радиус за избор на ъгъл на отвор
const SEGMENT_PICK_PX = 8;         // праг за клик върху сегмент

const cv  = document.getElementById('cv');
const ctx = cv.getContext('2d');

// Координатна система: моделните координати са в сантиметри.
// view.scale = px на cm; view.tx, view.ty са offset-ите.
const view = { scale: 2.0, tx: 80, ty: 80 };

// Състояние на инструмента
const tools = { POLYGON: 'polygon', RECT: 'rect', OPENING: 'opening', EDIT: 'edit', MEASURE: 'measure' };
let activeTool = tools.POLYGON;

// Рулетка: {a: {x,y}, b: {x,y} | null}. Когато b е null — чакаме втори клик.
let measurement = null;

/* ----- Множество стени -----
   Всяка стена има: { id, name, vertices:[{x,y}], closed:bool, openings:[{x,y,w,h}] }
   Във всеки момент има точно ЕДНА активна стена; чертането и редакцията засягат само нея.
*/
const walls = [];
let nextWallId = 1;
let activeWallId = null;

// Чертаене на правоъгълник / отвор — временно състояние
let rectDraft = null;       // {x0,y0,x1,y1}
let openingDraft = null;

// Редакция
const drag = {
  type: null,     // 'vertex' | 'opening-corner' | 'opening-move' | 'pan' | 'rect-draft' | 'opening-draft'
  index: -1,
  corner: -1,
  startX: 0, startY: 0,
  origX: 0, origY: 0,
  origRect: null,
};

let cursorModel = { x: 0, y: 0 };

// Inline редактор за дължина / вмъкване на връх — функция за затваряне или null
let dimEditorClose = null;

// Дали Space е задържан в момента (за Space + drag = пан, като във Figma)
let spaceHeld = false;

// Debounce таймер за автозапис
let saveTimer = null;

// Флаг — докато зареждаме, не задействаме автозапис (за да не презапишем веднага)
let loading = false;

const STORAGE_KEY = 'tile-calc-state-v1';

// Default параметри за плочки — нови стени получават копие.
// Запазваме грутата в мм (както потребителят я въвежда), не в см.
const DEFAULT_PARAMS = Object.freeze({
  tileW: 30,
  tileH: 60,
  grout: 2,
  waste: 10,
  rotate: false,
  pattern: 'grid',
  offset: 50,
  startX: 0,
  startY: 0,
  layoutAngle: 0,
  perBox: 6,
});

/* ============================================================
   УПРАВЛЕНИЕ НА СТЕНИ
   ============================================================ */

function createWall(makeActive = true) {
  const id = nextWallId++;
  // Новата стена наследява параметрите на активната (ако има такава),
  // иначе ползва глобалните defaults. Така ако вече си настроил плочка/фуга,
  // следващата стена тръгва от същото — не е нужно да започваш от 0 всеки път.
  const seedParams = (getActiveWall()?.params) || DEFAULT_PARAMS;
  const w = {
    id,
    name: `Стена ${id}`,
    vertices: [],
    closed: false,
    openings: [],
    params: { ...seedParams },
  };
  walls.push(w);
  if (makeActive) {
    activeWallId = w.id;
    loadParamsToUI(w.params);
  }
  renderWallsList();
  return w;
}

function getActiveWall() {
  return walls.find(w => w.id === activeWallId) || null;
}

function setActiveWall(id) {
  if (!walls.some(w => w.id === id)) return;
  if (dimEditorClose) dimEditorClose();
  activeWallId = id;
  // прекъсваме всякакъв drag, когато сменяме стена
  drag.type = null;
  rectDraft = null;
  openingDraft = null;
  // Синхронизираме UI inputs с параметрите на новата активна стена.
  const w = getActiveWall();
  if (w && w.params) loadParamsToUI(w.params);
  // НЕ рекрерираме списъка — иначе унищожаваме input елементите в момента,
  // в който потребителят кликва върху тях. Само превключваме .active клас.
  updateActiveWallVisual();
  draw();
}

function updateActiveWallVisual() {
  const list = document.getElementById('wallsList');
  if (!list) return;
  const rows = list.querySelectorAll('.wall-row');
  for (const row of rows) {
    const id = Number(row.dataset.wallId);
    row.classList.toggle('active', id === activeWallId);
  }
}

function deleteWall(id) {
  if (dimEditorClose) dimEditorClose();
  const idx = walls.findIndex(w => w.id === id);
  if (idx < 0) return;
  walls.splice(idx, 1);
  if (walls.length === 0) {
    createWall();   // винаги поне една стена
  } else if (activeWallId === id) {
    activeWallId = walls[Math.min(idx, walls.length - 1)].id;
  }
  renderWallsList();
  draw();
}

/* ============================================================
   КООРДИНАТНИ ТРАНСФОРМАЦИИ
   ============================================================ */

function modelToScreen(x, y) {
  return { x: x * view.scale + view.tx, y: y * view.scale + view.ty };
}
function screenToModel(sx, sy) {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
}
function snapToGrid(p) {
  if (!UI.snap.checked) return p;
  const g = Math.max(1, Number(UI.gridCm.value) || 10);
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// За рулетката — snap до най-близкия връх на активна стена (в рамките на ~10px),
// иначе snap към решетката. Така измерванията започват точно от ъглите.
function snapToVertexOrGrid(model) {
  const w = getActiveWall();
  if (w && w.vertices.length > 0) {
    const thresholdModel = 10 / view.scale; // 10 пиксела в модел-см
    let best = null, bestDist = thresholdModel;
    for (const v of w.vertices) {
      const d = Math.hypot(v.x - model.x, v.y - model.y);
      if (d < bestDist) { best = v; bestDist = d; }
    }
    if (best) return { x: best.x, y: best.y };
  }
  return snapToGrid(model);
}

/* ============================================================
   ГЕОМЕТРИЯ
   ============================================================ */

// Point-in-polygon (ray casting). Работи за конкавни полигони.
function pointInPolygon(px, py, poly) {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / ((yj - yi) || EPS) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Площ на полигон (shoelace), модул, в кв. см
function polygonArea(poly) {
  let s = 0;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(s) / 2;
}

function polygonBBox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function pointInRect(px, py, r) {
  return px >= r.x - EPS && px <= r.x + r.w + EPS &&
         py >= r.y - EPS && py <= r.y + r.h + EPS;
}

// "Валидна зона" за дадена стена = полигон МИНУС всички нейни отвори
function pointInValidArea(px, py, w) {
  if (!pointInPolygon(px, py, w.vertices)) return false;
  for (const o of w.openings) {
    if (pointInRect(px, py, o)) return false;
  }
  return true;
}

// Класифицирай плочка по 4-те й ъгъла (работи и за axis-aligned, и за завъртени).
// 9 проби: 4 ъгъла (леко свити навътре), 4 средни на ръбовете, 1 център.
function classifyTileCorners(corners, wall) {
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
  const insetFrac = 0.001;
  const inset = (c) => ({
    x: c.x + (cx - c.x) * insetFrac,
    y: c.y + (cy - c.y) * insetFrac,
  });
  const ic = corners.map(inset);
  const probes = [
    ic[0], ic[1], ic[2], ic[3],
    { x: cx, y: cy },
    { x: (ic[0].x + ic[1].x) / 2, y: (ic[0].y + ic[1].y) / 2 },
    { x: (ic[1].x + ic[2].x) / 2, y: (ic[1].y + ic[2].y) / 2 },
    { x: (ic[2].x + ic[3].x) / 2, y: (ic[2].y + ic[3].y) / 2 },
    { x: (ic[3].x + ic[0].x) / 2, y: (ic[3].y + ic[0].y) / 2 },
  ];
  let inCount = 0;
  for (const p of probes) {
    if (pointInValidArea(p.x, p.y, wall)) inCount++;
  }
  if (inCount === probes.length) return 'whole';
  if (inCount === 0) return 'out';
  return 'cut';
}

// Разстояние (в екранни пиксели) от точка до отсечка
function distancePointToSegmentPx(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* ============================================================
   ИЗЧИСЛЕНИЕ НА ПЛОЧКИТЕ
   ============================================================ */

// Чете текущите стойности от UI и връща plain params object.
function readUIParams() {
  return {
    tileW: Math.max(0.1, Number(UI.tileW.value) || DEFAULT_PARAMS.tileW),
    tileH: Math.max(0.1, Number(UI.tileH.value) || DEFAULT_PARAMS.tileH),
    grout: Math.max(0, Number(UI.grout.value) || 0),
    waste: Math.max(0, Number(UI.waste.value) || 0),
    rotate: !!UI.rotate.checked,
    pattern: UI.pattern.value || 'grid',
    offset: Math.max(0, Math.min(100, Number(UI.offset.value) || 0)),
    startX: Number(UI.startX.value) || 0,
    startY: Number(UI.startY.value) || 0,
    layoutAngle: Number(UI.layoutAngle.value) || 0,
    perBox: Math.max(0, Number(UI.perBox.value) || 0),
  };
}

// Зарежда params обект в UI inputs (без да тригърва input events — programmatic .value
// промяна не fire-ва input/change в браузърите).
function loadParamsToUI(p) {
  if (!p) return;
  UI.tileW.value = p.tileW;
  UI.tileH.value = p.tileH;
  UI.grout.value = p.grout;
  UI.waste.value = p.waste;
  UI.rotate.checked = !!p.rotate;
  UI.pattern.value = p.pattern;
  UI.offset.value = p.offset;
  UI.startX.value = p.startX;
  UI.startY.value = p.startY;
  UI.layoutAngle.value = p.layoutAngle;
  UI.perBox.value = p.perBox;
}

// Записва текущия UI в активната стена. Извиква се при всяка UI промяна.
function commitUIToActiveWall() {
  const w = getActiveWall();
  if (!w) return;
  w.params = readUIParams();
}

// Конвертира wall.params в обект готов за layout — със swap при rotate,
// грута в см (вместо мм), и т.н. Връща null ако параметрите са невалидни.
function getTileParamsForWall(w) {
  if (!w || !w.params) return null;
  const p = w.params;
  let tw = p.tileW, th = p.tileH;
  if (p.rotate) { const tmp = tw; tw = th; th = tmp; }
  if (!(tw > 0) || !(th > 0)) return null;
  return {
    tw, th,
    groutCm: p.grout / 10,
    wastePct: p.waste,
    pattern: p.pattern,
    offsetPct: p.offset,
    startX: p.startX,
    startY: p.startY,
    layoutAngle: p.layoutAngle,
    perBox: p.perBox,
  };
}

// Полага плочки в (евентуално завъртяна) координатна система (u,v), после ги връща
// в модел-координати като 4 ъгъла за всяка плочка. Класифицира спрямо стената.
function layoutTilesForWall(w) {
  if (!w || !w.closed || w.vertices.length < 3) {
    return { tiles: [], whole: 0, cut: 0, areaCm2: 0 };
  }
  const t = getTileParamsForWall(w);
  if (!t) return { tiles: [], whole: 0, cut: 0, areaCm2: 0 };

  const angleRad = (t.layoutAngle || 0) * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  // Пивот — произволна референтна точка (използваме първия връх).
  const px = w.vertices[0].x;
  const py = w.vertices[0].y;
  const mToL = (x, y) => {
    const dx = x - px, dy = y - py;
    return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
  };
  const lToM = (u, v) => ({
    x: px + u * cos - v * sin,
    y: py + u * sin + v * cos,
  });

  // BBox в локалните координати на схемата
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const vv of w.vertices) {
    const uv = mToL(vv.x, vv.y);
    if (uv.u < minU) minU = uv.u;
    if (uv.v < minV) minV = uv.v;
    if (uv.u > maxU) maxU = uv.u;
    if (uv.v > maxV) maxV = uv.v;
  }

  const stepU = t.tw + t.groutCm;
  const stepV = t.th + t.groutCm;
  const buffer = Math.max(t.tw, t.th);
  // startX/startY = ФАЗА на тилинг решетката спрямо горния ляв ъгъл на bbox-а на стената
  // (в локалните координати на схемата). 0,0 → грид започва от горния ляв ъгъл.
  // Положителни → грид е изместен навътре; ляво/горе остават частични cut tiles.
  const u0base = minU + t.startX;
  const v0base = minV + t.startY;

  // За да се запълни ЦЯЛОТО полигонално пространство (а не само от u0base нататък),
  // отиваме N стъпки назад. Тиловете в зоната ще се класифицират като cut при clip.
  const uBackSteps = Math.max(0, Math.ceil((t.startX + buffer) / stepU));
  const vBackSteps = Math.max(0, Math.ceil((t.startY + buffer) / stepV));
  const uIterStart = u0base - uBackSteps * stepU;
  const vIterStart = v0base - vBackSteps * stepV;

  const tiles = [];
  let whole = 0, cut = 0;

  // row се поддържа така, че row=0 да съответства на v0base (грид-row 0),
  // отрицателните стойности — за частичните редове в горната „buffer" зона.
  // Това запазва brick alternation независимо от offset стойностите.
  let row = -vBackSteps;
  for (let v = vIterStart; v < maxV + buffer; v += stepV, row++) {
    let rowOffset = 0;
    // (((row % 2) + 2) % 2) = модул-параметър който е винаги 0/1, дори за отрицателни row
    if (t.pattern === 'brick' && (((row % 2) + 2) % 2 === 1)) {
      rowOffset = -stepU * (t.offsetPct / 100);
    }
    for (let u = uIterStart + rowOffset; u < maxU + buffer; u += stepU) {
      const corners = [
        lToM(u,              v),
        lToM(u + t.tw,       v),
        lToM(u + t.tw,       v + t.th),
        lToM(u,              v + t.th),
      ];
      const kind = classifyTileCorners(corners, w);
      if (kind === 'out') continue;
      tiles.push({ corners, kind });
      if (kind === 'whole') whole++; else cut++;
    }
  }

  const polyAreaCm2 = polygonArea(w.vertices);
  let openingAreaCm2 = 0;
  for (const o of w.openings) openingAreaCm2 += o.w * o.h;
  const areaCm2 = Math.max(0, polyAreaCm2 - openingAreaCm2);

  // Точка-маркер за визуализация — къде започва тилинг решетката в модел-координати.
  const originModel = lToM(u0base, v0base);

  return { tiles, whole, cut, areaCm2, originModel };
}

/* ============================================================
   РЕНДЕР
   ============================================================ */

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.parentElement.getBoundingClientRect();
  cv.width  = Math.floor(rect.width  * dpr);
  cv.height = Math.floor(rect.height * dpr);
  cv.style.width  = rect.width + 'px';
  cv.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawGrid() {
  const w = cv.clientWidth, h = cv.clientHeight;
  const g = Math.max(1, Number(UI.gridCm.value) || 10);
  const stepPx = g * view.scale;
  if (stepPx < 4) return;

  const x0 = ((view.tx % stepPx) + stepPx) % stepPx;
  const y0 = ((view.ty % stepPx) + stepPx) % stepPx;

  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x < w; x += stepPx) {
    ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h);
  }
  for (let y = y0; y < h; y += stepPx) {
    ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5);
  }
  ctx.strokeStyle = '#2c3138';
  ctx.stroke();

  if (stepPx >= 6) {
    ctx.beginPath();
    const bigStep = stepPx * 10;
    const bx0 = ((view.tx % bigStep) + bigStep) % bigStep;
    const by0 = ((view.ty % bigStep) + bigStep) % bigStep;
    for (let x = bx0; x < w; x += bigStep) {
      ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h);
    }
    for (let y = by0; y < h; y += bigStep) {
      ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5);
    }
    ctx.strokeStyle = '#353c46';
    ctx.stroke();
  }

  const origin = modelToScreen(0, 0);
  ctx.strokeStyle = '#465058';
  ctx.beginPath();
  ctx.moveTo(0, origin.y + 0.5); ctx.lineTo(w, origin.y + 0.5);
  ctx.moveTo(origin.x + 0.5, 0); ctx.lineTo(origin.x + 0.5, h);
  ctx.stroke();
}

function wallPath2D(w) {
  const p = new Path2D();
  if (!w || w.vertices.length === 0) return p;
  const first = modelToScreen(w.vertices[0].x, w.vertices[0].y);
  p.moveTo(first.x, first.y);
  for (let i = 1; i < w.vertices.length; i++) {
    const s = modelToScreen(w.vertices[i].x, w.vertices[i].y);
    p.lineTo(s.x, s.y);
  }
  if (w.closed) p.closePath();
  return p;
}

function drawWall(w) {
  if (!w || w.vertices.length === 0) return;
  const path = wallPath2D(w);

  if (w.closed) {
    ctx.save();
    ctx.fillStyle = 'rgba(78, 161, 255, 0.08)';
    ctx.fill(path, 'evenodd');
    ctx.restore();
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = w.closed ? '#4ea1ff' : '#90c0ff';
  ctx.stroke(path);

  // Върхове
  for (let i = 0; i < w.vertices.length; i++) {
    const v = w.vertices[i];
    const s = modelToScreen(v.x, v.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = (activeTool === tools.EDIT) ? '#ffb74d' : '#4ea1ff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#15171a';
    ctx.stroke();
  }

  // Размери (см) върху отсечките
  if (w.vertices.length >= 2) {
    ctx.font = '12px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lim = w.closed ? w.vertices.length : w.vertices.length - 1;
    for (let i = 0; i < lim; i++) {
      const a = w.vertices[i];
      const b = w.vertices[(i + 1) % w.vertices.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenCm = Math.hypot(dx, dy);
      if (lenCm < 1) continue;
      const mid = modelToScreen((a.x + b.x) / 2, (a.y + b.y) / 2);
      const nlen = lenCm || 1;
      const nx = -dy / nlen, ny = dx / nlen;
      const off = 12;
      const tx = mid.x + nx * off, ty = mid.y + ny * off;
      const label = `${Math.round(lenCm)} см`;
      const m = ctx.measureText(label);
      const pad = 4;
      ctx.fillStyle = 'rgba(21, 23, 26, 0.8)';
      ctx.fillRect(tx - m.width / 2 - pad, ty - 8, m.width + pad * 2, 16);
      ctx.fillStyle = '#e6e8eb';
      ctx.fillText(label, tx, ty);
    }
  }

  // Име на стената (горе вляво над bbox-a)
  if (w.vertices.length > 0) {
    const bb = polygonBBox(w.vertices);
    const lt = modelToScreen(bb.minX, bb.minY);
    ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = w.name;
    const m = ctx.measureText(label);
    ctx.fillStyle = 'rgba(78, 161, 255, 0.9)';
    ctx.fillRect(lt.x - 4, lt.y - 22, m.width + 8, 18);
    ctx.fillStyle = '#0c1a2b';
    ctx.fillText(label, lt.x, lt.y - 6);
  }
}

function drawOpenings(w) {
  if (!w) return;
  for (let i = 0; i < w.openings.length; i++) {
    const o = w.openings[i];
    const a = modelToScreen(o.x, o.y);
    const b = modelToScreen(o.x + o.w, o.y + o.h);
    const sw = b.x - a.x, sh = b.y - a.y;
    ctx.fillStyle = 'rgba(255, 107, 107, 0.18)';
    ctx.fillRect(a.x, a.y, sw, sh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff6b6b';
    ctx.strokeRect(a.x, a.y, sw, sh);

    if (activeTool === tools.EDIT) {
      const corners = [
        { x: o.x,        y: o.y        },
        { x: o.x + o.w,  y: o.y        },
        { x: o.x + o.w,  y: o.y + o.h  },
        { x: o.x,        y: o.y + o.h  },
      ];
      for (const c of corners) {
        const s = modelToScreen(c.x, c.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb74d';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#15171a';
        ctx.stroke();
      }
    }
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const label = `${Math.round(o.w)}×${Math.round(o.h)} см`;
    const m = ctx.measureText(label);
    ctx.fillStyle = 'rgba(21, 23, 26, 0.85)';
    ctx.fillRect(cx - m.width / 2 - 4, cy - 8, m.width + 8, 16);
    ctx.fillStyle = '#ffd9b3';
    ctx.fillText(label, cx, cy);
  }
}

// Рендерира рулетката (две точки + линия + етикет с дължина и Δx × Δy).
function drawMeasurement() {
  if (!measurement || activeTool !== tools.MEASURE) return;
  const a = measurement.a;
  const b = measurement.b || cursorModel;  // живо предварително от курсора, ако още няма втора точка
  if (!a || !b) return;

  const sa = modelToScreen(a.x, a.y);
  const sb = modelToScreen(b.x, b.y);

  // Линия
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffb74d';
  ctx.setLineDash(measurement.b ? [] : [6, 4]);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Маркери в краищата
  for (const s of [sa, sb]) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb74d';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#15171a';
    ctx.stroke();
  }

  // Етикет
  const dx = b.x - a.x, dy = b.y - a.y;
  const distCm = Math.hypot(dx, dy);
  if (distCm < 0.5) return;

  const mid = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
  // Перпендикуляр за изместване на текста
  const lx = sb.x - sa.x, ly = sb.y - sa.y;
  const llen = Math.hypot(lx, ly) || 1;
  const nx = -ly / llen, ny = lx / llen;
  const off = 16;
  const tx = mid.x + nx * off;
  const ty = mid.y + ny * off;

  const label = distCm < 100
    ? `${distCm.toFixed(1)} см`
    : `${(distCm / 100).toFixed(2)} м (${Math.round(distCm)} см)`;
  ctx.font = 'bold 13px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const m = ctx.measureText(label);
  const pad = 6;
  ctx.fillStyle = 'rgba(40, 44, 51, 0.95)';
  ctx.strokeStyle = '#ffb74d';
  ctx.lineWidth = 1;
  ctx.fillRect(tx - m.width / 2 - pad, ty - 10, m.width + pad * 2, 20);
  ctx.strokeRect(tx - m.width / 2 - pad, ty - 10, m.width + pad * 2, 20);
  ctx.fillStyle = '#ffb74d';
  ctx.fillText(label, tx, ty);

  // Δx × Δy (само ако ръбът не е чисто хоризонтален/вертикален)
  if (Math.abs(dx) > 1 && Math.abs(dy) > 1) {
    const compLabel = `Δ ${Math.round(Math.abs(dx))} × ${Math.round(Math.abs(dy))} см`;
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    const cm = ctx.measureText(compLabel);
    const cy = ty + 20;
    ctx.fillStyle = 'rgba(40, 44, 51, 0.9)';
    ctx.fillRect(tx - cm.width / 2 - 4, cy - 8, cm.width + 8, 16);
    ctx.fillStyle = '#cfcfcf';
    ctx.fillText(compLabel, tx, cy);
  }
}

function drawDraftRect(rect, color) {
  if (!rect) return;
  const minX = Math.min(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxX = Math.max(rect.x0, rect.x1);
  const maxY = Math.max(rect.y0, rect.y1);
  const a = modelToScreen(minX, minY);
  const b = modelToScreen(maxX, maxY);
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = color;
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.setLineDash([]);
}

function drawTilesForWall(w, layout) {
  if (!w || !w.closed || layout.tiles.length === 0) return;

  const path = wallPath2D(w);
  ctx.save();
  ctx.clip(path, 'evenodd');

  for (const t of layout.tiles) {
    const s0 = modelToScreen(t.corners[0].x, t.corners[0].y);
    const s1 = modelToScreen(t.corners[1].x, t.corners[1].y);
    const s2 = modelToScreen(t.corners[2].x, t.corners[2].y);
    const s3 = modelToScreen(t.corners[3].x, t.corners[3].y);
    ctx.beginPath();
    ctx.moveTo(s0.x, s0.y);
    ctx.lineTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.lineTo(s3.x, s3.y);
    ctx.closePath();
    ctx.fillStyle = (t.kind === 'whole') ? 'rgba(106, 210, 139, 0.55)' : 'rgba(255, 183, 77, 0.55)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = (t.kind === 'whole') ? '#3da55c' : '#cf8a2a';
    ctx.stroke();
  }

  ctx.restore();

  // Изрязваме отворите визуално
  for (const o of w.openings) {
    const a = modelToScreen(o.x, o.y);
    const b = modelToScreen(o.x + o.w, o.y + o.h);
    ctx.save();
    ctx.fillStyle = '#15171a';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }
}

function draw() {
  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);

  drawGrid();

  // Изчисляваме layout-ите за ВСИЧКИ стени (един източник на истина)
  const allLayouts = walls.map(w => ({ w, layout: layoutTilesForWall(w) }));

  // На холста рисуваме само активната стена
  const active = getActiveWall();
  const activeEntry = allLayouts.find(e => e.w.id === activeWallId);
  const activeLayout = activeEntry ? activeEntry.layout : { tiles: [], whole: 0, cut: 0, areaCm2: 0 };

  drawTilesForWall(active, activeLayout);
  drawWall(active);
  drawOpenings(active);
  drawDraftRect(rectDraft, '#4ea1ff');
  drawDraftRect(openingDraft, '#ff6b6b');
  drawMeasurement();

  updateMetrics(allLayouts);
  scheduleSave();
}

/* ============================================================
   МЕТРИКИ + СПИСЪК НА СТЕНИТЕ
   ============================================================ */

function updateMetrics(allLayouts) {
  // Тъй като всяка стена има свои параметри (включително waste % и кашон),
  // total и boxes ги сметаме ПО СТЕНА и сумираме. Това коректно работи
  // дори ако стените имат различни плочки/допуски.
  let gWhole = 0, gCut = 0, gAreaCm2 = 0, gTotalWithWaste = 0, gBoxes = 0;

  for (const { w, layout } of allLayouts) {
    gWhole += layout.whole;
    gCut += layout.cut;
    gAreaCm2 += layout.areaCm2;

    const rawWall = layout.whole + layout.cut;
    const wastePctW = (w.params && w.params.waste) || 0;
    const totalWall = Math.ceil(rawWall * (1 + wastePctW / 100));
    gTotalWithWaste += totalWall;

    const perBoxW = (w.params && w.params.perBox) || 0;
    if (perBoxW > 0 && totalWall > 0) gBoxes += Math.ceil(totalWall / perBoxW);

    // Обнови мини-броя в реда на стената
    const cntEl = document.querySelector(`.wall-count[data-wall-id="${w.id}"]`);
    if (cntEl) {
      if (!w.closed) {
        cntEl.textContent = w.vertices.length > 0 ? '…' : '—';
        cntEl.classList.remove('has');
      } else {
        cntEl.textContent = `${rawWall} пл.`;
        cntEl.classList.toggle('has', rawWall > 0);
      }
    }
  }

  UI.mWhole.textContent = gWhole;
  UI.mCut.textContent   = gCut;
  UI.mTotal.textContent = gTotalWithWaste;
  UI.mArea.textContent  = (gAreaCm2 / 10000).toFixed(2);
  UI.mBoxes.textContent = gBoxes;

  const closedCount = walls.filter(w => w.closed).length;
  if (closedCount === 0) {
    UI.hintMsg.textContent = 'Затвори контура поне на една стена.';
  } else if ((gWhole + gCut) === 0) {
    UI.hintMsg.textContent = 'Няма поставени плочки — провери размерите/мащаба.';
  } else {
    UI.hintMsg.textContent = `${closedCount} ${closedCount === 1 ? 'затворена стена' : 'затворени стени'} · общо ${gWhole + gCut} плочки преди допуски, ${gTotalWithWaste} с допуски. Всяка стена ползва собствените си настройки.`;
  }
}

function renderWallsList() {
  const list = document.getElementById('wallsList');
  list.innerHTML = '';

  for (const w of walls) {
    const row = document.createElement('div');
    row.className = 'wall-row' + (w.id === activeWallId ? ' active' : '');
    row.dataset.wallId = w.id;

    const dot = document.createElement('span');
    dot.className = 'wall-dot';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'wall-name';
    name.value = w.name;
    // НЕ е readOnly — потребителят може директно да пише вътре.
    // Кликът върху името просто активира стената и поставя курсора в полето.
    name.addEventListener('mousedown', () => setActiveWall(w.id));
    name.addEventListener('dblclick', () => {
      name.focus();
      name.select();
    });
    name.addEventListener('blur', () => {
      const v = name.value.trim();
      w.name = v.length > 0 ? v : `Стена ${w.id}`;
      name.value = w.name;
      draw();
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.value = w.name; name.blur(); }
    });
    name.addEventListener('input', () => { w.name = name.value; });

    const editBtn = document.createElement('button');
    editBtn.className = 'wall-edit';
    editBtn.title = 'Преименувай';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (w.id !== activeWallId) setActiveWall(w.id);
      name.focus();
      name.select();
    });

    const count = document.createElement('span');
    count.className = 'wall-count';
    count.dataset.wallId = w.id;
    count.textContent = w.closed ? '…' : '—';

    const del = document.createElement('button');
    del.className = 'wall-del';
    del.title = 'Изтрий стената';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Изтрий „${w.name}"?`)) return;
      deleteWall(w.id);
    });

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(editBtn);
    row.appendChild(count);
    row.appendChild(del);

    row.addEventListener('click', (e) => {
      if (e.target === name || e.target === editBtn || e.target === del) return;
      setActiveWall(w.id);
    });

    list.appendChild(row);
  }
}

/* ============================================================
   PICK ФУНКЦИИ — върхове / отвори / сегменти
   ============================================================ */

function pickVertex(sx, sy) {
  const w = getActiveWall();
  if (!w) return -1;
  for (let i = 0; i < w.vertices.length; i++) {
    const s = modelToScreen(w.vertices[i].x, w.vertices[i].y);
    const dx = s.x - sx, dy = s.y - sy;
    if (dx * dx + dy * dy <= VERTEX_PICK_PX * VERTEX_PICK_PX) return i;
  }
  return -1;
}

function pickOpeningCorner(sx, sy) {
  const w = getActiveWall();
  if (!w) return null;
  for (let i = 0; i < w.openings.length; i++) {
    const o = w.openings[i];
    const corners = [
      { x: o.x,       y: o.y       },
      { x: o.x + o.w, y: o.y       },
      { x: o.x + o.w, y: o.y + o.h },
      { x: o.x,       y: o.y + o.h },
    ];
    for (let c = 0; c < 4; c++) {
      const s = modelToScreen(corners[c].x, corners[c].y);
      const dx = s.x - sx, dy = s.y - sy;
      if (dx * dx + dy * dy <= OPENING_PICK_PX * OPENING_PICK_PX) return { i, c };
    }
  }
  return null;
}

function pickOpening(model) {
  const w = getActiveWall();
  if (!w) return -1;
  for (let i = w.openings.length - 1; i >= 0; i--) {
    if (pointInRect(model.x, model.y, w.openings[i])) return i;
  }
  return -1;
}

// Връща индекса на сегмент (i означава ръба v[i] → v[(i+1) % n]) или -1.
function pickSegment(sx, sy) {
  const w = getActiveWall();
  if (!w || w.vertices.length < 2) return -1;
  const n = w.vertices.length;
  const lim = w.closed ? n : n - 1;
  let best = -1, bestDist = SEGMENT_PICK_PX;
  for (let i = 0; i < lim; i++) {
    const a = modelToScreen(w.vertices[i].x, w.vertices[i].y);
    const b = modelToScreen(w.vertices[(i + 1) % n].x, w.vertices[(i + 1) % n].y);
    const d = distancePointToSegmentPx(sx, sy, a.x, a.y, b.x, b.y);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/* ============================================================
   ИНЛАЙН РЕДАКТОР НА ДЪЛЖИНА + ВМЪКВАНЕ НА ВРЪХ
   ============================================================ */

// Задава дължина на сегмент. Фиксираният връх е този по-близо до горния ляв
// ъгъл (по-малко x+y; при равенство — по-малко x). Така редактирането ВИНАГИ
// разтяга ръба към долу-вдясно: хоризонтален ръб → надясно, вертикален → надолу,
// независимо от посоката на чертане на полигона.
function setSegmentLength(segIdx, newLen) {
  const w = getActiveWall();
  if (!w) return;
  const n = w.vertices.length;
  const i = segIdx;
  const j = (segIdx + 1) % n;
  const a = w.vertices[i];
  const b = w.vertices[j];

  let fixedIdx, movedIdx;
  const rankA = a.x + a.y;
  const rankB = b.x + b.y;
  if (rankA < rankB - EPS) {
    fixedIdx = i; movedIdx = j;
  } else if (rankB < rankA - EPS) {
    fixedIdx = j; movedIdx = i;
  } else if (a.x <= b.x) {
    fixedIdx = i; movedIdx = j;
  } else {
    fixedIdx = j; movedIdx = i;
  }

  const fixed = w.vertices[fixedIdx];
  const moved = w.vertices[movedIdx];
  const dx = moved.x - fixed.x, dy = moved.y - fixed.y;
  const curLen = Math.hypot(dx, dy);
  if (curLen < EPS) return;
  const ux = dx / curLen, uy = dy / curLen;
  w.vertices[movedIdx] = { x: fixed.x + ux * newLen, y: fixed.y + uy * newLen };
}

// Вмъква нов връх на сегмент, проектиран към точката на клика (винаги точно на ръба).
function insertVertexOnSegment(segIdx, pointModel) {
  const w = getActiveWall();
  if (!w) return;
  const n = w.vertices.length;
  const a = w.vertices[segIdx];
  const b = w.vertices[(segIdx + 1) % n];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return;
  let t = ((pointModel.x - a.x) * dx + (pointModel.y - a.y) * dy) / len2;
  t = Math.max(0.001, Math.min(0.999, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const snapped = snapToGrid({ x: px, y: py });
  w.vertices.splice(segIdx + 1, 0, snapped);
}

function openDimensionEditor(segIdx, clickModel) {
  if (dimEditorClose) dimEditorClose();

  const w = getActiveWall();
  if (!w) return;
  const n = w.vertices.length;
  const a = w.vertices[segIdx];
  const b = w.vertices[(segIdx + 1) % n];
  const curLen = Math.hypot(b.x - a.x, b.y - a.y);

  const editor = document.getElementById('dimEditor');
  const input = editor.querySelector('input');
  const splitBtn = editor.querySelector('.split-btn');

  input.value = curLen.toFixed(1);
  editor.style.display = 'flex';

  requestAnimationFrame(() => {
    const er = editor.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    const sp = modelToScreen(clickModel.x, clickModel.y);
    let left = sp.x - er.width / 2;
    let top  = sp.y + 16;
    left = Math.max(4, Math.min(cr.width - er.width - 4, left));
    if (top + er.height > cr.height - 4) top = sp.y - er.height - 16;
    editor.style.left = left + 'px';
    editor.style.top  = top + 'px';
  });

  setTimeout(() => { input.focus(); input.select(); }, 0);

  let done = false;

  function applyLength() {
    if (done) return;
    done = true;
    const v = Number(input.value);
    if (v > 0 && Number.isFinite(v)) setSegmentLength(segIdx, v);
    cleanup();
    draw();
  }
  function splitHere() {
    if (done) return;
    done = true;
    insertVertexOnSegment(segIdx, clickModel);
    cleanup();
    draw();
  }
  function cancel() {
    if (done) return;
    done = true;
    cleanup();
  }
  function cleanup() {
    editor.style.display = 'none';
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', applyLength);
    splitBtn.removeEventListener('mousedown', onSplitMouseDown);
    dimEditorClose = null;
  }
  function onKey(e) {
    if (e.key === 'Enter')  { e.preventDefault(); applyLength(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }
  function onSplitMouseDown(e) {
    // preventDefault, за да не открадне фокуса (което би тригернало blur=apply преди split)
    e.preventDefault();
    splitHere();
  }

  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', applyLength);
  splitBtn.addEventListener('mousedown', onSplitMouseDown);

  // Външно затваряне (смяна на стена/инструмент/клик другаде) → apply
  dimEditorClose = applyLength;
}

// Popup за връх — показва се при тап-без-влачене върху връх в EDIT mode.
function openVertexPopup(vertexIdx, screenPos) {
  if (dimEditorClose) dimEditorClose();

  const popup = document.getElementById('vertexPopup');
  const delBtn = popup.querySelector('.del-btn');

  popup.style.display = 'flex';
  requestAnimationFrame(() => {
    const er = popup.getBoundingClientRect();
    const cr = cv.getBoundingClientRect();
    let left = screenPos.x - er.width / 2;
    let top  = screenPos.y + 16;
    left = Math.max(4, Math.min(cr.width - er.width - 4, left));
    if (top + er.height > cr.height - 4) top = screenPos.y - er.height - 16;
    popup.style.left = left + 'px';
    popup.style.top  = top + 'px';
  });

  setTimeout(() => delBtn.focus(), 0);

  let done = false;
  function deleteVertex() {
    if (done) return;
    done = true;
    const w = getActiveWall();
    if (w && vertexIdx >= 0 && vertexIdx < w.vertices.length) {
      w.vertices.splice(vertexIdx, 1);
      if (w.vertices.length < 3) w.closed = false;
    }
    cleanup();
    draw();
  }
  function cancel() {
    if (done) return;
    done = true;
    cleanup();
  }
  function cleanup() {
    popup.style.display = 'none';
    delBtn.removeEventListener('click', deleteVertex);
    document.removeEventListener('keydown', onKey);
    dimEditorClose = null;
  }
  function onKey(e) {
    // Пропускай, ако фокусът е в текстово поле (напр. име на стена) — иначе Delete
    // там би изтрил връх, докато потребителят само редактира текст.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) {
      // Допустимо изключение: ако фокусът е на самия delBtn (бутон) — Delete сработва.
      if (tgt !== delBtn) return;
    }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteVertex(); }
  }

  delBtn.addEventListener('click', deleteVertex);
  document.addEventListener('keydown', onKey);

  // Външно затваряне = cancel (без изтриване)
  dimEditorClose = cancel;
}

/* ============================================================
   ЗАПИС / ЗАРЕЖДАНЕ В LOCALSTORAGE
   ============================================================ */

function serializeState() {
  return {
    version: 2,
    walls: walls.map(w => ({
      id: w.id,
      name: w.name,
      vertices: w.vertices.map(v => ({ x: v.x, y: v.y })),
      closed: w.closed,
      openings: w.openings.map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
      params: w.params ? { ...w.params } : { ...DEFAULT_PARAMS },
    })),
    nextWallId,
    activeWallId,
    view: { scale: view.scale, tx: view.tx, ty: view.ty },
    // Само ГЛОБАЛНИ настройки (мащаб) на това ниво. Параметрите на плочките са per-wall.
    globalSettings: {
      gridCm: UI.gridCm.value,
      snap: UI.snap.checked,
    },
    savedAt: Date.now(),
  };
}

function saveState() {
  try {
    const data = JSON.stringify(serializeState());
    localStorage.setItem(STORAGE_KEY, data);
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    setSaveStatus(`Запазено в ${hh}:${mm}:${ss}`, 'ok');
  } catch (e) {
    console.error('Save failed:', e);
    setSaveStatus('Грешка при запис (вероятно localStorage е недостъпен).', 'err');
  }
}

// Debounced save — извиква се след всеки draw, реално записва ~400ms след затихване
function scheduleSave() {
  if (loading) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

// Прилага parsed state обект (от localStorage или от импортиран JSON). Връща bool.
function applyLoadedState(data) {
  if (!data || !Array.isArray(data.walls)) return false;
  // Поддържаме версии 1 (стар формат с глобални params) и 2 (нов формат с per-wall params).
  if (data.version !== 1 && data.version !== 2) return false;

  loading = true;
  try {
    // Backward compat: за v1 използваме глобалните params като базови за всички стени.
    const legacyParams = (data.version === 1 && data.params) ? {
      tileW: Number(data.params.tileW) || DEFAULT_PARAMS.tileW,
      tileH: Number(data.params.tileH) || DEFAULT_PARAMS.tileH,
      grout: Number(data.params.grout) || DEFAULT_PARAMS.grout,
      waste: Number(data.params.waste) || DEFAULT_PARAMS.waste,
      rotate: !!data.params.rotate,
      pattern: data.params.pattern || DEFAULT_PARAMS.pattern,
      offset: Number(data.params.offset) || DEFAULT_PARAMS.offset,
      startX: Number(data.params.startX) || 0,
      startY: Number(data.params.startY) || 0,
      layoutAngle: Number(data.params.layoutAngle) || 0,
      perBox: Number(data.params.perBox) || DEFAULT_PARAMS.perBox,
    } : null;

    walls.length = 0;
    for (const w of data.walls) {
      // Параметрите: предпочитани от стената; ако ги няма — legacy глобални; иначе defaults.
      let wallParams;
      if (w.params) {
        wallParams = { ...DEFAULT_PARAMS, ...w.params };
      } else if (legacyParams) {
        wallParams = { ...legacyParams };
      } else {
        wallParams = { ...DEFAULT_PARAMS };
      }
      walls.push({
        id: w.id,
        name: w.name || `Стена ${w.id}`,
        vertices: (w.vertices || []).map(v => ({ x: Number(v.x), y: Number(v.y) })),
        closed: !!w.closed,
        openings: (w.openings || []).map(o => ({
          x: Number(o.x), y: Number(o.y),
          w: Number(o.w), h: Number(o.h),
        })),
        params: wallParams,
      });
    }
    const maxId = walls.reduce((m, w) => Math.max(m, w.id), 0);
    nextWallId = Math.max(data.nextWallId || 0, maxId + 1);
    activeWallId = data.activeWallId;
    if (!walls.some(w => w.id === activeWallId) && walls.length > 0) {
      activeWallId = walls[0].id;
    }

    if (data.view) {
      if (Number.isFinite(data.view.scale)) view.scale = data.view.scale;
      if (Number.isFinite(data.view.tx)) view.tx = data.view.tx;
      if (Number.isFinite(data.view.ty)) view.ty = data.view.ty;
    }

    // Глобални настройки (v2 → data.globalSettings; v1 → data.params)
    const gs = data.globalSettings || data.params || {};
    const setIf = (el, val) => { if (val !== undefined && val !== null && val !== '') el.value = val; };
    setIf(UI.gridCm, gs.gridCm);
    if (gs.snap !== undefined) UI.snap.checked = !!gs.snap;

    // Заредим params на активната стена в UI inputs
    const activeW = getActiveWall();
    if (activeW && activeW.params) loadParamsToUI(activeW.params);

    return true;
  } finally {
    loading = false;
  }
}

// Чете записа от localStorage и го прилага. Връща bool.
function loadState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    console.error('localStorage недостъпно:', e);
    return false;
  }
  if (!raw) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Невалиден JSON в запис:', e);
    return false;
  }
  return applyLoadedState(data);
}

function clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
}

// Сваля текущия state като JSON файл, име с timestamp.
function exportProject() {
  try {
    const state = serializeState();
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const t = new Date();
    const stamp = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}_${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`;
    a.href = url;
    a.download = `tile-project-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setSaveStatus(`Експорт: ${a.download}`, 'ok');
  } catch (e) {
    console.error('Export failed:', e);
    setSaveStatus(`Грешка при експорт: ${e.message}`, 'err');
  }
}

// Зарежда state от избран JSON файл. Заменя текущия проект (с потвърждение).
function importProject(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.target.result);
    } catch (err) {
      setSaveStatus(`Невалиден JSON: ${err.message}`, 'err');
      return;
    }
    if (!data || !Array.isArray(data.walls)) {
      setSaveStatus('Файлът не съдържа валиден проект.', 'err');
      return;
    }
    const n = data.walls.length;
    if (!confirm(`Импортирай ${n} ${n === 1 ? 'стена' : 'стени'} от файла? Това ще замени текущия проект.`)) {
      return;
    }
    const ok = applyLoadedState(data);
    if (!ok) {
      setSaveStatus('Невалиден или несъвместим формат на файла.', 'err');
      return;
    }
    // Презареди UI след импорт
    renderWallsList();
    const active = getActiveWall();
    if (active && active.params) loadParamsToUI(active.params);
    resizeCanvas();
    draw();
    setSaveStatus(`Импортирани ${walls.length} ${walls.length === 1 ? 'стена' : 'стени'} от файл.`, 'ok');
  };
  reader.onerror = () => setSaveStatus('Грешка при четене на файла.', 'err');
  reader.readAsText(file);
}

function setSaveStatus(text, kind) {
  if (!UI.saveStatus) return;
  UI.saveStatus.textContent = text;
  UI.saveStatus.classList.remove('ok', 'err');
  if (kind) UI.saveStatus.classList.add(kind);
}

/* ============================================================
   UI РЕФЕРЕНЦИИ И БУТОНИ
   ============================================================ */

const UI = {
  gridCm: document.getElementById('gridCm'),
  snap: document.getElementById('snap'),
  tileW: document.getElementById('tileW'),
  tileH: document.getElementById('tileH'),
  grout: document.getElementById('grout'),
  waste: document.getElementById('waste'),
  rotate: document.getElementById('rotate'),
  pattern: document.getElementById('pattern'),
  offset: document.getElementById('offset'),
  startX: document.getElementById('startX'),
  startY: document.getElementById('startY'),
  layoutAngle: document.getElementById('layoutAngle'),
  perBox: document.getElementById('perBox'),

  btnPolygon: document.getElementById('btnPolygon'),
  btnRect: document.getElementById('btnRect'),
  btnOpening: document.getElementById('btnOpening'),
  btnEdit: document.getElementById('btnEdit'),
  btnMeasure: document.getElementById('btnMeasure'),
  btnFinish: document.getElementById('btnFinish'),
  btnUndo: document.getElementById('btnUndo'),
  btnClear: document.getElementById('btnClear'),
  btnAddWall: document.getElementById('btnAddWall'),
  btnSave: document.getElementById('btnSave'),
  btnClearStorage: document.getElementById('btnClearStorage'),
  btnExport: document.getElementById('btnExport'),
  btnImport: document.getElementById('btnImport'),
  fileImport: document.getElementById('fileImport'),
  saveStatus: document.getElementById('saveStatus'),
  vertexX: document.getElementById('vertexX'),
  vertexY: document.getElementById('vertexY'),
  btnAddVertex: document.getElementById('btnAddVertex'),
  coordStatus: document.getElementById('coordStatus'),

  mWhole: document.getElementById('mWhole'),
  mCut: document.getElementById('mCut'),
  mTotal: document.getElementById('mTotal'),
  mArea: document.getElementById('mArea'),
  mBoxes: document.getElementById('mBoxes'),
  hintMsg: document.getElementById('hintMsg'),
  status: document.getElementById('status'),
};

function setTool(t) {
  if (dimEditorClose) dimEditorClose();
  activeTool = t;
  for (const [name, btn] of [
    [tools.POLYGON, UI.btnPolygon],
    [tools.RECT,    UI.btnRect],
    [tools.OPENING, UI.btnOpening],
    [tools.EDIT,    UI.btnEdit],
    [tools.MEASURE, UI.btnMeasure],
  ]) {
    btn.classList.toggle('active', name === t);
  }
  rectDraft = null;
  openingDraft = null;
  // Изчистваме измерването при смяна на инструмент (за чист холст)
  if (t !== tools.MEASURE) measurement = null;
  setStatus();
  draw();
}

function setStatus(extra) {
  const base = {
    [tools.POLYGON]: 'Полигон: кликай за върхове. „Затвори контура" когато си готов.',
    [tools.RECT]:    'Правоъгълник: влачи за бързо чертане на стена.',
    [tools.OPENING]: 'Отвор: влачи правоъгълник вътре в стената.',
    [tools.EDIT]:    'Редакция: влачи връх/ъгъл; клик на ръб = дължина или нов връх; десен клик трие.',
    [tools.MEASURE]: 'Рулетка: кликни две точки за разстояние. Snap към върхове и решетка. Esc — отказ.',
  }[activeTool];
  const w = getActiveWall();
  const wn = w ? `[${w.name}]` : '';
  const cur = `  ·  курсор: ${Math.round(cursorModel.x)}, ${Math.round(cursorModel.y)} см`;
  UI.status.textContent = (extra ? extra + '  ·  ' : '') + `${wn}  ${base}` + cur;
}

UI.btnPolygon.addEventListener('click', () => setTool(tools.POLYGON));
UI.btnRect.addEventListener('click',    () => setTool(tools.RECT));
UI.btnOpening.addEventListener('click', () => setTool(tools.OPENING));
UI.btnEdit.addEventListener('click',    () => setTool(tools.EDIT));
UI.btnMeasure.addEventListener('click', () => setTool(tools.MEASURE));

UI.btnFinish.addEventListener('click', () => {
  const w = getActiveWall();
  if (w && w.vertices.length >= 3) {
    w.closed = true;
    draw();
  }
});

UI.btnUndo.addEventListener('click', () => {
  if (dimEditorClose) dimEditorClose();
  const w = getActiveWall();
  if (!w) return;
  if (!w.closed && w.vertices.length > 0) {
    w.vertices.pop();
  } else if (w.closed) {
    w.closed = false;
  }
  draw();
});

UI.btnClear.addEventListener('click', () => {
  if (dimEditorClose) dimEditorClose();
  const w = getActiveWall();
  if (!w) return;
  if (!confirm(`Изчисти „${w.name}" (върхове и отвори)?`)) return;
  w.vertices.length = 0;
  w.openings.length = 0;
  w.closed = false;
  rectDraft = null;
  openingDraft = null;
  draw();
});

UI.btnAddWall.addEventListener('click', () => {
  if (dimEditorClose) dimEditorClose();
  createWall(true);
  setTool(tools.POLYGON);
  draw();
});

UI.btnSave.addEventListener('click', () => {
  if (dimEditorClose) dimEditorClose();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveState();
});

UI.btnClearStorage.addEventListener('click', () => {
  if (!confirm('Изтрий записа в браузъра? Текущият чертеж в момента остава.')) return;
  clearStorage();
  setSaveStatus('Записът е изтрит. Следваща промяна ще запази отначало.', null);
});

UI.btnExport.addEventListener('click', () => {
  if (dimEditorClose) dimEditorClose();
  exportProject();
});

UI.btnImport.addEventListener('click', () => {
  // Resetваме value-то, така че повторно избиране на същия файл пак да фaйъра change
  UI.fileImport.value = '';
  UI.fileImport.click();
});

UI.fileImport.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importProject(file);
});

function setCoordStatus(text, kind) {
  if (!UI.coordStatus) return;
  UI.coordStatus.textContent = text;
  UI.coordStatus.classList.remove('ok', 'err');
  if (kind) UI.coordStatus.classList.add(kind);
}

function addVertexByCoords() {
  const xRaw = UI.vertexX.value;
  const yRaw = UI.vertexY.value;
  if (xRaw === '' || yRaw === '') {
    setCoordStatus('Попълни X и Y.', 'err');
    return;
  }
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    setCoordStatus('Невалидни X/Y координати.', 'err');
    return;
  }
  const w = getActiveWall();
  if (!w) {
    setCoordStatus('Няма активна стена.', 'err');
    return;
  }
  if (w.closed) {
    setCoordStatus(`Стената „${w.name}" е затворена. Натисни „Назад", за да я отвориш, или „+ Нова стена".`, 'err');
    return;
  }
  if (dimEditorClose) dimEditorClose();
  const p = snapToGrid({ x, y });
  w.vertices.push(p);
  if (activeTool !== tools.POLYGON) setTool(tools.POLYGON);
  draw();
  setCoordStatus(`Добавен връх ${Math.round(p.x)}, ${Math.round(p.y)} в „${w.name}". Общо върхове: ${w.vertices.length}.`, 'ok');
  // Готово за следващ връх — фокус назад в X, селектиране за бързо презаписване.
  UI.vertexX.focus();
  UI.vertexX.select();
}

UI.btnAddVertex.addEventListener('click', addVertexByCoords);
UI.vertexX.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); UI.vertexY.focus(); UI.vertexY.select(); }
});
UI.vertexY.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addVertexByCoords(); }
});

// Тези настройки са per-wall — промяната им се записва в активната стена.
const PER_WALL_INPUTS = [
  UI.tileW, UI.tileH, UI.grout, UI.waste, UI.rotate,
  UI.pattern, UI.offset, UI.startX, UI.startY, UI.layoutAngle, UI.perBox,
];
for (const el of PER_WALL_INPUTS) {
  const handler = () => { commitUIToActiveWall(); draw(); };
  el.addEventListener('input', handler);
  el.addEventListener('change', handler);
}

// Тези са глобални (важат за всички стени) — мащаб и решетка.
for (const el of [UI.gridCm, UI.snap]) {
  el.addEventListener('input', draw);
  el.addEventListener('change', draw);
}

/* ============================================================
   ВХОД: мишка / тъч / колелце — върху АКТИВНАТА стена
   ============================================================ */

function getEventPos(e) {
  const rect = cv.getBoundingClientRect();
  let cx, cy;
  if (e.touches && e.touches.length > 0) {
    cx = e.touches[0].clientX; cy = e.touches[0].clientY;
  } else if (e.changedTouches && e.changedTouches.length > 0) {
    cx = e.changedTouches[0].clientX; cy = e.changedTouches[0].clientY;
  } else {
    cx = e.clientX; cy = e.clientY;
  }
  return { sx: cx - rect.left, sy: cy - rect.top };
}

function onPointerDown(e) {
  if (e.cancelable) e.preventDefault();
  const { sx, sy } = getEventPos(e);
  const model = snapToGrid(screenToModel(sx, sy));
  const rawModel = screenToModel(sx, sy);
  cursorModel = rawModel;

  // Ако има отворен popup — този клик само го затваря. Без вторично действие
  // (иначе в POLYGON mode щеше да добави случаен връх и т.н.).
  if (dimEditorClose) {
    dimEditorClose();
    return;
  }

  // Пан: десен бутон (2), среден бутон (1), или Space + ляв бутон
  if (e.button === 2 || e.button === 1 || (spaceHeld && e.button === 0)) {
    drag.type = 'pan';
    drag.startX = sx; drag.startY = sy;
    drag.origX = view.tx; drag.origY = view.ty;
    return;
  }

  const w = getActiveWall();
  if (!w) return;

  if (activeTool === tools.POLYGON) {
    if (w.closed) return;
    if (w.vertices.length >= 3) {
      const first = w.vertices[0];
      const s0 = modelToScreen(first.x, first.y);
      if ((s0.x - sx) ** 2 + (s0.y - sy) ** 2 <= VERTEX_PICK_PX * VERTEX_PICK_PX) {
        w.closed = true;
        draw();
        return;
      }
    }
    w.vertices.push(model);
    draw();
    return;
  }

  if (activeTool === tools.RECT) {
    rectDraft = { x0: model.x, y0: model.y, x1: model.x, y1: model.y };
    drag.type = 'rect-draft';
    return;
  }

  if (activeTool === tools.OPENING) {
    if (!w.closed) {
      setStatus('Първо затвори контура на стената.');
      return;
    }
    openingDraft = { x0: model.x, y0: model.y, x1: model.x, y1: model.y };
    drag.type = 'opening-draft';
    return;
  }

  if (activeTool === tools.MEASURE) {
    const p = snapToVertexOrGrid(rawModel);
    if (measurement && measurement.b === null) {
      // Финализирай измерването
      measurement.b = p;
    } else {
      // Старт на ново измерване
      measurement = { a: p, b: null };
    }
    draw();
    return;
  }

  if (activeTool === tools.EDIT) {
    // 1) Връх (най-висок приоритет). Запомняме start екранна позиция,
    //    за да можем в onPointerUp да отличим тап-без-влачене (за popup).
    const vi = pickVertex(sx, sy);
    if (vi >= 0) {
      drag.type = 'vertex';
      drag.index = vi;
      drag.startX = sx;
      drag.startY = sy;
      return;
    }
    // 2) Ъгъл на отвор
    const oc = pickOpeningCorner(sx, sy);
    if (oc) {
      drag.type = 'opening-corner';
      drag.index = oc.i;
      drag.corner = oc.c;
      drag.origRect = { ...w.openings[oc.i] };
      return;
    }
    // 3) Вътрешност на отвор → местене
    const oi = pickOpening(rawModel);
    if (oi >= 0) {
      drag.type = 'opening-move';
      drag.index = oi;
      drag.startX = rawModel.x;
      drag.startY = rawModel.y;
      drag.origRect = { ...w.openings[oi] };
      return;
    }
    // 4) Сегмент → отвори dim editor (дължина или вмъкване на връх)
    const si = pickSegment(sx, sy);
    if (si >= 0) {
      openDimensionEditor(si, rawModel);
      return;
    }
  }
}

function onPointerMove(e) {
  const { sx, sy } = getEventPos(e);
  const rawModel = screenToModel(sx, sy);
  cursorModel = rawModel;
  setStatus();

  // Live preview за рулетката — преди втория клик линията следва курсора
  if (activeTool === tools.MEASURE && measurement && measurement.b === null) {
    draw();
    return;
  }

  if (drag.type === 'pan') {
    view.tx = drag.origX + (sx - drag.startX);
    view.ty = drag.origY + (sy - drag.startY);
    draw();
    return;
  }

  const w = getActiveWall();
  if (!w) return;

  if (drag.type === 'rect-draft' && rectDraft) {
    const m = snapToGrid(rawModel);
    rectDraft.x1 = m.x; rectDraft.y1 = m.y;
    draw();
    return;
  }
  if (drag.type === 'opening-draft' && openingDraft) {
    const m = snapToGrid(rawModel);
    openingDraft.x1 = m.x; openingDraft.y1 = m.y;
    draw();
    return;
  }
  if (drag.type === 'vertex') {
    const m = snapToGrid(rawModel);
    w.vertices[drag.index] = m;
    draw();
    return;
  }
  if (drag.type === 'opening-corner') {
    const m = snapToGrid(rawModel);
    const o = drag.origRect;
    let ox0 = o.x, oy0 = o.y, ox1 = o.x + o.w, oy1 = o.y + o.h;
    if (drag.corner === 0)      { ox0 = m.x; oy0 = m.y; }
    else if (drag.corner === 1) { ox1 = m.x; oy0 = m.y; }
    else if (drag.corner === 2) { ox1 = m.x; oy1 = m.y; }
    else if (drag.corner === 3) { ox0 = m.x; oy1 = m.y; }
    w.openings[drag.index] = {
      x: Math.min(ox0, ox1), y: Math.min(oy0, oy1),
      w: Math.abs(ox1 - ox0), h: Math.abs(oy1 - oy0),
    };
    draw();
    return;
  }
  if (drag.type === 'opening-move') {
    const dx = rawModel.x - drag.startX;
    const dy = rawModel.y - drag.startY;
    let nx = drag.origRect.x + dx;
    let ny = drag.origRect.y + dy;
    if (UI.snap.checked) {
      const g = Math.max(1, Number(UI.gridCm.value) || 10);
      nx = Math.round(nx / g) * g;
      ny = Math.round(ny / g) * g;
    }
    w.openings[drag.index] = { x: nx, y: ny, w: drag.origRect.w, h: drag.origRect.h };
    draw();
  }
}

function onPointerUp(e) {
  let sx = 0, sy = 0;
  if (e) {
    const p = getEventPos(e);
    sx = p.sx; sy = p.sy;
  }

  const w = getActiveWall();

  // Tap-без-влачене на връх → отваряме vertex popup за изтриване.
  // Праг 5px (25 = 5²) — позволява леко тремор без да блокира popup-а.
  let vertexTapIdx = -1;
  if (drag.type === 'vertex' && w) {
    const distSq = (sx - drag.startX) ** 2 + (sy - drag.startY) ** 2;
    if (distSq < 25) vertexTapIdx = drag.index;
  }

  if (w && drag.type === 'rect-draft' && rectDraft) {
    const minX = Math.min(rectDraft.x0, rectDraft.x1);
    const minY = Math.min(rectDraft.y0, rectDraft.y1);
    const maxX = Math.max(rectDraft.x0, rectDraft.x1);
    const maxY = Math.max(rectDraft.y0, rectDraft.y1);
    if (maxX - minX > EPS && maxY - minY > EPS) {
      w.vertices = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
      w.closed = true;
    }
    rectDraft = null;
  }
  if (w && drag.type === 'opening-draft' && openingDraft) {
    const minX = Math.min(openingDraft.x0, openingDraft.x1);
    const minY = Math.min(openingDraft.y0, openingDraft.y1);
    const maxX = Math.max(openingDraft.x0, openingDraft.x1);
    const maxY = Math.max(openingDraft.y0, openingDraft.y1);
    if (maxX - minX > EPS && maxY - minY > EPS) {
      w.openings.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }
    openingDraft = null;
  }
  drag.type = null;
  drag.index = -1;
  drag.corner = -1;
  drag.origRect = null;
  draw();

  // Отваряме vertex popup СЛЕД като сме чисти от drag, и СЛЕД draw —
  // така позицията на върха е окончателна (важно ако е имало snap).
  if (vertexTapIdx >= 0 && w && w.vertices[vertexTapIdx]) {
    const v = w.vertices[vertexTapIdx];
    const sp = modelToScreen(v.x, v.y);
    openVertexPopup(vertexTapIdx, sp);
  }
}

cv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (activeTool !== tools.EDIT) return;
  const w = getActiveWall();
  if (!w) return;
  const { sx, sy } = getEventPos(e);
  const rawModel = screenToModel(sx, sy);
  const vi = pickVertex(sx, sy);
  if (vi >= 0) {
    w.vertices.splice(vi, 1);
    if (w.vertices.length < 3) w.closed = false;
    draw();
    return;
  }
  const oi = pickOpening(rawModel);
  if (oi >= 0) {
    w.openings.splice(oi, 1);
    draw();
  }
});

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    // Zoom — Ctrl/Cmd + wheel, или pinch на trackpad (браузърът праща ctrlKey=true)
    const { sx, sy } = getEventPos(e);
    const before = screenToModel(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.012);
    view.scale = Math.max(0.1, Math.min(50, view.scale * factor));
    const after = screenToModel(sx, sy);
    view.tx += (after.x - before.x) * view.scale;
    view.ty += (after.y - before.y) * view.scale;
  } else if (e.shiftKey) {
    // Shift + wheel = размяна на осите (за мишки без хоризонтално колелце)
    view.tx -= e.deltaY;
    view.ty -= e.deltaX;
  } else {
    // По подразбиране — пан (trackpad връща deltaX и deltaY; mouse wheel само deltaY)
    view.tx -= e.deltaX;
    view.ty -= e.deltaY;
  }
  draw();
}, { passive: false });

cv.addEventListener('mousedown', onPointerDown);
window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mouseup', onPointerUp);

// Среден бутон: браузърът обикновено отваря авто-скрол по подразбиране — спираме го.
cv.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// Помощник — фокусът върху текстово поле/select?
function isInputFocused() {
  const a = document.activeElement;
  return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'));
}

window.addEventListener('keydown', (e) => {
  if (isInputFocused()) return;

  // Esc — отказва текущо измерване (или го изтрива ако е завършено)
  if (e.key === 'Escape' && activeTool === tools.MEASURE && measurement) {
    measurement = null;
    draw();
    e.preventDefault();
    return;
  }

  // Space — задържай за пан с ляв бутон
  if (e.code === 'Space') {
    if (!spaceHeld) {
      spaceHeld = true;
      cv.style.cursor = 'grab';
    }
    e.preventDefault();
    return;
  }

  // Стрелки — местене на изгледа (със Shift — по-голяма стъпка)
  const step = e.shiftKey ? 200 : 40;
  if (e.key === 'ArrowLeft')  { view.tx += step; draw(); e.preventDefault(); return; }
  if (e.key === 'ArrowRight') { view.tx -= step; draw(); e.preventDefault(); return; }
  if (e.key === 'ArrowUp')    { view.ty += step; draw(); e.preventDefault(); return; }
  if (e.key === 'ArrowDown')  { view.ty -= step; draw(); e.preventDefault(); return; }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false;
    cv.style.cursor = '';
  }
});

let pinch = null;
cv.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const a = e.touches[0], b = e.touches[1];
    const rect = cv.getBoundingClientRect();
    pinch = {
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      cx: (a.clientX + b.clientX) / 2 - rect.left,
      cy: (a.clientY + b.clientY) / 2 - rect.top,
      scale: view.scale,
      tx: view.tx, ty: view.ty,
    };
    return;
  }
  onPointerDown(e);
}, { passive: false });

cv.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinch) {
    e.preventDefault();
    const a = e.touches[0], b = e.touches[1];
    const rect = cv.getBoundingClientRect();
    const currCx = (a.clientX + b.clientX) / 2 - rect.left;
    const currCy = (a.clientY + b.clientY) / 2 - rect.top;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const factor = d / (pinch.d || 1);
    const newScale = Math.max(0.1, Math.min(50, pinch.scale * factor));

    // Точката под първоначалния център на пинча остава под текущия център →
    // едновременно зум и пан с движение на двата пръста като група.
    const beforeModel = {
      x: (pinch.cx - pinch.tx) / pinch.scale,
      y: (pinch.cy - pinch.ty) / pinch.scale,
    };
    view.scale = newScale;
    view.tx = currCx - beforeModel.x * view.scale;
    view.ty = currCy - beforeModel.y * view.scale;
    draw();
    return;
  }
  onPointerMove(e);
}, { passive: false });

cv.addEventListener('touchend', (e) => {
  if (pinch && e.touches.length < 2) pinch = null;
  onPointerUp(e);
}, { passive: false });

window.addEventListener('resize', resizeCanvas);

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
   ============================================================ */

const loaded = loadState();
if (!loaded || walls.length === 0) {
  createWall(true);
  setSaveStatus('Автоматично се запазва в браузъра.', null);
} else {
  renderWallsList();
  setSaveStatus(`Заредени ${walls.length} ${walls.length === 1 ? 'стена' : 'стени'} от предишен запис.`, 'ok');
}
resizeCanvas();
setTool(tools.POLYGON);
draw();
