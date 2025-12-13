const out = document.getElementById("out");

const map = L.map("map").setView([43.6532, -79.3832], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);

function log(s) { out.textContent = s; }

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // assumes header: name,lat,lon (or Name,Latitude,Longitude etc)
  const hdr = lines[0].split(",").map(x => x.trim().toLowerCase());
  const iName = hdr.indexOf("name");
  const iLat = hdr.indexOf("lat") >= 0 ? hdr.indexOf("lat") : hdr.indexOf("latitude");
  const iLon = hdr.indexOf("lon") >= 0 ? hdr.indexOf("lon") : hdr.indexOf("lng") >= 0 ? hdr.indexOf("lng") : hdr.indexOf("longitude");

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
  log(`Loaded ${pois.length} POIs.`);
}

document.getElementById("loc-btn").addEventListener("click", () => {
  if (!navigator.geolocation) return log("Geolocation not supported.");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
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
    log("Loading docs/data/POI_small.csv ...");
    const text = await loadCsv("data/POI_small.csv");
    const pois = parseCsv(text);
    plotPois(pois);
  } catch (e) {
    log(`Error: ${e.message}`);
  }
});

