import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, ZoomControl } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLngExpression } from "leaflet";
import { segmentTracksByProvider, type TrackPoint } from "../domain/aircraft";

type Props = { id?: string; center: LatLngExpression; trackPoints?: TrackPoint[]; replayIndex?: number };

const sourceColors = ["#37d4b5", "#f0b85c", "#79a8ff", "#e886b7"];

export function LiveMap({ id, center, trackPoints = [], replayIndex = 0 }: Props) {
  const tileUrl = import.meta.env.VITE_MAPQUEST_TILE_URL;
  const mapQuestKey = import.meta.env.VITE_MAPQUEST_KEY;
  const configured = Boolean(tileUrl && mapQuestKey);
  const providerTracks = segmentTracksByProvider(trackPoints);
  const ordered = [...trackPoints].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const replayPoint = ordered[Math.min(replayIndex, Math.max(0, ordered.length - 1))];

  return (
    <section id={id} className="map-panel" aria-labelledby="map-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Observed positions</p>
          <h2 id="map-heading">Live map</h2>
        </div>
        <span className={`status-chip ${configured ? "ready" : "blocked"}`}>
          {configured ? "Basemap ready" : "MapQuest configuration required"}
        </span>
      </div>
      <div className="map-frame">
        <MapContainer center={center} zoom={9} zoomControl={false} className="map" aria-label="Aircraft map">
          <ZoomControl position="bottomright" />
          {configured ? (
            <TileLayer
              url={`${tileUrl!}${tileUrl!.includes("?") ? "&" : "?"}key=${encodeURIComponent(mapQuestKey!)}`}
              attribution='Tiles &copy; <a href="https://www.mapquest.com/">MapQuest</a>'
            />
          ) : null}
          {providerTracks.map((track, sourceIndex) => track.segments.map((segment, segmentIndex) => (
            <Polyline
              key={`${track.provider}:${segment.kind}:${segmentIndex}`}
              positions={segment.points.map((point) => [point.latitude, point.longitude] as LatLngExpression)}
              pathOptions={{ color: sourceColors[sourceIndex % sourceColors.length], weight: segment.kind === "gap" ? 2 : 3, dashArray: segment.kind === "gap" ? "5 9" : undefined, opacity: segment.kind === "gap" ? 0.55 : 0.9 }}
            />
          )))}
          {replayPoint && <CircleMarker center={[replayPoint.latitude, replayPoint.longitude]} radius={8} pathOptions={{ color: "#ffffff", fillColor: "#37d4b5", fillOpacity: 1, weight: 3 }}><Tooltip permanent direction="top">{replayPoint.registration ?? replayPoint.callsign ?? replayPoint.icao24}</Tooltip></CircleMarker>}
        </MapContainer>
        {!configured && trackPoints.length === 0 && (
          <div className="map-blocker" role="status">
            <span className="radar-mark" aria-hidden="true" />
            <strong>Basemap intentionally offline</strong>
            <p>Add approved MapQuest browser configuration to display tiles. No alternate provider is contacted.</p>
          </div>
        )}
      </div>
    </section>
  );
}
