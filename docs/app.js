const out = document.getElementById("out");

const map = L.map("map").setView([43.6532, -79.3832], 13);
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  {
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }
).addTo(map);


let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);
let searchLayer = L.layerGroup().addTo(map);

let currPois = [];
let routeLine = null;

let startMode = "poi0"; // "poi0" | "user"
let userLatLon = null;

function setOutHTML(html) { out.innerHTML = html; }
function safe(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function setDisabled(id, v) { const el = document.getElementById(id); if (el) el.disabled = v; }
function enableAlgos(ok) {
  ["algo-nn","algo-2opt","algo-sa","algo-ga"].forEach(id => setDisabled(id, !ok));
}

function renderMsg(msg) { setOutHTML(`<div class="out-title">${safe(msg)}</div>`); }

function renderLoaded(n) { setOutHTML(`<div class="out-title">Loaded ${n} POIs. Pick an algorithm.</div>`); }

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const hdr = lines[0].split(",").map(x => x.trim().toLowerCase());
  const iName = hdr.indexOf("name");
  const iLat = hdr.indexOf("lat") >= 0 ? hdr.indexOf("lat") : hdr.indexOf("latitude");
  const iLon =
    hdr.indexOf("lon") >= 0 ? hdr.indexOf("lon")
    : hdr.indexOf("lng") >= 0 ? hdr.indexOf("lng")
    : hdr.indexOf("longitude");

  if (iName < 0 || iLat < 0 || iLon < 0) {
    throw new Error(`CSV header must include name, lat/latitude, lon/longitude (got: ${lines[0]})`);
  }

  const pois = [];
  for (let k = 1; k < lines.length; k++) {
    const row = lines[k].split(",");
    if (row.length < Math.max(iName, iLat, iLon) + 1) continue;

    const name = row[iName].trim();
    const lat = Number(row[iLat]);
    const lon = Number(row[iLon]);

    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    pois.push({ name, lat, lon });
  }
  return pois;
}

async function loadText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

function clearRoute() {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = null;
}

function plotPois(pois) {
  poiLayer.clearLayers();
  clearRoute();

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

  pois.forEach(p => {
    L.circleMarker([p.lat, p.lon], {
  radius: 7,
  weight: 2,
  opacity: 0.9,
  fillOpacity: 0.9
}).addTo(poiLayer).bindPopup(p.name);

    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  });

  if (pois.length) map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20] });
}

/* ===== Distance ===== */

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

function distFromStartTo(i) {
  if (startMode === "poi0" || !userLatLon) return distPois(0, i);
  return haversineKm(userLatLon.lat, userLatLon.lon, currPois[i].lat, currPois[i].lon);
}

function routeLengthKm(order) {
  let tot = 0;
  for (let i = 0; i < order.length - 1; i++) tot += distPois(order[i], order[i+1]);
  // close the loop back to start POI[0] regardless of start mode (simple for now)
  tot += distPois(order[order.length - 1], order[0]);
  return tot;
}

/* ===== Algorithms ===== */

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
  // pick first stop closest to user, then NN over remaining
  const n = currPois.length;
  let first = 0, best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = distFromStartTo(i);
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

  let best = twoOpt((startMode === "user" && userLatLon) ? nnOrderFromUser() : nnOrder(0));
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

/* ===== Draw + output ===== */

function drawRoute(order) {
  const pts = order.map(i => [currPois[i].lat, currPois[i].lon]);
  pts.push([currPois[order[0]].lat, currPois[order[0]].lon]);

  if (routeLine) map.removeLayer(routeLine);

  routeLine = L.polyline(pts, {
    weight: 7,
    opacity: 0.95,
    lineJoin: "round"
  }).addTo(map);
}


function renderRoute(order, label) {
  const km = routeLengthKm(order);

  const items = order.map((idx, k) => {
    const p = currPois[idx];
    const sub = `(${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})`;

    const bubble = `
      <li class="bubble">
        <div class="num">${k + 1}</div>
        <div class="name">${safe(p.name)}</div>
        <div class="hint">${sub}</div>
      </li>
    `;

    const arrow = (k < order.length - 1) ? `<div class="arrow"><span>↓</span></div>` : "";
    return bubble + arrow;
  }).join("");

  const startLabel = (startMode === "user" && userLatLon) ? "My Location" : "POI[0]";

  setOutHTML(`
    <div class="route-header">
      <div class="title">${safe(label)}</div>
      <div class="meta">
        <div class="chip">Start: ${safe(startLabel)}</div>
        <div class="chip">Distance: ${km.toFixed(2)} km</div>
        <div class="chip">Stops: ${order.length}</div>
      </div>
    </div>
    <ol class="route-bubbles">${items}</ol>
  `);
}

/* ===== Search add ===== */

async function nominatimSearch(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const js = await res.json();
  if (!js.length) return null;
  return js[0];
}

function addPOI(name, lat, lon) {
  currPois.push({ name, lat, lon });
  plotPois(currPois);
  enableAlgos(currPois.length >= 2);
  renderMsg(`Added: ${name}`);
}

/* ===== Start toggle ===== */

function updateStartToggle() {
  const btn = document.getElementById("start-toggle");
  if (!btn) return;
  btn.textContent = startMode === "poi0" ? "Start: POI[0]" : "Start: My Location";
}

function getBaseOrder() {
  if (startMode === "user" && userLatLon) return nnOrderFromUser();
  return nnOrder(0);
}

/* ===== Bind UI ===== */

function bindUI() {
  enableAlgos(false);
  updateStartToggle();

  document.getElementById("start-toggle").addEventListener("click", () => {
    startMode = (startMode === "poi0") ? "user" : "poi0";
    updateStartToggle();
    renderMsg(startMode === "user"
      ? "Start set to My Location (tap 'Use my location' to update it)."
      : "Start set to POI[0]."
    );
  });

  document.getElementById("loc-btn").addEventListener("click", () => {
    if (!navigator.geolocation) return renderMsg("Geolocation not supported.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        userLatLon = { lat, lon };

        if (userMarker) map.removeLayer(userMarker);
       userMarker = L.circleMarker([lat, lon], {
  radius: 9,
  weight: 3,
  opacity: 1,
  fillOpacity: 1
}).addTo(map).bindPopup("You").openPopup();

        map.setView([lat, lon], 15);

        renderMsg(`Location set: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
      },
      (err) => renderMsg(`Location error: ${err.message}`)
    );
  });

  async function loadDataset(path, label) {
    try {
      enableAlgos(false);
      renderMsg(`Loading ${label} ...`);
      const text = await loadText(path);
      currPois = parseCsv(text);
      plotPois(currPois);
      enableAlgos(currPois.length >= 2);
      renderLoaded(currPois.length);
    } catch (e) {
      renderMsg(`Error: ${e.message}`);
    }
  }

  document.getElementById("load-small-btn").addEventListener("click", () => loadDataset("data/POI_small.csv", "POI_small.csv"));
  document.getElementById("load-medium-btn").addEventListener("click", () => loadDataset("data/POI_medium.csv", "POI_medium.csv"));
  document.getElementById("load-large-btn").addEventListener("click", () => loadDataset("data/POI_large.csv", "POI_large.csv"));

  document.getElementById("algo-nn").addEventListener("click", () => {
    if (currPois.length < 2) return;
    const order = getBaseOrder();
    drawRoute(order);
    renderRoute(order, "Route (NN)");
  });

  document.getElementById("algo-2opt").addEventListener("click", () => {
    if (currPois.length < 2) return;
    const order = twoOpt(getBaseOrder());
    drawRoute(order);
    renderRoute(order, "Route (NN + 2-opt)");
  });

  document.getElementById("algo-sa").addEventListener("click", () => {
    if (currPois.length < 2) return;
    const base = twoOpt(getBaseOrder());
    const order = saOrder(base, 2500);
    drawRoute(order);
    renderRoute(order, "Route (SA)");
  });

  document.getElementById("algo-ga").addEventListener("click", () => {
    if (currPois.length < 2) return;
    const order = gaLite(40);
    drawRoute(order);
    renderRoute(order, "Route (GA-lite)");
  });

  document.getElementById("clear-btn").addEventListener("click", () => {
    clearRoute();
    renderMsg("Cleared route.");
  });

  const qEl = document.getElementById("search-q");
  document.getElementById("search-add-btn").addEventListener("click", async () => {
    const q = (qEl.value || "").trim();
    if (!q) return renderMsg("Type a place or address first.");

    try {
      renderMsg(`Searching: ${q} ...`);
      const hit = await nominatimSearch(q);
      if (!hit) return renderMsg("No results found. Try a more specific query.");

      const name = hit.display_name.split(",").slice(0, 2).join(", ");
      const lat = Number(hit.lat);
      const lon = Number(hit.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return renderMsg("Bad search result. Try again.");

      searchLayer.clearLayers();
      L.marker([lat, lon]).addTo(searchLayer).bindPopup(`Added: ${name}`).openPopup();
      map.setView([lat, lon], 15);

      addPOI(name, lat, lon);
      qEl.value = "";
    } catch (e) {
      renderMsg(`Search error: ${e.message}`);
    }
  });

  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("search-add-btn").click();
  });
}

bindUI();
renderMsg("Load POIs to begin.");



