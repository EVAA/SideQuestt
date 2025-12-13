const out = document.getElementById("out");

const map = L.map("map").setView([43.6532, -79.3832], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

let userMarker = null;
let poiLayer = L.layerGroup().addTo(map);

function log(s) { out.textContent = s; }

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

document.getElementById("demo-btn").addEventListener("click", () => {
  poiLayer.clearLayers();
  const demo = [
    { name: "Union Station", lat: 43.6453, lon: -79.3807 },
    { name: "Kensington Market", lat: 43.6543, lon: -79.4005 },
    { name: "Distillery District", lat: 43.6503, lon: -79.3596 }
  ];
  demo.forEach(p => L.marker([p.lat, p.lon]).addTo(poiLayer).bindPopup(p.name));
  log(`Loaded ${demo.length} demo POIs.`);
});

