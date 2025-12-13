const out = document.getElementById("out");

const map = L.map("map").setView([43.6532, -79.3832], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);

let currPois = [];
let currOrder = [];
let routeLine = null;

function setOutHTML(html) {
  out.innerHTML = html;
}

function setDisabled(id, v) {
  const el = document.getElementById(id);
  if (el) el.disabled = v;
}

function safe(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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
  currOrder = [];
}

function plotPois(pois) {
  poiLayer.clearLayers();
  clearRoute();

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

  pois.forEach(p => {
    L.marker([p.lat, p.lon]).addTo(poiLayer).bindPopup(p.name);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  });

  if (pois.length) {
    map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [20, 20] });
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = d => d * Math.PI / 180.0;

  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);

  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nnOrder(pois, startIdx = 0) {
  const n = pois.length;
  const rem = new Set([...Array(n).keys()].filter(i => i !== startIdx));
  const order = [startIdx];

  while (rem.size) {
    const last = order[order.length - 1];
    let best = null, bestD = Infinity;

    for (const j of rem) {
      const d = haversineKm(pois[last].lat, pois[last].lon, pois[j].lat, pois[j].lon);
      if (d < bestD) { bestD = d; best = j; }
    }

    order.push(best);
    rem.delete(best);
  }
  return order;
}

function routeLengthKm(order, pois) {
  let tot = 0;
  for (let i = 0; i < order.length; i++) {
    const a = pois[order[i]];
    const b = pois[order[(i + 1) % order.length]];
    tot += haversineKm(a.lat, a.lon, b.lat, b.lon);
  }
  return tot;
}

function drawRoute(order, pois) {
  const pts = order.map(i => [pois[i].lat, pois[i].lon]);
  pts.push([pois[order[0]].lat, pois[order[0]].lon]);

  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(pts).addTo(map);
}

function renderLoaded(n) {
  setOutHTML(`<div class="out-title">Loaded ${n} POIs. Generate a route when ready.</div>`);
}

function renderRoute(order, pois, km) {
  const items = order.map((idx, k) => {
    const p = pois[idx];
    const sub = `(${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})`;

    const bubble = `
      <li class="bubble">
        <div class="num">${k + 1}</div>
        <div class="name">${safe(p.name)}</div>
        <div class="hint">${sub}</div>
      </li>
    `;

    const arrow = (k < order.length - 1)
      ? `<div class="arrow"><span>↓</span></div>`
      : "";

    return bubble + arrow;
  }).join("");

  setOutHTML(`
    <div class="route-header">
      <div class="title">Route (NN)</div>
      <div class="meta">
        <div class="chip">Start: POI[0]</div>
        <div class="chip">Distance: ${km.toFixed(2)} km</div>
        <div class="chip">Stops: ${order.length}</div>
      </div>
    </div>
    <ol class="route-bubbles">
      ${items}
    </ol>
  `);
}

function renderMsg(msg) {
  setOutHTML(`<div class="out-title">${safe(msg)}</div>`);
}

function bindUI() {
  const locBtn = document.getElementById("loc-btn");
  if (locBtn) {
    locBtn.addEventListener("click", () => {
      if (!navigator.geolocation) return renderMsg("Geolocation not supported.");

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;

          if (userMarker) map.removeLayer(userMarker);
          userMarker = L.marker([lat, lon]).addTo(map).bindPopup("You").openPopup();
          map.setView([lat, lon], 15);

          renderMsg(`Location set: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
        },
        (err) => renderMsg(`Location error: ${err.message}`)
      );
    });
  }

  const loadBtn = document.getElementById("load-small-btn");
  if (loadBtn) {
    loadBtn.addEventListener("click", async () => {
      try {
        setDisabled("route-btn", true);
        renderMsg("Loading POI_small.csv ...");

        const text = await loadText("data/POI_small.csv");
        currPois = parseCsv(text);

        plotPois(currPois);
        setDisabled("route-btn", currPois.length < 2);

        renderLoaded(currPois.length);
      } catch (e) {
        renderMsg(`Error: ${e.message}`);
      }
    });
  }

  const routeBtn = document.getElementById("route-btn");
  if (routeBtn) {
    routeBtn.addEventListener("click", () => {
      if (currPois.length < 2) return;

      currOrder = nnOrder(currPois, 0);
      const km = routeLengthKm(currOrder, currPois);

      drawRoute(currOrder, currPois);
      renderRoute(currOrder, currPois, km);
    });
  }

  const clearBtn = document.getElementById("clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearRoute();
      renderMsg("Cleared route.");
    });
  }
}

bindUI();
renderMsg("Load POIs to begin.");
