import express from "express";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import * as turf from "@turf/turf";
import axios from "axios";
import path from "path";
import fs from 'fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PANEL_WIDTH = 1.13;
const PANEL_HEIGHT = 2.27; // Commercial 600W panel size
const PANEL_KWP = 0.600; // 600W per panel

// Initialize Firebase Admin for server-side operations
let adminDb: FirebaseFirestore.Firestore | null = null;
try {
  const configRaw = fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf8');
  const firebaseConfig = JSON.parse(configRaw);
  
  const app = initializeApp({
    projectId: firebaseConfig.projectId
  });
  
  adminDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  console.log("Firebase Admin initialized for project:", firebaseConfig.projectId);
} catch (e: any) {
  console.warn("Could not initialize Firebase Admin (this is expected in local dev without service account):", e.message);
}

// Fallback / Offline pricing model for commercial installations
const defaultGetCapexPerKwp = (kwp: number) => {
  if (kwp <= 150) return 6000;
  if (kwp <= 400) return 5500;
  return 5000;
};

let cachedProjectsCost: {kwp: number, capex: number}[] | null = null;
let lastCacheUpdate = 0;

const getCapexPerKwp = async (kwp: number) => {
  if (!adminDb) return defaultGetCapexPerKwp(kwp);

  const now = Date.now();
  if (!cachedProjectsCost || (now - lastCacheUpdate) > 1000 * 60 * 60) {
     try {
        const snapshot = await adminDb.collection("projects").get();
        const data: {kwp: number, capex: number}[] = [];
        
        snapshot.forEach(doc => {
            const val = doc.data();
            const e = val.simulationData?.economics;
            const k = val.simulationData?.totalKwp;
            if (e && k && e.totalCapex) {
                data.push({ kwp: k, capex: e.totalCapex });
            }
        });

        if (data.length > 3) {
            cachedProjectsCost = data.sort((a,b) => a.kwp - b.kwp);
            lastCacheUpdate = now;
        } else {
            console.log("Not enough historical data, using defaults.");
        }
     } catch (err: any) {
        // In AI Studio / Cloud Run, Application Default Credentials will point to the container's SA,
        // which lacks access to the user's Firebase project without an explicit service account key.
        // We gracefully fallback to the default pricing array without polluting logs.
        cachedProjectsCost = null;
        lastCacheUpdate = now; // Prevent immediate retries on every request
     }
  }

  if (cachedProjectsCost && cachedProjectsCost.length >= 3) {
      // Find the two nearest bounds for interpolation
      let lower = cachedProjectsCost[0];
      let upper = cachedProjectsCost[cachedProjectsCost.length - 1];
      
      for (const p of cachedProjectsCost) {
          if (p.kwp <= kwp) lower = p;
          if (p.kwp >= kwp && upper.kwp > p.kwp) upper = p;
      }
      
      if (lower === upper) return lower.capex / lower.kwp;
      
      // Linear interpolation
      const ratio = (kwp - lower.kwp) / (upper.kwp - lower.kwp);
      const interpCapex = lower.capex + ratio * (upper.capex - lower.capex);
      return interpCapex / kwp;
  }

  return defaultGetCapexPerKwp(kwp);
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Basic IP rate limiting to prevent API abuse
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // Limit each IP to 100 requests per `window`
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: "For mange forespørsler fra denne IP-adressen. Vennligst prøv igjen om 15 minutter." }
  });

  app.use('/api/', apiLimiter);

  // Proxy endpoint for Kartverket WFS Building Footprints
  app.get('/api/building', async (req, res) => {
    try {
      const lat = parseFloat(req.query.lat as string);
      const lon = parseFloat(req.query.lon as string);
      if (!lat || !lon) return res.status(400).json({error: 'Missing lat/lon'});
      
      // Very tight bbox around the point (~50m)
      const latDelta = 0.0005;
      const lonDelta = 0.001; 
      const bbox = `${lat-latDelta},${lon-lonDelta},${lat+latDelta},${lon+lonDelta},urn:ogc:def:crs:EPSG::4326`;
      
      // Attempt reaching the open FKB Bygning WFS
      const url = `https://wfs.geonorge.no/skwms1/wfs.fkb-bygning?service=WFS&version=2.0.0&request=GetFeature&typenames=app:Bygning&outputFormat=application/json&bbox=${bbox}`;
      
      const wfsRes = await axios.get(url, { timeout: 8000 });
      if (wfsRes.data && wfsRes.data.features && wfsRes.data.features.length > 0) {
        const pt = turf.point([lon, lat]);
        
        // Find which specific building they actually clicked on inside the bounding box
        let targetBuilding = null;
        for (const feat of wfsRes.data.features) {
          try {
            if (feat.geometry) {
               if (turf.booleanPointInPolygon(pt, feat as any)) {
                  targetBuilding = feat;
                  break;
               }
            }
          } catch(e) {}
        }
        
        if (!targetBuilding) {
           // Fallback: just return the first footprint if exact intersection fails (often points are slightly outside)
           targetBuilding = wfsRes.data.features[0];
        }
        
        return res.json(targetBuilding);
      }
      res.status(404).json({error: 'No building found'});
    } catch(error: any) {
      console.error('WFS fetching error:', error?.message);
      res.status(500).json({error: 'WFS system unavailable'});
    }
  });

  app.post("/api/simulate", async (req, res) => {
    try {
      const { roofs, polygon, isCabin, obstructions } = req.body;
      
      // Support legacy 'polygon' or new 'roofs'
      const activeRoofs = roofs || (polygon ? [polygon] : []);

      if (!activeRoofs || activeRoofs.length === 0) {
        return res.status(400).json({ error: "Ingen gyldige takflater ble registrert. Vennligst tegn opp bygget." });
      }

      // 1. Parse and Robustly Buffer obstructions
      const obsPolys: any[] = [];
      for (const obs of (obstructions || [])) {
        if (obs.length >= 3) {
            const op = turf.polygon([[...obs, obs[0]]]);
            try {
                // Buffer by 0.2m to ensure a safe distance around vents/chimneys
                const buffered = turf.buffer(op, 0.2, { units: 'meters' });
                obsPolys.push(buffered || op);
            } catch(e) {
                obsPolys.push(op);
            }
        }
      }

      let errors: string[] = [];
      let allPanels: number[][][] = [];
      let totalNumPanels = 0;
      let centerLat = 0;
      let centerLon = 0;
      let azimuth = 180;
      let finalSystemTilt = 15;
      let bestConfig = "Stående";

      // Pack panels for each roof
      for (const roofPolygonCoords of activeRoofs) {
          if (!roofPolygonCoords || roofPolygonCoords.length < 3) continue;
          
          const turfPolygon = turf.polygon([[...roofPolygonCoords, roofPolygonCoords[0]]]); // Close the polygon

          let safeAreaFeature: any = null;
          try {
            const buffered = turf.buffer(turfPolygon, -1.0, { units: "meters" });
            if (buffered) {
                safeAreaFeature = buffered;
            }
          } catch (e) {}

          if (!safeAreaFeature) {
             console.warn("Roof too small for safety buffer, skipping...", roofPolygonCoords);
             errors.push("En eller flere takflater er for smale for den påkrevde sikkerhetsavstanden.");
             continue; 
          }

          let maxDist = 0;
          let longestEdgeBearing = 0;
          const coords = roofPolygonCoords;
          for (let i=0; i<coords.length; i++) {
            const p1 = coords[i];
            const p2 = coords[(i+1)%coords.length];
            const dist = turf.distance(p1, p2, {units: 'meters'});
            if (dist > maxDist) {
              maxDist = dist;
              longestEdgeBearing = turf.bearing(p1, p2);
            }
          }

          const centerPoint = turf.centerOfMass(turfPolygon);
          const alignAngle = 90 - longestEdgeBearing; 
          azimuth = (longestEdgeBearing + 90) % 360;
          
          const rotatedSafe = turf.transformRotate(safeAreaFeature, alignAngle, { pivot: centerPoint });
          const rotatedObs = obsPolys.map(op => turf.transformRotate(op, alignAngle, { pivot: centerPoint }));
          
          const bbox = turf.bbox(rotatedSafe);
          const minLon = bbox[0];
          const minLat = bbox[1];
          const maxLon = bbox[2];
          const maxLat = bbox[3];

          centerLat = centerPoint.geometry.coordinates[1];
          centerLon = centerPoint.geometry.coordinates[0];
          const meterToLat = 1 / 111320;
          const meterToLon = 1 / (111320 * Math.cos(centerLat * Math.PI / 180));

          const roofAreaSqMeters = turf.area(turfPolygon);
          // Estimate pitch based on size if not explicitly provided
          // Typically residential (pitched) < 300 sqm. Commercial (flat) >= 300 sqm.
          let estimatedPitch = isCabin === true ? 35 : (roofAreaSqMeters < 300 ? 35 : 0);
          let systemTilt = estimatedPitch === 0 ? 15 : estimatedPitch; // Flat roofs often tilted to 15 deg
          finalSystemTilt = systemTilt;

          const packGrid = (pWidth: number, pHeight: number, xOffsetMeters: number, yOffsetMeters: number) => {
            const candidatePanels = [];
            
            let panelEffectiveWidth = pWidth;
            let panelEffectiveHeight = pHeight;
            let colSpacingMeters = 0.05; // 5cm gap sideways
            let rowSpacingMeters = 0.05; // 5cm gap between rows for pitched roof
            
            if (estimatedPitch === 0) {
                 const tiltRad = systemTilt * Math.PI / 180;
                 panelEffectiveHeight = pHeight * Math.cos(tiltRad);
                 const verticalHeight = pHeight * Math.sin(tiltRad);
                 // Rule of thumb for Norway (low sun angle): shadow factor is ~2.5x the vertical height, minimum 0.5m
                 rowSpacingMeters = Math.max(0.5, verticalHeight * 2.5);
            }

            const pWidthDeg = panelEffectiveWidth * meterToLon;
            const pHeightDeg = panelEffectiveHeight * meterToLat;
            const gapLon = colSpacingMeters * meterToLon; 
            const gapLat = rowSpacingMeters * meterToLat;

            const startX = (minLon - pWidthDeg) + (xOffsetMeters * meterToLon);
            const startY = (minLat - pHeightDeg) + (yOffsetMeters * meterToLat);

            for (let x = startX; x < maxLon; x += (pWidthDeg + gapLon)) {
                for (let y = startY; y < maxLat; y += (pHeightDeg + gapLat)) {
                     if (candidatePanels.length >= 10000) break;

                     const pPoly = turf.polygon([[
                         [x, y],
                         [x + pWidthDeg, y],
                         [x + pWidthDeg, y + pHeightDeg],
                         [x, y + pHeightDeg],
                         [x, y]
                     ]]);
                     
                     try {
                         if (turf.booleanPointInPolygon(turf.center(pPoly), rotatedSafe)) {
                             if (turf.booleanWithin(pPoly, rotatedSafe)) {
                                 let hitsObstruction = false;
                                 for(const obs of rotatedObs) {
                                     if (turf.intersect(turf.featureCollection([pPoly, obs]))) {
                                         hitsObstruction = true;
                                         break;
                                     }
                                 }
                                 if (!hitsObstruction) {
                                     const finalPoly = turf.transformRotate(pPoly, -alignAngle, { pivot: centerPoint });
                                     candidatePanels.push(finalPoly.geometry.coordinates[0].slice(0, 4));
                                 }
                             }
                         }
                     } catch(err) {} 
                }
            }
            return candidatePanels;
          };

          let bestPanels: number[][][] = [];
          
          const configs = [
            { w: PANEL_WIDTH, h: PANEL_HEIGHT, name: "Stående (Portrait)" },
            { w: PANEL_HEIGHT, h: PANEL_WIDTH, name: "Liggende (Landscape)" }
          ];
          
          const shifts = [0, 0.25, 0.5, 0.75];

          for (const config of configs) {
            for (const sx of shifts) {
              for (const sy of shifts) {
                const panelsFound = packGrid(config.w, config.h, sx * config.w, sy * config.h);
                if (panelsFound.length > bestPanels.length) {
                  bestPanels = panelsFound;
                  bestConfig = config.name;
                }
              }
            }
          }

          if (bestPanels.length === 0) {
             errors.push("Kunne ikke plassere paneler på en takflate. Den kan være for liten, eller ha for mange oppmerkede hindringer.");
          }

          allPanels = allPanels.concat(bestPanels);
      }

      const panels = allPanels;
      const numPanels = panels.length;
      const totalKwp = numPanels * PANEL_KWP;

      if (numPanels === 0) {
        const uniqueErrors = Array.from(new Set(errors));
        return res.status(400).json({ error: uniqueErrors.length > 0 ? uniqueErrors.join(" ") : "Klarte ikke plassere paneler på de gitte takflatene med gyldig sikkerhetsavstand." });
      }

      // 5. PVGIS PVcalc request (using the center of the last processed roof as proxy for the system)
      const lat = centerLat;
      const lon = centerLon;


      // 5. PVGIS PVcalc request
      let monthlyProduction = [];
      let yearlyProductionKwh = 0;
      
      try {
        const pvgisRes = await axios.get(`https://re.jrc.ec.europa.eu/api/v5_2/PVcalc`, {
          params: {
            lat: lat.toFixed(4),
            lon: lon.toFixed(4),
            peakpower: totalKwp.toFixed(2),
            loss: 14,
            angle: finalSystemTilt.toFixed(0),
            aspect: (azimuth - 180).toFixed(0),
            outputformat: 'json'
          }
        });
        const pvgisData = pvgisRes.data;
        if (!pvgisData?.outputs?.monthly?.fixed || !pvgisData?.outputs?.totals?.fixed?.E_y) {
          throw new Error("PVGIS API returnerte ufullstendige eller uventede data for produksjon.");
        }
        monthlyProduction = pvgisData.outputs.monthly.fixed;
        yearlyProductionKwh = pvgisData.outputs.totals.fixed.E_y;
      } catch (e: any) {
        console.error("PVGIS API Error:", e.response?.data || e.message);
        let errorMsg = "Klarte ikke å hente solcelledata fra PVGIS.";
        if (e.response?.status === 400 || e.response?.status === 404) {
          errorMsg = "Ugyldig plassering for PVGIS API. Bygget kan være for langt nord eller utenfor dekning.";
        }
        if (e.response?.data?.message) {
          errorMsg += ` Detaljer fra PVGIS: ${e.response.data.message}`;
        } else if (e.message) {
          errorMsg += ` Feilmelding: ${e.message}`;
        }
        return res.status(502).json({ error: errorMsg });
      }

      // 6. Economics (HvaKosterStrommen + Enova)
      let averageElectricityPriceWithGrid = 1.30; 
      try {
        const d = new Date();
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const stromRes = await axios.get(`https://www.hvakosterstrommen.no/api/v1/prices/${year}/${month}-${day}_NO5.json`);
         
        let sum = 0;
        stromRes.data.forEach((h: any) => sum += h.NOK_per_kWh);
        const avgStomp = sum / stromRes.data.length;
        averageElectricityPriceWithGrid = (avgStomp * 1.25) + 0.50; 
      } catch(e: any) {
        console.error("Strompris API Error, using fallback", e.message);
      }

      const capexRate = await getCapexPerKwp(totalKwp);
      const totalCapex = totalKwp * capexRate;
      const netCost = totalCapex; // No Enova support for B2B
      
      const yearlySavings = yearlyProductionKwh * averageElectricityPriceWithGrid;
      const roiYears = netCost / yearlySavings;

      res.json({
        panels, // Full polygons! Extracted precisely from packing
        numPanels,
        layout: bestConfig,
        totalKwp: parseFloat(totalKwp.toFixed(2)),
        yearlyProductionKwh: parseFloat(yearlyProductionKwh.toFixed(0)),
        azimuth: parseFloat(azimuth.toFixed(0)),
        lat: parseFloat(lat.toFixed(4)),
        lon: parseFloat(lon.toFixed(4)),
        production: monthlyProduction.map((m: any) => ({
          month: m.month || m.m,
          kWh: m.E_m || m.E_m || Math.round(yearlyProductionKwh / 12)
        })),
        economics: {
          totalCapex: Math.round(totalCapex),
          netCost: Math.round(netCost),
          yearlySavings: Math.round(yearlySavings),
          roiYears: parseFloat(roiYears.toFixed(1))
        }
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        res.status(500).json({ error: `Systemfeil: ${error.message}` });
      } else {
        res.status(500).json({ error: "Simuleringen feilet på grunn av en uventet feil i serveren." });
      }
    }
  });

  app.post("/api/export-csv", async (req, res) => {
    try {
      const { lat, lon, totalKwp, azimuth } = req.body;
      if (!lat || !lon || !totalKwp) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      // Fetch hourly data for a non-leap year (2019) to get exactly 8760 hours
      const pvgisRes = await axios.get(`https://re.jrc.ec.europa.eu/api/v5_2/seriescalc`, {
        params: {
          lat: parseFloat(lat).toFixed(4),
          lon: parseFloat(lon).toFixed(4),
          peakpower: parseFloat(totalKwp).toFixed(2),
          loss: 14,
          optimalinclination: 1,
          pvcalculation: 1,
          startyear: 2019,
          endyear: 2019,
          outputformat: 'json'
        }
      });

      const hourlyData = pvgisRes.data?.outputs?.hourly;
      if (!hourlyData || !Array.isArray(hourlyData)) {
        throw new Error("PVGIS API returnerte et uventet format på timesdata.");
      }
      
      // Map PVGIS data to a dictionary by MMDDHH to easily map to a whole year
      // PVGIS format for time is 'YYYYMMDD:HHMM' -> e.g. '20190101:0010' (UTC)
      const powerMap = new Map<string, number>();
      for (const row of hourlyData) {
         const timeStr = row.time.toString();
         if (timeStr.length >= 13) {
            const mmddhh = timeStr.substring(4, 11); // 'MMDD:HH'
            powerMap.set(mmddhh, row.P);
         }
      }

      // Generate exact 8760 hours for a standard year
      const csvLines = ["Tidspunkt;Produksjon_kWh"];
      const year = 2019;
      const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
      const endYear = year + 1;
      
      let currentDate = startDate;
      while (currentDate.getUTCFullYear() < endYear) {
         const mm = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
         const dd = String(currentDate.getUTCDate()).padStart(2, '0');
         const hh = String(currentDate.getUTCHours()).padStart(2, '0');
         const mmddhh = `${mm}${dd}:${hh}`;

         const pW = powerMap.get(mmddhh) || 0;
         const pKwh = (pW / 1000).toFixed(4).replace('.', ','); // W to kWh, use comma instead of dot

         const timeFormatted = `${dd}.${mm}.2025 ${hh}:00`;
         csvLines.push(`${timeFormatted};${pKwh}`);

         currentDate.setUTCHours(currentDate.getUTCHours() + 1);
      }

      const csvString = csvLines.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="solproduksjon_timesverdier.csv"');
      res.send(csvString);

    } catch (error: any) {
      console.error("CSV Export PVGIS Error:", error.response?.data || error.message);
      let errorMsg = "Klarte ikke å generere CSV-data fra PVGIS.";
      if (error.response?.status === 400 || error.response?.status === 404) {
        errorMsg = "Ugyldig plassering for PVGIS API ved eksport. Bygget kan være for langt nord.";
      }
      if (error.response?.data?.message) {
        errorMsg += ` Detaljer fra PVGIS: ${error.response.data.message}`;
      } else if (error.message) {
        errorMsg += ` Feilmelding: ${error.message}`;
      }
      res.status(502).json({ error: errorMsg });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
