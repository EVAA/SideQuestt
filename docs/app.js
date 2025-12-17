console.log("app.js loaded");

const out = document.getElementById("out");

// Toronto bounding box (SW, NE)
const TORONTO_BOUNDS = {
  minLat: 43.5810,
  maxLat: 43.8555,
  minLon: -79.6393,
  maxLon: -79.1169
};

// ===== Map =====
const map = L.map("map").setView([43.6532, -79.3832], 13);

let tileLayer = null;
function setBasemap(isDark) {
  if (tileLayer) map.removeLayer(tileLayer);

  tileLayer = L.tileLayer(
    isDark
      ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  );

  tileLayer.addTo(map);
}
setBasemap(false);

// ===== State =====
let loopMode = true;
let startMode = "poi0"; // "poi0" | "user"
let placeType = "cafe"; // "cafe" | "night"
let userLatLon = null;

let nearbyRadiusM = 1400;

let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);
let recoLayer = L.layerGroup().addTo(map);
let heatLayer = L.layerGroup().addTo(map);
let routeBadgeLayer = L.layerGroup().addTo(map);


let currPois = [];
let routeLine = null;

let routeAnimTimer = null;
let dashAnimTimer = null;

let lastOrder = null;
let lastLabel = "";
let heatOn = false;

let badgeMarkers = []; // {pos, marker}
let userPickedGradient = false;

// ===== UI helpers =====
function setOutHTML(html) { out.innerHTML = html; }

function safe(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let lastSelectedBtn = null;

function selectBtn(el) {
  if (!el || el.tagName !== "BUTTON") return;
  if (lastSelectedBtn) lastSelectedBtn.classList.remove("is-selected");
  el.classList.add("is-selected");
  lastSelectedBtn = el;
}

function renderMsg(msg) { setOutHTML(`<div class="out-title">${safe(msg)}</div>`); }

function setOn(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("is-on", !!on);
}

function updateStartToggle() {
  const btn = document.getElementById("start-toggle");
  if (!btn) return;
  btn.textContent = (startMode === "poi0") ? "Start: First stop" : "Start: My location";
}

function enableAlgos(ok) {
  ["algo-nn", "algo-2opt", "algo-sa", "algo-ga"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !ok;
  });
}

function placeTypeLabel() {
  return (placeType === "night") ? "Bars + Clubs" : "Cafés";
}

function showToast(msg = "Added to route") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 900);
}

// ===== Walking time =====
const WALK_KMPH = 4.5;
function walkTimeStrFromKm(km) {
  const mins = (km / WALK_KMPH) * 60;
  if (!Number.isFinite(mins)) return "";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - 60 * h);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

// ===== Accent style (blue day, hot pink night) =====
function accentStyle() {
  const isNight = document.body.classList.contains("dark");
  if (isNight) return { color: "#ff1f7a", fillColor: "#ff1f7a" };
  return { color: "#0ea5e9", fillColor: "#0ea5e9" };
}

function refreshMapStyles() {
  const a = accentStyle();
  poiLayer.eachLayer(l => l?.setStyle?.({ color: a.color, fillColor: a.fillColor }));
  recoLayer.eachLayer(l => l?.setStyle?.({ color: a.color, fillColor: a.fillColor }));
  if (routeLine?.setStyle) routeLine.setStyle({ color: a.color });
  if (userMarker?.setStyle) userMarker.setStyle({ color: a.color, fillColor: a.fillColor });

  if (heatOn) buildHeatFromReco();
  if (lastOrder && lastOrder.length) drawRouteBadges(lastOrder);
}

// ===== Distances =====
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = d => d * Math.PI / 180.0;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distPois(i, j) {
  const a = currPois[i], b = currPois[j];
  return haversineKm(a.lat, a.lon, b.lat, b.lon);
}

function distFromUserToIdx(i) {
  if (!userLatLon) return Infinity;
  return haversineKm(userLatLon.lat, userLatLon.lon, currPois[i].lat, currPois[i].lon);
}

function routeLengthKm(order) {
  if (!order || !order.length) return 0;

  if (startMode === "user" && userLatLon) {
    let tot = 0;
    tot += haversineKm(userLatLon.lat, userLatLon.lon, currPois[order[0]].lat, currPois[order[0]].lon);
    for (let i = 0; i < order.length - 1; i++) tot += distPois(order[i], order[i + 1]);
    if (loopMode) {
      tot += haversineKm(
        userLatLon.lat, userLatLon.lon,
        currPois[order[order.length - 1]].lat, currPois[order[order.length - 1]].lon
      );
    }
    return tot;
  }

  let tot = 0;
  for (let i = 0; i < order.length - 1; i++) tot += distPois(order[i], order[i + 1]);
  if (loopMode) tot += distPois(order[order.length - 1], order[0]);
  return tot;
}

// ===== Route points =====
function buildRoutePoints(order) {
  if (!order || !order.length) return [];

  if (startMode === "user" && userLatLon) {
    const pts = [{ lat: userLatLon.lat, lon: userLatLon.lon, name: "You", kind: "start" }];
    order.forEach(idx => pts.push({ lat: currPois[idx].lat, lon: currPois[idx].lon, name: currPois[idx].name, kind: "poi", idx }));
    if (loopMode) pts.push({ lat: userLatLon.lat, lon: userLatLon.lon, name: "You", kind: "end" });
    return pts;
  }

  const pts = order.map(idx => ({ lat: currPois[idx].lat, lon: currPois[idx].lon, name: currPois[idx].name, kind: "poi", idx }));
  if (loopMode) pts.push({ lat: currPois[order[0]].lat, lon: currPois[order[0]].lon, name: currPois[order[0]].name, kind: "end" });
  return pts;
}

function googleMapsFullRouteUrl(order) {
  const pts = buildRoutePoints(order);
  if (pts.length < 2) return null;

  const origin = `${pts[0].lat},${pts[0].lon}`;
  const destination = `${pts[pts.length - 1].lat},${pts[pts.length - 1].lon}`;
  const mids = pts.slice(1, -1).map(p => `${p.lat},${p.lon}`);
  const wp = mids.length ? `&waypoints=${encodeURIComponent(mids.join("|"))}` : "";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${wp}&travelmode=walking`;
}

function gmapsDirUrl(a, b) {
  return `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${b.lat},${b.lon}&travelmode=walking`;
}

// ===== Algorithms =====
function nnOrder(startIdx = 0) {
  const n = currPois.length;
  const rem = new Set([...Array(n).keys()].filter(i => i !== startIdx));
  const order = [startIdx];

  while (rem.size) {
    const last = order[order.length - 1];
    let best = null, bestD = Infinity;
    for (const j of rem) {
      const d = distPois(last, j);
      if (d < bestD) { bestD = d; best = j; }
    }
    order.push(best);
    rem.delete(best);
  }
  return order;
}

function nnOrderFromUser() {
  const n = currPois.length;
  let first = 0, best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = distFromUserToIdx(i);
    if (d < best) { best = d; first = i; }
  }

  const rem = new Set([...Array(n).keys()].filter(i => i !== first));
  const order = [first];

  while (rem.size) {
    const last = order[order.length - 1];
    let pick = null, pickD = Infinity;
    for (const j of rem) {
      const d = distPois(last, j);
      if (d < pickD) { pickD = d; pick = j; }
    }
    order.push(pick);
    rem.delete(pick);
  }
  return order;
}

function getBaseOrder() {
  if (startMode === "user" && userLatLon) return nnOrderFromUser();
  return nnOrder(0);
}

function twoOpt(order) {
  const n = order.length;
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 1; i < n - 2; i++) {
      for (let k = i + 1; k < n - 1; k++) {
        const a = order[i - 1], b = order[i];
        const c = order[k], d = order[k + 1];

        const before = distPois(a, b) + distPois(c, d);
        const after = distPois(a, c) + distPois(b, d);

        if (after + 1e-12 < before) {
          const seg = order.slice(i, k + 1).reverse();
          order.splice(i, k - i + 1, ...seg);
          improved = true;
        }
      }
    }
  }
  return order;
}

function saOrder(baseOrder, iters = 2500) {
  let best = baseOrder.slice();
  let bestCost = routeLengthKm(best);

  let curr = baseOrder.slice();
  let currCost = bestCost;

  let T = 0.5;
  const cool = 0.999;

  function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

  for (let t = 0; t < iters; t++) {
    const i = randInt(1, curr.length - 3);
    const k = randInt(i + 1, curr.length - 2);

    const cand = curr.slice();
    const seg = cand.slice(i, k + 1).reverse();
    cand.splice(i, k - i + 1, ...seg);

    const candCost = routeLengthKm(cand);
    const dE = candCost - currCost;

    if (dE < 0 || Math.random() < Math.exp(-dE / Math.max(1e-9, T))) {
      curr = cand;
      currCost = candCost;
      if (currCost < bestCost) { best = curr.slice(); bestCost = currCost; }
    }
    T *= cool;
  }
  return best;
}

function gaLite(bestOf = 40) {
  const n = currPois.length;
  const base = [...Array(n).keys()];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  let best = twoOpt(getBaseOrder().slice());
  let bestCost = routeLengthKm(best);

  for (let r = 0; r < bestOf; r++) {
    const cand = base.slice();
    shuffle(cand);
    const polished = twoOpt(cand);
    const c = routeLengthKm(polished);
    if (c < bestCost) { best = polished; bestCost = c; }
  }
  return best;
}

// ===== Route arrows + dashed motion =====
function bearingDeg(a, b) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  const lat1 = toRad(a.lat), lon1 = toRad(a.lon);
  const lat2 = toRad(b.lat), lon2 = toRad(b.lon);

  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

function drawRouteArrows(points) {
  routeArrowLayer.clearLayers();
  if (!points || points.length < 2) return;

  const a = accentStyle(); // hot pink in night mode

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const mid = { lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2 };
    const ang = bearingDeg(p1, p2);

    const icon = L.divIcon({
      className: "route-arrow",
      html: `<div class="route-arrow-inner" style="--arrow:${a.color}; transform: rotate(${ang}deg)">➤</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    L.marker([mid.lat, mid.lon], { icon, interactive: false, zIndexOffset: 700 })
      .addTo(routeArrowLayer);
  }
}

function startDashAnimation() {
  if (!routeLine) return;
  if (dashAnimTimer) clearInterval(dashAnimTimer);

  let off = 0;
  dashAnimTimer = setInterval(() => {
    if (!routeLine) return;
    off = (off - 2) % 1000;
    try { routeLine.setStyle({ dashOffset: String(off) }); } catch {}
  }, 60);
}

// ===== Badges (hover sync) =====
function clearBadgeMarkers() {
  badgeMarkers = [];
  routeBadgeLayer.clearLayers();
}

function highlightListPos(pos, on) {
  const el = document.querySelector(`.route-bubbles [data-pos="${pos}"]`);
  if (!el) return;
  el.classList.toggle("is-hover", !!on);
}

function drawRouteBadges(order) {
  clearBadgeMarkers();
  if (!order || !order.length) return;

  const seq = [];
  if (startMode === "user" && userLatLon) {
    seq.push({ lat: userLatLon.lat, lon: userLatLon.lon, pos: 1, name: "You" });
    order.forEach((idx, k) => {
      const p = currPois[idx];
      seq.push({ lat: p.lat, lon: p.lon, pos: k + 2, name: p.name });
    });
  } else {
    order.forEach((idx, k) => {
      const p = currPois[idx];
      seq.push({ lat: p.lat, lon: p.lon, pos: k + 1, name: p.name });
    });
  }

  const a = accentStyle();

  seq.forEach(s => {
    const icon = L.divIcon({
      className: "stop-badge",
      html: `<div class="stop-badge-inner" style="--badge-ring:${a.color}">${s.pos}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    const mk = L.marker([s.lat, s.lon], { icon, interactive: true, zIndexOffset: 900 })
      .addTo(routeBadgeLayer);

    mk.on("mouseover", () => highlightListPos(s.pos, true));
    mk.on("mouseout", () => highlightListPos(s.pos, false));

    badgeMarkers.push({ pos: s.pos, marker: mk });
  });
}

// ===== Clear route =====
function clearRoute() {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = null;

  if (routeAnimTimer) { clearInterval(routeAnimTimer); routeAnimTimer = null; }
  if (dashAnimTimer) { clearInterval(dashAnimTimer); dashAnimTimer = null; }
  clearBadgeMarkers();
}

// ===== Plot POIs =====
function plotPois() {
  poiLayer.clearLayers();
  clearRoute();

  const a = accentStyle();

  currPois.forEach((p) => {
    L.circleMarker([p.lat, p.lon], {
      radius: 7,
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0.9,
      color: a.color,
      fillColor: a.fillColor,
      className: "poi-dot"
    }).addTo(poiLayer).bindPopup(safe(p.name));
  });

  enableAlgos(currPois.length >= 2);
  document.getElementById("optimize-btn")?.toggleAttribute("disabled", !(lastOrder && lastOrder.length));
}

// ===== Draw route =====
function drawRoute(order) {
  if (!order || !order.length) return;

  const pts = buildRoutePoints(order);
  const latlngs = pts.map(p => [p.lat, p.lon]);

  clearRoute();

  const a = accentStyle();

  routeLine = L.polyline([latlngs[0]], {
    weight: 7,
    opacity: 0.95,
    lineJoin: "round",
    color: a.color,
    dashArray: "12 10",
    dashOffset: "0",
    className: "route-line"
  }).addTo(map);

  let i = 1;
  routeAnimTimer = setInterval(() => {
    if (!routeLine) return;
    routeLine.addLatLng(latlngs[i]);
    i += 1;
    if (i >= latlngs.length) {
      clearInterval(routeAnimTimer);
      routeAnimTimer = null;
      startDashAnimation();
    }
  }, 18);

  drawRouteBadges(order);
}

// ===== Heatmap =====
function buildHeatFromReco() {
  heatLayer.clearLayers();
  if (!heatOn) return;

  const buckets = new Map();
  recoLayer.eachLayer(l => {
    const ll = l.getLatLng?.();
    if (!ll) return;
    const key = `${ll.lat.toFixed(3)},${ll.lng.toFixed(3)}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  });

  const a = accentStyle(); // hot pink in night mode

  buckets.forEach((cnt, key) => {
    const [latS, lonS] = key.split(",");
    const lat = Number(latS), lon = Number(lonS);
    const r = Math.min(42, 10 + cnt * 6);

    L.circleMarker([lat, lon], {
      radius: r,
      weight: 0,
      opacity: 0,
      fillOpacity: 0.16,
      fillColor: a.color,
      className: "heat-blob"
    }).addTo(heatLayer);
  });
}

// ===== Route rendering (legs + full route) =====
function renderRoute(order, label) {
  const km = routeLengthKm(order);
  const walkStr = walkTimeStrFromKm(km);
  const fullUrl = googleMapsFullRouteUrl(order);

  const pts = buildRoutePoints(order);
  const showReturn = loopMode && pts.length >= 2;

  const items = [];

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const pos = i + 1;

    let legUrl = null;
    let legLabel = "";
    if (i < pts.length - 1) {
      legUrl = gmapsDirUrl({ lat: pts[i].lat, lon: pts[i].lon }, { lat: pts[i + 1].lat, lon: pts[i + 1].lon });
      legLabel = `${pos} → ${pos + 1}`;
    }

    if (showReturn && i === pts.length - 1) break;

    const canRemove = (p.kind === "poi") && (typeof p.idx === "number");

    items.push(`
      <li class="bubble" data-pos="${pos}">
        <div class="num">${pos}</div>
        <div>
          <div class="name">${safe(p.name || "Stop")}</div>
          <div class="hint">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
        </div>
        <div class="row-actions">
          ${legUrl ? `<a class="pill" href="${legUrl}" target="_blank" rel="noopener">${safe(legLabel)}</a>` : ""}
          ${canRemove ? `<button class="pill" data-del="${p.idx}" type="button">Remove</button>` : ""}
        </div>
      </li>
    `);
  }

  if (showReturn) {
    const pos = pts.length;
    const destName = (startMode === "user" && userLatLon) ? "You" : (currPois.length ? currPois[0].name : "Start");
    items.push(`
      <li class="bubble is-return" data-pos="${pos}">
        <div class="num">${pos}</div>
        <div>
          <div class="name">Return to ${safe(destName)}</div>
          <div class="hint">${pts[pts.length - 1].lat.toFixed(4)}, ${pts[pts.length - 1].lon.toFixed(4)}</div>
        </div>
        <div class="row-actions"></div>
      </li>
    `);
  }

  setOutHTML(`
    <div class="statsbar">
      <div class="stats-left">
        <span class="chip">${safe(label || "Route")}</span>
        <span class="chip">Distance: ${km.toFixed(2)} km</span>
        <span class="chip">Walk: ${safe(walkStr)}</span>
        <span class="chip">${loopMode ? "Loop" : "One-way"}</span>
      </div>
      <div class="stats-right">
        ${fullUrl ? `<a class="pill" href="${fullUrl}" target="_blank" rel="noopener">Open full route in Google Maps</a>` : ""}
      </div>
    </div>

    <ol class="route-bubbles">${items.join("")}</ol>
  `);

  // list -> badge hover
  document.querySelectorAll(".route-bubbles .bubble[data-pos]").forEach(li => {
    li.addEventListener("mouseenter", () => {
      const pos = Number(li.getAttribute("data-pos"));
      const bm = badgeMarkers.find(x => x.pos === pos)?.marker;
      bm?.setZIndexOffset?.(1200);
      li.classList.add("is-hover");
    });
    li.addEventListener("mouseleave", () => {
      const pos = Number(li.getAttribute("data-pos"));
      const bm = badgeMarkers.find(x => x.pos === pos)?.marker;
      bm?.setZIndexOffset?.(900);
      li.classList.remove("is-hover");
    });
  });

  // remove
  document.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-del"));
      if (!Number.isFinite(idx)) return;
      currPois.splice(idx, 1);
      lastOrder = null;
      lastLabel = "";
      plotPois();
      updateRadiusUI();
      renderMsg("Removed stop. Re-run an algorithm.");
    });
  });

  document.getElementById("optimize-btn")?.toggleAttribute("disabled", !(lastOrder && lastOrder.length));
}

// ===== Add POI =====
function addPOI(name, lat, lon) {
  currPois.push({ name, lat, lon });
  plotPois();
  map.setView([lat, lon], 15);
  updateRadiusUI();
  renderMsg(`Added: ${name}.`);
}

// ===== Search =====
async function nominatimAutocomplete(q) {
  if (!userLatLon) return [];

  const url =
    `https://nominatim.openstreetmap.org/search?` +
    `format=json&limit=5&addressdetails=1` +
    `&viewbox=${TORONTO_BOUNDS.minLon},${TORONTO_BOUNDS.maxLat},${TORONTO_BOUNDS.maxLon},${TORONTO_BOUNDS.minLat}` +
    `&bounded=1` +
    `&lat=${userLatLon.lat}&lon=${userLatLon.lon}` +
    `&q=${encodeURIComponent(q)}`;

  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return [];
  return await res.json();
}

// ===== Overpass recommend nearby =====
function overpassAmenityFilter() {
  if (placeType === "night") return `["amenity"~"bar|pub|nightclub"]`;
  return `["amenity"="cafe"]`;
}

function getAnchorLatLonForRecommendations() {
  if (startMode === "poi0" && currPois.length >= 1) {
    return { lat: currPois[0].lat, lon: currPois[0].lon };
  }
  return userLatLon;
}

async function overpassQuery(query) {
  const url = "https://overpass-api.de/api/interpreter";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error(`Overpass failed: ${res.status}`);
  return await res.json();
}

function scoreReco(el) {
  const tags = el.tags || {};
  const named = tags.name ? 1 : 0;
  const tagCount = Object.keys(tags).length;
  return named * 100 + tagCount;
}

function addRecoMarker(p) {
  const lat = p.lat;
  const lon = p.lon;
  const name = p.name || "Place";

  const a = accentStyle();

  const m = L.circleMarker([lat, lon], {
    radius: 7,
    weight: 2,
    opacity: 0.95,
    fillOpacity: 0.95,
    color: a.color,
    fillColor: a.fillColor,
    className: "reco-dot"
  }).addTo(recoLayer);

  const btnId = `addstop-${p._id}`;

  m.bindPopup(`
    <div style="min-width: 200px">
      <div style="font-weight: 850; margin-bottom: 8px;">${safe(name)}</div>
      <button id="${btnId}" type="button" style="padding:8px 10px; border-radius:12px; cursor:pointer;">
        Add to route
      </button>
    </div>
  `);

  m.on("popupopen", () => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.onclick = () => {
      addPOI(name, lat, lon);
      showToast("Added to route");
      map.closePopup();
    };
  });
}

async function recommendNearby() {
  const anchor = getAnchorLatLonForRecommendations();
  if (!anchor) return renderMsg("Tap “Use my location” or add your first stop first.");

  const radiusM = Number(document.getElementById("radius-slider")?.value) || nearbyRadiusM || 1400;
  const f = overpassAmenityFilter();

  renderMsg(`Finding nearby ${placeTypeLabel()}…`);
  recoLayer.clearLayers();
  if (heatOn) heatLayer.clearLayers();

  const q = `
[out:json][timeout:25];
(
  node${f}(around:${radiusM},${anchor.lat},${anchor.lon});
  way${f}(around:${radiusM},${anchor.lat},${anchor.lon});
  relation${f}(around:${radiusM},${anchor.lat},${anchor.lon});
);
out center tags;
`;

  try {
    const js = await overpassQuery(q);
    const elems = (js.elements || []);
    if (!elems.length) return renderMsg(`No nearby ${placeTypeLabel()} found.`);

    const pts = [];
    for (let i = 0; i < elems.length; i++) {
      const el = elems[i];
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      pts.push({
        _id: `r${i}`,
        lat,
        lon,
        name: el.tags?.name || "Place",
        _score: scoreReco(el)
      });
    }

    pts.sort((a, b) => (b._score - a._score));
    const top = pts.slice(0, 50);
    if (!top.length) return renderMsg(`No nearby ${placeTypeLabel()} found.`);

    top.forEach(addRecoMarker);
    refreshMapStyles();

    if (heatOn) buildHeatFromReco();

    const bounds = L.latLngBounds(top.map(p => [p.lat, p.lon]));
    map.fitBounds(bounds, { padding: [20, 20] });

    showToast(`Found ${top.length}`);
  } catch (e) {
    console.error(e);
    renderMsg(`Nearby search failed: ${e?.message || "unknown error"}`);
  }
}

// ===== Radius chip + gradient slider fill =====
function hasNearbyAnchor() { return !!getAnchorLatLonForRecommendations(); }

function setRangeFill(el) {
  if (!el) return;
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const val = Number(el.value) || min;
  const pct = ((val - min) / Math.max(1, (max - min))) * 100;
  el.style.setProperty("--range-pct", `${pct.toFixed(1)}%`);
}

function updateRadiusUI() {
  const chip = document.getElementById("radius-chip");
  const chipBtn = document.getElementById("radius-chip-btn");
  const slider = document.getElementById("radius-slider");

  const ok = hasNearbyAnchor();
  chip?.classList.toggle("is-disabled", !ok);
  if (chipBtn) chipBtn.disabled = !ok;

  setRangeFill(slider);
}

// ===== Gradient theme =====
function applyGradTheme(val) {
  document.body.classList.remove("g1", "g2", "g3");
  document.body.classList.add(val);
  try { localStorage.setItem("gradTheme", val); } catch {}
  setRangeFill(document.getElementById("radius-slider"));
}

// ===== Presets =====
function applyPreset(name) {
  const nightToggle = document.getElementById("night-toggle");
  const gradSel = document.getElementById("grad-theme");
  const rEl = document.getElementById("radius-slider");
  const rValEl = document.getElementById("radius-val");

  const setRad = (m) => {
    nearbyRadiusM = m;
    if (rEl) rEl.value = String(m);
    if (rValEl) rValEl.textContent = (m / 1000).toFixed(1) + " km";
    setRangeFill(rEl);
  };

  if (name === "daycrawl") {
    if (nightToggle) nightToggle.checked = false;
    document.body.classList.toggle("dark", false);
    setBasemap(false);
    if (gradSel) gradSel.value = "g1";
    applyGradTheme("g1");
    placeType = "cafe";
    setRad(1400);
    loopMode = true;
  }

  if (name === "nightout") {
    if (nightToggle) nightToggle.checked = true;
    document.body.classList.toggle("dark", true);
    setBasemap(true);
    if (gradSel) gradSel.value = "g3";
    applyGradTheme("g3");
    placeType = "night";
    setRad(2200);
    loopMode = true;
  }

  if (name === "cozy") {
    if (nightToggle) nightToggle.checked = false;
    document.body.classList.toggle("dark", false);
    setBasemap(false);
    if (gradSel) gradSel.value = "g2";
    applyGradTheme("g2");
    placeType = "cafe";
    setRad(900);
    loopMode = false;
  }

  if (name === "party") {
    if (nightToggle) nightToggle.checked = true;
    document.body.classList.toggle("dark", true);
    setBasemap(true);
    if (gradSel) gradSel.value = "g3";
    applyGradTheme("g3");
    placeType = "night";
    setRad(3000);
    loopMode = true;
  }

  if (name === "slowwalk") {
    if (nightToggle) nightToggle.checked = false;
    document.body.classList.toggle("dark", false);
    setBasemap(false);
    if (gradSel) gradSel.value = "g1";
    applyGradTheme("g1");
    placeType = "cafe";
    setRad(700);
    loopMode = false;
  }

  updateStartToggle();
  const loopBtn = document.getElementById("loop-toggle");
  if (loopBtn) loopBtn.textContent = loopMode ? "Loop: ON" : "Loop: OFF";
  refreshMapStyles();
  updateRadiusUI();
  renderMsg(`Preset applied: ${name}`);
}

// ===== Optimize current route =====
function optimizeCurrentRoute() {
  if (!lastOrder || !lastOrder.length) return;

  const before = routeLengthKm(lastOrder);

  let cand = twoOpt(lastOrder.slice());
  cand = saOrder(cand, 1200);

  const after = routeLengthKm(cand);
  const pct = before > 1e-9 ? ((before - after) / before) * 100 : 0;

  lastOrder = cand.slice();
  lastLabel = `Route (Optimized) • saved ${pct.toFixed(1)}%`;

  drawRoute(lastOrder);
  renderRoute(lastOrder, lastLabel);
  showToast(`Saved ${pct.toFixed(1)}%`);
}

// ===== Bind UI =====
function bindUI() {
  enableAlgos(false);
  updateStartToggle();

  function updateLoopToggle() {
    const b = document.getElementById("loop-toggle");
    if (!b) return;
    b.textContent = loopMode ? "Loop: ON" : "Loop: OFF";
    setOn("loop-toggle", loopMode);
  }
  updateLoopToggle();

  document.getElementById("loop-toggle")?.addEventListener("click", () => {
    loopMode = !loopMode;
    updateLoopToggle();

    if (lastOrder && lastOrder.length) {
      drawRoute(lastOrder);
      renderRoute(lastOrder, lastLabel);
      return;
    }
    renderMsg(loopMode ? "Loop enabled: will return to start." : "One-way: ends at last stop.");
  });

  document.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("button");
  if (!btn) return;

  // don't highlight "Remove" pills inside list
  if (btn.matches(".pill[data-del]")) return;

  selectBtn(btn);
});


  document.getElementById("start-toggle")?.addEventListener("click", () => {
    startMode = (startMode === "poi0") ? "user" : "poi0";
    updateStartToggle();
    updateRadiusUI();

    if (lastOrder && lastOrder.length) {
      drawRoute(lastOrder);
      renderRoute(lastOrder, lastLabel);
      return;
    }

    renderMsg(startMode === "user"
      ? "Start set to My Location (tap 'Use my location' to update it)."
      : "Start set to First stop."
    );
  });

  // Night mode (default gradient day=g1, night=g3 unless user changed)
  document.getElementById("night-toggle")?.addEventListener("change", (e) => {
  const on = !!e.target.checked;
  document.body.classList.toggle("dark", on);
  setBasemap(on);

  const gradSel = document.getElementById("grad-theme");
  if (on) {
    if (gradSel) gradSel.value = "g3";
    applyGradTheme("g3");
  } else {
    if (gradSel) gradSel.value = "g1";
    applyGradTheme("g1");
  }

  refreshMapStyles();
  setRangeFill(document.getElementById("radius-slider"));
});


  // Gradient theme picker
  const gradSel = document.getElementById("grad-theme");
  const savedGrad = (() => { try { return localStorage.getItem("gradTheme"); } catch { return null; } })();

  if (savedGrad && ["g1", "g2", "g3"].includes(savedGrad)) {
    if (gradSel) gradSel.value = savedGrad;
    applyGradTheme(savedGrad);
  } else {
    applyGradTheme("g1");
  }

  gradSel?.addEventListener("change", (e) => {
    userPickedGradient = true;
    applyGradTheme(e.target.value);
  });

  // Preset picker
  document.getElementById("preset-theme")?.addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v || v === "custom") return;
    applyPreset(v);
  });

  // Place type
  function setType(t) {
    placeType = t;
    setOn("type-cafe", t === "cafe");
    setOn("type-night", t === "night");
    renderMsg(`Mode: ${placeTypeLabel()}. Tap “Recommend nearby”.`);
  }
  document.getElementById("type-cafe")?.addEventListener("click", () => setType("cafe"));
  document.getElementById("type-night")?.addEventListener("click", () => setType("night"));
  setType("cafe");

  // Use my location
  document.getElementById("loc-btn")?.addEventListener("click", () => {
    if (!navigator.geolocation) return renderMsg("Geolocation not supported.");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        userLatLon = { lat, lon };

        if (userMarker) map.removeLayer(userMarker);

        const a = accentStyle();
        userMarker = L.circleMarker([lat, lon], {
          radius: 9,
          weight: 3,
          opacity: 1,
          fillOpacity: 1,
          color: a.color,
          fillColor: a.fillColor,
          className: "user-dot"
        }).addTo(map).bindPopup("You").openPopup();

        map.setView([lat, lon], 15);
        renderMsg(`Location set: ${lat.toFixed(5)}, ${lon.toFixed(5)}.`);
        updateRadiusUI();
      },
      (err) => renderMsg(`Location error: ${err.message}`)
    );
  });

  // Radius chip
  const chip = document.getElementById("radius-chip");
  const chipBtn = document.getElementById("radius-chip-btn");
  const rEl = document.getElementById("radius-slider");
  const rValEl = document.getElementById("radius-val");

  function setRadiusLabel(m) {
    if (!rValEl) return;
    rValEl.textContent = (m / 1000).toFixed(1) + " km";
  }

  nearbyRadiusM = Number(rEl?.value) || 1400;
  setRadiusLabel(nearbyRadiusM);
  setRangeFill(rEl);

  chipBtn?.addEventListener("click", () => {
    if (!hasNearbyAnchor()) return;
    chip?.classList.toggle("is-open");
  });

  let nearbyDebounce = null;
  rEl?.addEventListener("input", (e) => {
    nearbyRadiusM = Number(e.target.value) || 1400;
    setRadiusLabel(nearbyRadiusM);
    setRangeFill(rEl);

    clearTimeout(nearbyDebounce);
    nearbyDebounce = setTimeout(() => {
      const anchor = getAnchorLatLonForRecommendations();
      if (anchor) recommendNearby();
    }, 500);
  });

  document.getElementById("nearby-btn")?.addEventListener("click", recommendNearby);

  // Heatmap toggle
  document.getElementById("heatmap-toggle")?.addEventListener("click", () => {
    heatOn = !heatOn;
    setOn("heatmap-toggle", heatOn);
    buildHeatFromReco();
    showToast(heatOn ? "Heatmap ON" : "Heatmap OFF");
  });

  // Optimize
  document.getElementById("optimize-btn")?.addEventListener("click", optimizeCurrentRoute);

  // Clear
  document.getElementById("clear-btn")?.addEventListener("click", () => {
    currPois = [];
    poiLayer.clearLayers();
    recoLayer.clearLayers();
    heatLayer.clearLayers();
    clearRoute();
    lastOrder = null;
    lastLabel = "";
    updateRadiusUI();
    document.getElementById("optimize-btn")?.setAttribute("disabled", "true");
    renderMsg("Cleared. Add stops or tap “Recommend nearby”.");
  });

  // Search + autocomplete
  const qEl = document.getElementById("search-q");
  const resultsEl = document.getElementById("search-results");

  qEl?.addEventListener("input", async () => {
    const q = (qEl.value || "").trim();
    if (!resultsEl) return;

    resultsEl.innerHTML = "";
    if (q.length < 3) return;
    if (!userLatLon) return;

    const hits = await nominatimAutocomplete(q);

    hits.slice(0, 3).forEach(hit => {
      const div = document.createElement("div");
      div.className = "search-item";
      div.textContent = hit.display_name.split(",").slice(0, 3).join(", ");

      div.onclick = () => {
        const lat = Number(hit.lat);
        const lon = Number(hit.lon);
        const name = hit.display_name.split(",")[0];
        addPOI(name, lat, lon);

        qEl.value = "";
        resultsEl.innerHTML = "";
      };

      resultsEl.appendChild(div);
    });
  });

  document.getElementById("search-add-btn")?.addEventListener("click", async () => {
    const q = (qEl?.value || "").trim();
    if (!q) return renderMsg("Type a place first.");
    if (!userLatLon) return renderMsg("Tap “Use my location” first (needed for closest results).");

    const hits = await nominatimAutocomplete(q);
    if (!hits.length) return renderMsg("No results found. Try a more specific query.");

    const hit = hits[0];
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    const name = hit.display_name.split(",")[0];

    addPOI(name, lat, lon);
    qEl.value = "";
    resultsEl.innerHTML = "";
  });

  qEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("search-add-btn")?.click();
  });

  // Algorithms
  document.getElementById("algo-nn")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    const order = getBaseOrder();
    lastOrder = order.slice();
    lastLabel = "Route (NN)";
    drawRoute(lastOrder);
    renderRoute(lastOrder, lastLabel);
    document.getElementById("optimize-btn")?.removeAttribute("disabled");
  });

  document.getElementById("algo-2opt")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    const order = twoOpt(getBaseOrder().slice());
    lastOrder = order.slice();
    lastLabel = "Route (NN + 2-opt)";
    drawRoute(lastOrder);
    renderRoute(lastOrder, lastLabel);
    document.getElementById("optimize-btn")?.removeAttribute("disabled");
  });

  document.getElementById("algo-sa")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    const base = twoOpt(getBaseOrder().slice());
    const order = saOrder(base, 2500);
    lastOrder = order.slice();
    lastLabel = "Route (SA)";
    drawRoute(lastOrder);
    renderRoute(lastOrder, lastLabel);
    document.getElementById("optimize-btn")?.removeAttribute("disabled");
  });

  document.getElementById("algo-ga")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    const order = gaLite(40);
    lastOrder = order.slice();
    lastLabel = "Route (GA-lite)";
    drawRoute(lastOrder);
    renderRoute(lastOrder, lastLabel);
    document.getElementById("optimize-btn")?.removeAttribute("disabled");
  });

  updateRadiusUI();
}

window.addEventListener("DOMContentLoaded", () => {
  bindUI();
  renderMsg("Add stops or tap “Recommend nearby”.");
});
