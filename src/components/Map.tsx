import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, FeatureGroup, useMap, Polygon } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import 'leaflet/dist/leaflet.css';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

function MapFlyTo({ target }: { target?: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      map.flyTo(target, 18);
    }
  }, [target, map]);
  return null;
}

// Manages Geoman drawing for Roof (Layer 0) and Obstructions (Layers 1+)
function GeomanSetup({ onUpdate, fetchedBuilding, clearTrigger }: { onUpdate: (roofs: number[][][], obstructions: number[][][]) => void, fetchedBuilding?: any, clearTrigger?: number }) {
  const map = useMap();
  const featureGroupRef = useRef<L.FeatureGroup>(null);

  useEffect(() => {
    if (clearTrigger && featureGroupRef.current) {
      featureGroupRef.current.clearLayers();
    }
  }, [clearTrigger]);

  useEffect(() => {
    if (fetchedBuilding && featureGroupRef.current && map) {
        // Clear any previous drawings to avoid conflicts
        featureGroupRef.current.clearLayers();
        
        let coords = fetchedBuilding.geometry.coordinates;
        // WFS geometries might be Polygon or MultiPolygon
        if (fetchedBuilding.geometry.type === 'MultiPolygon') {
           // We'll just grab the first polygon from the multipolygon for simplicity,
           // or we could render all of them. Let's start with the largest component.
           coords = coords[0]; 
        }
        
        // Leaflet expects rings to be specific arrays.
        // coords is an array of rings: [exterior, hole1, hole2...]
        if (coords && coords.length > 0) {
            const leafletCoords = coords.map((ring: number[][]) => 
                ring.map((c: number[]) => [c[1], c[0]])
            );
            
            const polygon = L.polygon(leafletCoords);
            polygon.setStyle({ color: '#fbbf24', fillColor: '#fef3c7', fillOpacity: 0.4, weight: 2, dashArray: '5, 5' });
            
            featureGroupRef.current.addLayer(polygon);
            
            // Auto fit map
            const bounds = polygon.getBounds();
            if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
            }

            // Immediately simulate based on this new roof, ignore holes for simulation array for now, just pass exterior
            onUpdate([coords[0]], []);
            
            // Note: pm events added later or by user will trigger reportLayers.
            // But we need to make sure this polygon has the right color to be considered a roof.
            polygon.setStyle({ color: 'hsl(var(--primary))', fillColor: 'hsl(var(--primary))', fillOpacity: 0.1, dashArray: '5, 5' });
            
            // Set up events on the fetched layer
            polygon.on('contextmenu', () => {
                const isRoof = polygon.options.color === 'hsl(var(--primary))';
                if (isRoof) {
                    polygon.setStyle({ color: 'hsl(var(--destructive))', fillColor: 'hsl(var(--destructive))', fillOpacity: 0.3, dashArray: '0' });
                    polygon.bindTooltip("Hindring", { permanent: false, direction: "center" }).openTooltip();
                } else {
                    polygon.setStyle({ color: 'hsl(var(--primary))', fillColor: 'hsl(var(--primary))', fillOpacity: 0.1, dashArray: '5, 5' });
                    polygon.bindTooltip("Tak", { permanent: false, direction: "center" }).openTooltip();
                }
                setTimeout(() => polygon.closeTooltip(), 2000);
                map.fire('pm:globaledit'); // Trigger a global edit report
            });
            polygon.on('pm:edit', () => map.fire('pm:globaledit'));
            polygon.on('pm:cut', () => setTimeout(() => map.fire('pm:globaledit'), 50));
        }
    }
  }, [fetchedBuilding, map, onUpdate]);

  useEffect(() => {
    if (!map) return;

    map.pm.addControls({
      position: 'topright',
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawPolygon: false,
      drawCircle: false,
      drawText: false,
      editMode: true,
      dragMode: false,
      cutPolygon: true,
      removalMode: true,
    });

    // Default style for Roof
    map.pm.setGlobalOptions({
        pathOptions: {
            color: 'hsl(var(--primary))',
            fillColor: 'hsl(var(--primary))',
            fillOpacity: 0.1,
            weight: 2,
            dashArray: '5, 5'
        }
    });

    const toggleLayerType = (layer: L.Polygon) => {
       const isRoof = layer.options.color === 'hsl(var(--primary))';
       if (isRoof) {
           layer.setStyle({ color: 'hsl(var(--destructive))', fillColor: 'hsl(var(--destructive))', fillOpacity: 0.3, dashArray: '0' });
           layer.bindTooltip("Hindring", { permanent: false, direction: "center" }).openTooltip();
       } else {
           layer.setStyle({ color: 'hsl(var(--primary))', fillColor: 'hsl(var(--primary))', fillOpacity: 0.1, dashArray: '5, 5' });
           layer.bindTooltip("Tak", { permanent: false, direction: "center" }).openTooltip();
       }
       setTimeout(() => layer.closeTooltip(), 2000);
       reportLayers();
    };

    const attachLayerEvents = (layer: L.Polygon) => {
       layer.on('pm:edit', reportLayers);
       layer.on('pm:cut', () => setTimeout(reportLayers, 50));
       layer.on('contextmenu', () => toggleLayerType(layer));
    };

    const reportLayers = () => {
       if (!featureGroupRef.current) return;
       const layers = featureGroupRef.current.getLayers() as L.Polygon[];
       if (layers.length === 0) {
           onUpdate([], []);
           return;
       }
       
       const roofs: number[][][] = [];
       const obstructions: number[][][] = [];

       layers.forEach(layer => {
           const latlngs = layer.getLatLngs();
           const exterior = Array.isArray(latlngs[0]) ? (latlngs[0] as unknown as L.LatLng[]) : (latlngs as L.LatLng[]);
           const ring = exterior.map((ll: L.LatLng) => [ll.lng, ll.lat]);
           
           if (layer.options.color === 'hsl(var(--primary))') {
               roofs.push(ring);
           } else {
               obstructions.push(ring);
           }
       });

       onUpdate(roofs, obstructions);
    };

    map.on('pm:create', (e) => {
      const layer = e.layer as L.Polygon;
      if (featureGroupRef.current) {
        featureGroupRef.current.addLayer(layer);
        const layers = featureGroupRef.current.getLayers();
        if (layers.length > 1) {
            // Style as Obstruction / Exclusion zone by default for subsequent layers
            layer.setStyle({ color: 'hsl(var(--destructive))', fillColor: 'hsl(var(--destructive))', fillOpacity: 0.3, dashArray: '0' });
            // Show a quick visual tooltip or hint
            layer.bindTooltip("Hindring (Høyreklikk for å bytte til Tak)", { permanent: false, direction: "center" }).openTooltip();
            setTimeout(() => layer.closeTooltip(), 3000);
        } else {
            layer.setStyle({ color: 'hsl(var(--primary))', fillColor: 'hsl(var(--primary))', fillOpacity: 0.1, dashArray: '5, 5' });
            layer.bindTooltip("Tak (Høyreklikk for å bytte til Hindring)", { permanent: false, direction: "center" }).openTooltip();
            setTimeout(() => layer.closeTooltip(), 3000);
        }
      }
      attachLayerEvents(layer);
      reportLayers();
    });

    map.on('pm:globaledit', reportLayers);

    map.on('pm:remove', (e) => {
      if (featureGroupRef.current) {
        featureGroupRef.current.removeLayer(e.layer);
      }
      reportLayers();
    });

    return () => {
      map.pm.removeControls();
      map.off('pm:create');
      map.off('pm:remove');
      map.off('pm:globaledit');
    };
  }, [map, onUpdate]);

  return <FeatureGroup ref={featureGroupRef} />;
}

// Panel renderer exactly mapping to precise polygons generated from packing algorithm
function PanelsOverlay({ panels, onPanelClick }: { panels: number[][][], onPanelClick?: (idx: number) => void }) {
  if (!panels || panels.length === 0) return null;

  const panelPolygons = panels.map((coords, idx) => {
    // Backend returns [[lng, lat], [lng, lat], ...] Swap for Leaflet [lat, lng]
    const bounds: [number, number][] = coords.map(c => [c[1], c[0]]);
    return (
        <Polygon 
            key={idx} 
            positions={bounds} 
            eventHandlers={onPanelClick ? {
               click: () => onPanelClick(idx)
            } : {}}
            pathOptions={{ 
                color: 'hsl(var(--accent))', // subtle accent frame
                fillColor: 'hsl(var(--primary))', // primary panel
                fillOpacity: 0.85, 
                weight: 1.5,
                className: 'panel-3d-shadow cursor-pointer'
            }} 
        />
    );
  });

  return (
    <FeatureGroup>
       <style>{`
         .leaflet-interactive.panel-3d-shadow {
            filter: drop-shadow(1px 2px 2px rgba(0,0,0,0.6));
            transition: filter 0.2s ease, fill-opacity 0.2s ease, fill 0.2s ease;
         }
         .leaflet-interactive.panel-3d-shadow:hover {
            filter: drop-shadow(2px 5px 4px rgba(0,0,0,0.8));
            fill-opacity: 1 !important;
            fill: hsl(var(--destructive)) !important; /* Indication for deletion */
         }
       `}</style>
       {panelPolygons}
    </FeatureGroup>
  );
}

function CustomDrawButton() {
  const map = useMap();
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    const handleDrawStart = () => setIsDrawing(true);
    const handleDrawEnd = () => setIsDrawing(false);

    map.on('pm:drawstart', handleDrawStart);
    map.on('pm:drawend', handleDrawEnd);

    return () => {
      map.off('pm:drawstart', handleDrawStart);
      map.off('pm:drawend', handleDrawEnd);
    };
  }, [map]);
  
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000]">
      <button 
        onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isDrawing) {
              map.pm.disableDraw();
            } else {
              map.pm.enableDraw('Polygon', { snappable: true });
            }
        }}
        className={`${isDrawing ? 'bg-destructive hover:bg-destructive/90 text-destructive-foreground' : 'bg-primary hover:bg-primary/90 text-primary-foreground'} px-6 py-3 rounded-full font-bold shadow-lg flex items-center gap-2 transition-transform hover:scale-105 uppercase tracking-widest text-sm pointer-events-auto`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isDrawing ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          )}
        </svg>
        {isDrawing ? 'Avbryt tegning' : 'Tegn solceller'}
      </button>
    </div>
  );
}

export default function Map({ clearTrigger, onPolygonDrawn, panels, targetLocation, simulationData, fetchedBuilding, onPanelClick }: any) {
  return (
    <div className="relative w-full h-full">
      <MapContainer center={[60.392, 5.322]} zoom={6} className="w-full h-full z-0 font-sans">
        <CustomDrawButton />
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          attribution="&copy; Esri &mdash; Source: Esri"
          maxZoom={22}
          maxNativeZoom={18}
        />
        <MapFlyTo target={targetLocation} />
        <GeomanSetup clearTrigger={clearTrigger} onUpdate={onPolygonDrawn} fetchedBuilding={fetchedBuilding} />
        <PanelsOverlay panels={panels} onPanelClick={onPanelClick} />
      </MapContainer>
      
      {/* Floating HUD over map mirroring the theme styling */}
      <div className="absolute bottom-6 left-6 right-6 flex justify-between items-end pointer-events-none z-[1000]">
      </div>

    </div>
  );
}
