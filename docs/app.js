console.log("app.js loaded");
const out = document.getElementById("out");


// Toronto bounding box (SW, NE)
const TORONTO_BOUNDS = {
  minLat: 43.5810,
  maxLat: 43.8555,
  minLon: -79.6393,
  maxLon: -79.1169
};

// ===== Map (switchable basemap) =====
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

// Loop mode: true = return to start, false = end at last POI
let loopMode = true;

function getAnchorLatLonForRecommendations() {
  // If start mode is POI[0], recommend near POI[0] (if it exists)
  if (startMode === "poi0" && currPois.length >= 1) {
    return { lat: currPois[0].lat, lon: currPois[0].lon };
  }
  // Otherwise recommend near user location
  return userLatLon;
}


setBasemap(false);

// ===== Layers / state =====
let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);
let recoLayer = L.layerGroup().addTo(map);
let searchLayer = L.layerGroup().addTo(map);

let currPois = [];
let routeLine = null;

let startMode = "poi0"; // "poi0" | "user"
let userLatLon = null;

let placeType = "cafe"; // "cafe" | "night"

// ===== UI helpers =====
function setOutHTML(html) { out.innerHTML = html; }
function safe(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function renderMsg(msg) { setOutHTML(`<div class="out-title">${safe(msg)}</div>`); }

function setOn(id, on){
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("is-on", !!on);
}
function setAlgoActive(id){
  ["algo-nn","algo-2opt","algo-sa","algo-ga"].forEach(x => setOn(x, x === id));
}
function updateStartToggle() {
  const btn = document.getElementById("start-toggle");
  if (!btn) return;
  btn.textContent = (startMode === "poi0") ? "Start: POI[0]" : "Start: My Location";
}
function enableAlgos(ok) {
  ["algo-nn","algo-2opt","algo-sa","algo-ga"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !ok;
  });
}

function overpassAmenityFilter() {
  // Bars + clubs
  if (placeType === "night") {
    // include bar, pub, nightclub
    return `["amenity"~"bar|pub|nightclub"]`;
  }
  // Cafés
  return `["amenity"="cafe"]`;
}

function placeTypeLabel() {
  return (placeType === "night") ? "Bars + Clubs" : "Cafés";
}

async function nominatimAutocomplete(q) {
  if (!userLatLon) return [];

  const url =
    `https://nominatim.openstreetmap.org/search?` +
    `format=json&limit=5&addressdetails=1` +
    `&viewbox=${TORONTO_BOUNDS.minLon},${TORONTO_BOUNDS.maxLat},${TORONTO_BOUNDS.maxLon},${TORONTO_BOUNDS.minLat}` +
    `&bounded=1` +
    `&lat=${userLatLon.lat}&lon=${userLatLon.lon}` +
    `&q=${encodeURIComponent(q)}`;

  const res = await fetch(url, {
    headers: { "Accept": "application/json" }
  });

  if (!res.ok) return [];
  return await res.json();
}

function showToast(msg = "Added to route") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 900);
}



// ===== Distances =====
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = d => d * Math.PI / 180.0;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
  if (!order.length) return 0;

  // Start = user
  if (startMode === "user" && userLatLon) {
    let tot = 0;
    tot += haversineKm(userLatLon.lat, userLatLon.lon, currPois[order[0]].lat, currPois[order[0]].lon);

    for (let i = 0; i < order.length - 1; i++) {
      tot += distPois(order[i], order[i + 1]);
    }

    if (loopMode) {
      tot += haversineKm(
        userLatLon.lat, userLatLon.lon,
        currPois[order[order.length - 1]].lat, currPois[order[order.length - 1]].lon
      );
    }
    return tot;
  }

  // Start = POI[0]
  let tot = 0;
  for (let i = 0; i < order.length - 1; i++) tot += distPois(order[i], order[i + 1]);
  if (loopMode) tot += distPois(order[order.length - 1], order[0]);
  return tot;
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
        const after  = distPois(a, c) + distPois(b, d);

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

// ===== Draw + Output =====
function clearRoute() {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = null;
}

function plotPois() {
  poiLayer.clearLayers();
  clearRoute();

  currPois.forEach((p) => {
    L.circleMarker([p.lat, p.lon], {
      radius: 7,
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0.9
    }).addTo(poiLayer).bindPopup(safe(p.name));
  });

  enableAlgos(currPois.length >= 2);
}

function drawRoute(order) {
  if (!order.length) return;

  let pts = [];

  if (startMode === "user" && userLatLon) {
    pts.push([userLatLon.lat, userLatLon.lon]);
    pts.push(...order.map(i => [currPois[i].lat, currPois[i].lon]));
    if (loopMode) pts.push([userLatLon.lat, userLatLon.lon]);
  } else {
    pts = order.map(i => [currPois[i].lat, currPois[i].lon]);
    if (loopMode) pts.push([currPois[order[0]].lat, currPois[order[0]].lon]);
  }

  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(pts, { weight: 7, opacity: 0.95, lineJoin: "round" }).addTo(map);
}

function renderRoute(order, label) {
  const km = routeLengthKm(order);
  const startLabel = (startMode === "user" && userLatLon) ? "My Location" : "POI[0]";

  const items = [];

  if (startMode === "user" && userLatLon) {
    items.push(`
      <li class="bubble">
        <div class="num">1</div>
        <div>
          <div class="name">You</div>
          <div class="hint">(${userLatLon.lat.toFixed(4)}, ${userLatLon.lon.toFixed(4)})</div>
        </div>
        <div class="row-actions"></div>
      </li>
    `);
  }

  order.forEach((idx, k) => {
    const p = currPois[idx];
    const num = (startMode === "user" && userLatLon) ? (k + 2) : (k + 1);

    items.push(`
      <li class="bubble">
        <div class="num">${num}</div>
        <div>
          <div class="name">${safe(p.name)}</div>
          <div class="hint">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
        </div>
        <div class="row-actions">
          <button class="pill" data-del="${idx}" type="button">Remove</button>
        </div>
      </li>
    `);
  });

  setOutHTML(`
    <div class="route-header">
      <div class="title">${safe(label)}</div>
      <div class="meta">
        <div class="chip">Mode: ${safe(placeTypeLabel())}</div>
        <div class="chip">Start: ${safe(startLabel)}</div>
        <div class="chip">Distance: ${km.toFixed(2)} km</div>
        <div class="chip">Stops: ${(startMode === "user" && userLatLon) ? (order.length + 1) : order.length}</div>
      </div>
    </div>
    <ol class="route-bubbles">${items.join("")}</ol>
  `);

  // Remove handlers (map index -> actual POI idx)
  document.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-del"));
      if (!Number.isFinite(idx)) return;
      currPois.splice(idx, 1);
      plotPois();
      renderMsg("Removed stop. Re-run an algorithm.");
      setAlgoActive(""); // clear highlight
    });
  });
}

function addPOI(name, lat, lon) {
  currPois.push({ name, lat, lon });
  plotPois();
  map.setView([lat, lon], 15);
  renderMsg(`Added: ${name}.`);
}

// ===== Nominatim search (single result) =====
async function nominatimSearch(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const js = await res.json();
  if (!js.length) return null;
  return js[0];
}

// ===== Overpass recommend nearby =====
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

function addRecoMarker(p) {
  const name = p.name || "Place";
  const lat = p.lat, lon = p.lon;

  const m = L.circleMarker([lat, lon], {
    radius: 7,
    weight: 2,
    opacity: 0.95,
    fillOpacity: 0.95
  }).addTo(recoLayer);

  m.bindPopup(`
    <b>${safe(name)}</b><br/>
    <button id="add-${p._id}" type="button">Add stop</button>
  `);

  m.on("popupopen", () => {
    const btn = document.getElementById(`add-${p._id}`);
    if (!btn) return;
    btn.onclick = () => {
      addPOI(name, lat, lon);
      showToast("Added to route");
      map.closePopup();
    };
  });
}

function scoreReco(el) {
  // “Popular” proxy: prefer places with a name + more tags
  // (True popularity/ratings require Google/Foursquare APIs.)
  const tags = el.tags || {};
  const named = tags.name ? 1 : 0;
  const tagCount = Object.keys(tags).length;
  return named * 100 + tagCount;
}

async function recommendNearby() {
  const anchor = getAnchorLatLonForRecommendations();
  if (!anchor) return renderMsg("Tap “Use my location” or add a first stop (POI[0]) first.");

  const radiusM = 1400;
  const f = overpassAmenityFilter();

  renderMsg(`Finding nearby ${placeTypeLabel()}…`);
  recoLayer.clearLayers();

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
        name: el.tags?.name || "Place"
      });
    }

    const top = pts.slice(0, 40);
    top.forEach(addRecoMarker);

    const anchorLabel = (startMode === "poi0" && currPois.length) ? "POI[0]" : "My Location";

    setOutHTML(`
      <div class="route-header">
        <div class="title">Recommended nearby • ${safe(placeTypeLabel())}</div>
        <div class="meta">
          <div class="chip">Near: ${safe(anchorLabel)}</div>
          <div class="chip">Shown: ${top.length}</div>
          <div class="chip">Radius: ${(radiusM/1000).toFixed(1)} km</div>
          <div class="chip">Tap marker → Add</div>
        </div>
      </div>
    `);

    const bounds = L.latLngBounds(top.map(p => [p.lat, p.lon]));
    map.fitBounds(bounds, { padding: [20, 20] });

  } catch (e) {
    renderMsg(`Nearby search failed. Try again.`);
  }
}



  const top = pts.slice(0, 40);
  if (!top.length) return renderMsg(`No nearby ${placeTypeLabel()} found.`);

  top.forEach(addRecoMarker);

  setOutHTML(`
    <div class="route-header">
      <div class="title">Recommended nearby • ${safe(placeTypeLabel())}</div>
      <div class="meta">
        <div class="chip">Shown: ${top.length}</div>
        <div class="chip">Radius: ${(radiusM/1000).toFixed(1)} km</div>
        <div class="chip">Tap marker → Add</div>
      </div>
    </div>
    <div class="out-title">Tip: Add a few stops, then run NN / 2-opt / SA.</div>
  `);

  const bounds = L.latLngBounds(top.map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [20, 20] });


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

  // If a route is already drawn, re-draw it with the current active algo
  renderMsg(loopMode ? "Loop enabled: will return to start." : "One-way: ends at last stop.");
});


  // start mode
  document.getElementById("start-toggle")?.addEventListener("click", () => {
    startMode = (startMode === "poi0") ? "user" : "poi0";
    updateStartToggle();
    renderMsg(startMode === "user"
      ? "Start set to My Location (tap 'Use my location' to update it)."
      : "Start set to POI[0]."
    );
  });

  // night mode
  document.getElementById("night-toggle")?.addEventListener("change", (e) => {
    const on = !!e.target.checked;
    document.body.classList.toggle("dark", on);
    setBasemap(on);
  });

  // type toggle (no gradient until selected)
  function setType(t){
    placeType = t;
    setOn("type-cafe", t === "cafe");
    setOn("type-night", t === "night");
    renderMsg(`Mode: ${placeTypeLabel()}. Tap “Recommend nearby”.`);
  }
  document.getElementById("type-cafe")?.addEventListener("click", () => setType("cafe"));
  document.getElementById("type-night")?.addEventListener("click", () => setType("night"));
  // default mode, not highlighted:
  placeType = "cafe";

  // location
  document.getElementById("loc-btn")?.addEventListener("click", () => {
    if (!navigator.geolocation) return renderMsg("Geolocation not supported.");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        userLatLon = { lat, lon };

        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.circleMarker([lat, lon], {
          radius: 9, weight: 3, opacity: 1, fillOpacity: 1
        }).addTo(map).bindPopup("You").openPopup();

        map.setView([lat, lon], 15);
        renderMsg(`Location set: ${lat.toFixed(5)}, ${lon.toFixed(5)}.`);
      },
      (err) => renderMsg(`Location error: ${err.message}`)
    );
  });

  // recommend nearby
  document.getElementById("nearby-btn")?.addEventListener("click", recommendNearby);

  // clear everything
  document.getElementById("clear-btn")?.addEventListener("click", () => {
    currPois = [];
    plotPois();
    recoLayer.clearLayers();
    searchLayer.clearLayers();
    clearRoute();
    setAlgoActive("");
    renderMsg("Cleared. Add stops or tap “Recommend nearby”.");
  });

  // search + add
  // search + autocomplete (Toronto-bounded + proximity)
const qEl = document.getElementById("search-q");
const resultsEl = document.getElementById("search-results");

qEl?.addEventListener("input", async () => {
  const q = (qEl.value || "").trim();
  if (!resultsEl) return;

  resultsEl.innerHTML = "";
  if (q.length < 3) return;
  if (!userLatLon) return; // requires location for proximity sorting

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
      map.setView([lat, lon], 15);

      qEl.value = "";
      resultsEl.innerHTML = "";
    };

    resultsEl.appendChild(div);
  });
});

// “Add” button uses the first suggestion (or falls back to 1-shot search if you keep it)
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
  map.setView([lat, lon], 15);

  if (qEl) qEl.value = "";
  if (resultsEl) resultsEl.innerHTML = "";
});

// hide dropdown on Enter
qEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("search-add-btn")?.click();
});



  qEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("search-add-btn")?.click();
  });

  // algos
  document.getElementById("algo-nn")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    setAlgoActive("algo-nn");
    const order = getBaseOrder();
    drawRoute(order);
    renderRoute(order, "Route (NN)");
  });

  document.getElementById("algo-2opt")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    setAlgoActive("algo-2opt");
    const order = twoOpt(getBaseOrder().slice());
    drawRoute(order);
    renderRoute(order, "Route (NN + 2-opt)");
  });

  document.getElementById("algo-sa")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    setAlgoActive("algo-sa");
    const base = twoOpt(getBaseOrder().slice());
    const order = saOrder(base, 2500);
    drawRoute(order);
    renderRoute(order, "Route (SA)");
  });

  document.getElementById("algo-ga")?.addEventListener("click", () => {
    if (currPois.length < 2) return;
    setAlgoActive("algo-ga");
    const order = gaLite(40);
    drawRoute(order);
    renderRoute(order, "Route (GA-lite)");
  });
}

window.addEventListener("DOMContentLoaded", () => {
  bindUI();
  renderMsg("Add stops or tap “Recommend nearby”.");
});

