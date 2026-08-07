import { MapContainer, TileLayer, ZoomControl } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLngExpression } from "leaflet";

type Props = { center: LatLngExpression };

export function LiveMap({ center }: Props) {
  const tileUrl = import.meta.env.VITE_MAPQUEST_TILE_URL;
  const mapQuestKey = import.meta.env.VITE_MAPQUEST_KEY;
  const configured = Boolean(tileUrl && mapQuestKey);

  return (
    <section className="map-panel" aria-labelledby="map-heading">
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
        </MapContainer>
        {!configured && (
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
