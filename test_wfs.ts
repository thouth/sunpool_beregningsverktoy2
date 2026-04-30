import axios from 'axios';

async function testWfs() {
  try {
    const lat = 60.392;
    const lon = 5.322;
    const delta = 0.001; // ~100m
    const url = `https://wfs.geonorge.no/skwms1/wfs.fkb-bygning?service=WFS&version=2.0.0&request=GetFeature&typenames=app:Bygning&outputFormat=application/json&bbox=${lat-delta},${lon-delta},${lat+delta},${lon+delta},urn:ogc:def:crs:EPSG::4326`;
    console.log(url);
    const res = await axios.get(url, { timeout: 5000 });
    console.log("Status:", res.status);
    console.log("Data keys:", Object.keys(res.data));
    if (res.data.features) {
       console.log("Found", res.data.features.length, "features");
       if (res.data.features.length > 0) {
          console.log("First geom type:", res.data.features[0].geometry.type);
       }
    } else {
       console.log(res.data.substring ? res.data.substring(0, 200) : res.data);
    }
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}
testWfs();
