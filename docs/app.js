const out = document.getElementById("out");

const map = L.map("map").setView([43.6532, -79.3832], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);

let currPois = [];
let routeLine = null;

function log(s) { out.textContent = s; }

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

async function loadCsv(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

function plotPois(pois) {
  poiLayer.clearLayers();

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

  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function nnOrder(pois, startIdx=0) {
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

document.getElementById("loc-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return log("Geolocation not supported.");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.marker([lat, lon]).addTo(map).bindPopup("You").openPopup();
      map.setView([lat, lon], 15);

      log(`Location: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    },
    (err) => log(`Location error: ${err.message}`)
  );
});

document.getElementById("load-small-btn").addEventListener("click", async () => {
  try {
    log("Loading POI_small.csv ...");

    const text = await loadCsv("data/POI_small.csv");
    const pois = parseCsv(text);

    currPois = pois;
    plotPois(currPois);

    document.getElementById("route-btn").disabled = (currPois.length < 2);
    log(`Loaded ${currPois.length} POIs.`);
  } catch (e) {
    log(`Error: ${e.message}`);
  }
});

document.getElementById("route-btn").addEventListener("click", () => {
  if (currPois.length < 2) return;

  const order = nnOrder(currPois, 0);
  const km = routeLengthKm(order, currPois);
  drawRoute(order, currPois);

  const lines = [];
  lines.push(`Route (NN), start = POI[0], total: ${km.toFixed(2)} km`);
  lines.push("");
  order.forEach((idx, k) => lines.push(`${k+1}. ${currPois[idx].name}`));
  log(lines.join("\n"));
});

