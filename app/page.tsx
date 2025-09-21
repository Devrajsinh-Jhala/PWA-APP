"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type PlaceType = "police" | "fire_station" | "hospital";
type Mode = "DRIVING" | "WALKING";

type Candidate = {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  address?: string;
  etaSec?: number;
  etaText?: string;
  distanceM?: number;
  distanceText?: string;
};

const OSRM = "https://router.project-osrm.org"; // free demo for light use
const GEOAPIFY = "https://api.geoapify.com/v2/places";
const GEOAPIFY_KEY = process.env.NEXT_PUBLIC_GEOAPIFY_KEY!;

declare global {
  interface Window {
    deferredPrompt?: any;
  }
}

export default function EmergencyPage() {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [type, setType] = useState<PlaceType>("police");
  const [mode, setMode] = useState<Mode>("DRIVING");
  const [loading, setLoading] = useState(false);
  const [installable, setInstallable] = useState(false);
  const [list, setList] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);

  const meMarker = useRef<maplibregl.Marker | null>(null);
  const placeMarkers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const routeSourceId = "route-line";

  // PWA install
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      window.deferredPrompt = e;
      setInstallable(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  const doInstall = async () => {
    const p = window.deferredPrompt;
    if (!p) return;
    await p.prompt();
    await p.userChoice;
    setInstallable(false);
  };

  // Map init
  useEffect(() => {
    if (map.current || !mapDiv.current) return;
    const m = new maplibregl.Map({
      container: mapDiv.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          } as any,
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      } as any,
      center: [77.209, 28.6139],
      zoom: 12,
    });
    m.addControl(new maplibregl.NavigationControl(), "top-right");
    map.current = m;

    const onResize = () => m.resize();
    window.addEventListener("resize", onResize);
    const tick = setInterval(onResize, 2000);
    locateMe();

    return () => {
      window.removeEventListener("resize", onResize);
      clearInterval(tick);
      m.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize after UI changes so markers never “stick”
  useEffect(() => {
    setTimeout(() => map.current?.resize(), 60);
  }, [sheetOpen, list.length]);

  // Helpers
  const secToText = (s: number) => {
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60),
      mm = m % 60;
    return `${h}h ${mm}m`;
  };
  const mToText = (m: number) =>
    m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  const title = useMemo(() => `Closest ${type.replace("_", " ")}`, [type]);

  function recenter() {
    if (!map.current || !me) return;
    map.current.setCenter([me.lng, me.lat]);
    map.current.setZoom(15);
    map.current.resize();
  }

  function setMeMarker() {
    if (!map.current || !me) return;
    if (!meMarker.current) {
      meMarker.current = new maplibregl.Marker({ color: "#0ea5e9" })
        .setLngLat([me.lng, me.lat])
        .addTo(map.current);
    } else meMarker.current.setLngLat([me.lng, me.lat]);
  }

  function clearOverlays() {
    // markers
    placeMarkers.current.forEach((mk) => mk.remove());
    placeMarkers.current.clear();
    // route
    if (map.current?.getLayer(routeSourceId))
      map.current.removeLayer(routeSourceId);
    if (map.current?.getSource(routeSourceId))
      map.current.removeSource(routeSourceId);
    setSelected(null);
  }

  function locateMe() {
    if (!map.current) return;
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMe(loc);
        map.current!.setCenter([loc.lng, loc.lat]);
        map.current!.setZoom(15);
        map.current!.resize();
        setMeMarker();
        setLoading(false);
      },
      (err) => {
        console.warn(err);
        setLoading(false);
        alert("Enable location for nearby search.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // Geoapify categories
  const categoryFor = (t: PlaceType) =>
    t === "police"
      ? "service.police"
      : t === "fire_station"
      ? "service.fire_station"
      : "healthcare.hospital";

  // Places via Geoapify with expanding radius
  async function geoapifyPlaces(
    center: { lat: number; lng: number },
    t: PlaceType
  ) {
    const cat = categoryFor(t);
    const radii = [5000, 10000, 20000];
    let all: Candidate[] = [];
    for (const r of radii) {
      const url = `${GEOAPIFY}?categories=${encodeURIComponent(
        cat
      )}&filter=circle:${center.lng},${center.lat},${r}&bias=proximity:${
        center.lng
      },${center.lat}&limit=50&apiKey=${GEOAPIFY_KEY}`;
      const res = await fetch(url, { cache: "no-store" }); // ← avoid HTTP caching
      if (!res.ok) throw new Error(`Geoapify failed: ${res.status}`);
      const json = await res.json();
      const items: Candidate[] = (json.features || []).map((f: any) => ({
        id:
          f.properties.place_id ||
          `${f.properties.osm_type || "p"}:${
            f.properties.osm_id || Math.random()
          }`,
        name:
          f.properties.name ||
          (t === "police"
            ? "Police Station"
            : t === "fire_station"
            ? "Fire Station"
            : "Hospital"),
        location: {
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
        },
        address:
          f.properties.address_line1 || f.properties.formatted || undefined,
      }));
      all = dedup([...all, ...items]);
      if (all.length >= 5) break;
    }
    return all;
  }

  // Dedup by normalized name + ~100m proximity
  function dedup(cands: Candidate[]) {
    const key = (c: Candidate) =>
      `${(c.name || "").toLowerCase().replace(/\s+/g, " ").trim()}|${Math.round(
        c.location.lat * 1000
      )}|${Math.round(c.location.lng * 1000)}`;
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of cands) {
      const k = key(c);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    }
    return out;
  }

  // ETA ranking via OSRM matrix
  async function osrmRank(
    origin: { lat: number; lng: number },
    pts: Candidate[],
    m: Mode
  ) {
    if (!pts.length) return [];
    const prof = m === "WALKING" ? "foot" : "driving";
    const coords = [
      [origin.lng, origin.lat],
      ...pts.map((p) => [p.location.lng, p.location.lat]),
    ]
      .map(([lon, lat]) => `${lon},${lat}`)
      .join(";");
    const url = `${OSRM}/table/v1/${prof}/${coords}?sources=0&annotations=duration,distance`;
    const res = await fetch(url, { cache: "no-store" }); // ← avoid caching
    if (!res.ok) throw new Error("OSRM matrix failed");
    const json = await res.json();
    const dur = (json.durations?.[0] || []).slice(1);
    const dist = (json.distances?.[0] || []).slice(1);
    return pts
      .map((p, i) => ({
        ...p,
        etaSec: Number.isFinite(dur[i]) ? dur[i] : undefined,
        distanceM: Number.isFinite(dist[i]) ? dist[i] : undefined,
        etaText: Number.isFinite(dur[i]) ? secToText(dur[i]) : undefined,
        distanceText: Number.isFinite(dist[i]) ? mToText(dist[i]) : undefined,
      }))
      .filter((p) => p.etaSec != null)
      .sort((a, b) => a.etaSec! - b.etaSec!);
  }

  async function findNearby() {
    if (!map.current || !me) {
      alert("Location unavailable");
      return;
    }
    setLoading(true);
    clearOverlays();
    try {
      const places = await geoapifyPlaces(me, type);
      if (!places.length) {
        setList([]);
        setLoading(false);
        alert("No nearby places found.");
        return;
      }
      const ranked = await osrmRank(me, places, mode);
      const top = ranked.slice(0, 8);
      setList(top);
      dropPlaceMarkers(top);
      setTimeout(() => map.current?.resize(), 40);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  function dropPlaceMarkers(items: Candidate[]) {
    if (!map.current) return;
    // clear previous markers
    placeMarkers.current.forEach((mk) => mk.remove());
    placeMarkers.current.clear();

    items.forEach((p) => {
      const color =
        type === "hospital"
          ? "#16a34a"
          : type === "fire_station"
          ? "#ef4444"
          : "#1f2937";
      const mk = new maplibregl.Marker({ color })
        .setLngLat([p.location.lng, p.location.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 16 }).setHTML(
            `<b>${p.name}</b><br/>${p.etaText ?? ""} ${
              p.distanceText ? "• " + p.distanceText : ""
            }`
          )
        )
        .addTo(map.current!);
      mk.getElement().style.cursor = "pointer";
      mk.getElement().addEventListener("click", () => drawRoute(p));
      placeMarkers.current.set(p.id, mk);
    });
  }

  async function drawRoute(p: Candidate) {
    if (!map.current || !me) return;
    setSelected(p.id);
    const prof = mode === "WALKING" ? "foot" : "driving";
    const url = `${OSRM}/route/v1/${prof}/${me.lng},${me.lat};${p.location.lng},${p.location.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { cache: "no-store" }); // ← avoid caching
    if (!res.ok) {
      alert("Could not get route");
      return;
    }
    const json = await res.json();
    const route = json.routes?.[0];
    if (!route?.geometry) return;

    if (!map.current.getSource(routeSourceId)) {
      map.current.addSource(routeSourceId, {
        type: "geojson",
        data: { type: "Feature", geometry: route.geometry } as any,
      } as any);
      map.current.addLayer({
        id: routeSourceId,
        type: "line",
        source: routeSourceId,
        paint: {
          "line-color": "#0ea5e9",
          "line-width": 6,
          "line-opacity": 0.92,
        },
      });
    } else {
      (
        map.current.getSource(routeSourceId) as maplibregl.GeoJSONSource
      ).setData({ type: "Feature", geometry: route.geometry } as any);
    }

    // fit bounds
    const [minX, minY, maxX, maxY] = bboxFromGeoJSON(route.geometry);
    map.current.fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding: 44, linear: true }
    );
  }

  function bboxFromGeoJSON(geom: any): [number, number, number, number] {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const push = (c: number[]) => {
      minX = Math.min(minX, c[0]);
      minY = Math.min(minY, c[1]);
      maxX = Math.max(maxX, c[0]);
      maxY = Math.max(maxY, c[1]);
    };
    const walk = (g: any) => {
      if (g.type === "LineString") g.coordinates.forEach(push);
      else if (g.type === "MultiLineString") g.coordinates.flat().forEach(push);
      else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
    };
    walk(geom);
    return [minX, minY, maxX, maxY];
  }

  // keep my-location marker synced
  useEffect(() => {
    setMeMarker();
  }, [me]);

  return (
    <div className="flex flex-col h-[100dvh]">
      {/* Header */}
      <div className="sticky top-0 z-20 px-4 py-3 flex flex-wrap items-center gap-2 border-b bg-white/95 backdrop-blur">
        <div className="font-semibold text-lg">Emergency — Nearby Help</div>
        <div className="flex-1" />
        <div className="flex gap-2 overflow-x-auto">
          {(["police", "fire_station", "hospital"] as PlaceType[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-3 py-2 rounded-2xl border text-sm whitespace-nowrap ${
                type === t ? "bg-black text-white" : "bg-white"
              }`}
            >
              {t.replace("_", " ").toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {(["DRIVING", "WALKING"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-2 rounded-2xl border text-sm ${
                mode === m ? "bg-sky-600 text-white" : "bg-white"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={recenter}
          className="px-3 py-2 rounded-2xl border text-sm"
        >
          Recenter
        </button>
        <button
          onClick={findNearby}
          disabled={loading}
          className="px-4 py-2 rounded-2xl border bg-black text-white text-sm shadow-sm"
        >
          {loading ? "Searching…" : "Find nearest"}
        </button>
        {installable && (
          <button
            onClick={doInstall}
            className="px-3 py-2 rounded-2xl border bg-green-600 text-white text-sm"
          >
            Install
          </button>
        )}
      </div>

      {/* Map */}
      <div ref={mapDiv} className="flex-1" style={{ minHeight: "52vh" }} />

      {/* Bottom sheet */}
      <div
        className={`border-t bg-white transition-[max-height] duration-300 ease-out ${
          sheetOpen ? "max-h-[44vh]" : "max-h-[11vh]"
        }`}
      >
        <div className="flex justify-center">
          <button
            aria-label="Toggle details"
            onClick={() => setSheetOpen(!sheetOpen)}
            className="mt-2 mb-1 h-6 w-10 rounded-full bg-gray-200 active:scale-95"
          />
        </div>

        <div className="px-4 pb-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">
              {title}{" "}
              <span className="text-gray-500">(tap a row to route)</span>
            </div>
            {selected && (
              <button
                onClick={() => clearOverlays()}
                className="text-sm underline"
              >
                Clear route
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[36vh] overflow-y-auto px-3 pb-4">
          {list.length === 0 ? (
            <div className="px-2 py-3 text-sm text-gray-500">
              No results yet. Tap <b>Find nearest</b>.
            </div>
          ) : (
            <ul className="space-y-2">
              {list.map((c) => (
                <li
                  key={c.id}
                  className={`rounded-2xl border px-3 py-3 cursor-pointer bg-white hover:bg-gray-50 transition ${
                    selected === c.id ? "ring-2 ring-sky-500" : ""
                  }`}
                  onClick={() => drawRoute(c)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{c.name}</div>
                      <div className="text-xs text-gray-600 truncate">
                        {c.address || "-"}
                      </div>
                      <div className="text-sm mt-1">
                        ETA: {c.etaText} • {c.distanceText}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button className="px-3 py-1 rounded-xl border">
                        Route
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="text-[11px] text-gray-500 px-4 py-2 border-t">
          Places by Geoapify · Routing by OSRM · MapLibre + OSM tiles.
        </div>
      </div>
    </div>
  );
}
