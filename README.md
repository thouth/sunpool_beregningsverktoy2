# Norsk Solcellekalkulator (Norwegian Solar Calculator)

Norsk Solcellekalkulator is a full-stack web application designed to help users accurately estimate the solar energy potential of a building's roof in Norway. It features an interactive map for drawing roof areas and obstructions, calculates optimal solar panel placement, determines energy production using the PVGIS API, and provides a financial overview based on historical electricity prices in the NO5 price area.

## 🚀 Features

- **Address Search & Building Footprints:** Search for an address in Norway. The app fetches the exact building footprint from Kartverket (The Norwegian Mapping Authority) via their WFS API and displays it on the map.
- **Interactive Roof Mapping:** Use the map to manually draw the roof shape, cut the roof along the ridge to separate pitch directions, and specify areas as obstructions (chimneys, vents) where panels cannot be placed.
- **Smart Panel Layout Algorithm:** The application calculates the maximum number of standard solar panels (currently calibrated to 600W commercial size panels) that can fit on the drawn roof planes using spatial geometry (Turf.js). It dynamically creates a grid and subtracts panels overlapping with boundaries or obstructions.
- **Energy Production & Financial Simulation:** It uses the European Commission's PVGIS API to calculate standard monthly production and hourly production profiles based on exact geographical coordinates and estimated panel tilt/azimuth. The dashboard simulates potential energy generation and savings.
- **Data Export:** Export the simulated hourly production data for a typical meteorological year (TMY) directly to CSV for further analysis, as well as a standardized PDF report.
- **User Authentication & Project Saving:** Log in via Google to save your simulated projects (roof coordinates, parameters, and location) to Firebase, accessible from a personal dashboard.

## 🏗️ Technology Stack

- **Frontend:** React, TypeScript, Tailwind CSS, shadcn/ui.
- **Map & Geospatial:** Leaflet, React-Leaflet, Leaflet Geoman (drawing tools), Turf.js (spatial analysis and optimal panel calculation).
- **Backend:** Node.js, Express (used for proxying Kartverket API, rate-limiting, calculating grid layouts server-side, and communicating with PVGIS to hide implementation complexity).
- **Database / Auth:** Firebase Authentication (Google) & Cloud Firestore.
- **Build Tool:** Vite, running via Express middleware in development.

## ⚙️ How it works

1. **Location Input:** The user types in an address. The map centers on this location using the address coordinates.
2. **Building Fetching:** The Express backend proxies a WFS request to Kartverket (`/api/building`) to avoid CORS limitations. It finds the building polygon corresponding to the search coordinate. If a building is found, it renders on the Leaflet map.
3. **Drafting:** The user verifies and edits the geometry, cutting the roof into individual planes and defining negative zones for obstacles.
4. **Calculations (`server.ts` - `/api/simulate`):** 
   - A POST request containing the roof polygons is sent to the backend.
   - Turf.js iterates over each valid roof plane, calculating orientation and boundaries. It generates a dense grid of panel polygons based on the dimensions.
   - Panels that clash with the roof borders or specified obstructions are algorithmically removed.
   - The remaining panels sum up to a total installed capacity (kWp) and average azimuth/tilt.
   - The PVGIS `PVcalc` and `seriescalc` APIs are called with the calculated system capacity to retrieve monthly totals and an hourly TMY profile.
5. **Insights:** The React frontend visualizes the returned data using Recharts, showing expected generation curves, estimated financial savings over the first year, and payback periods (ROI).

---

## 💻 How to run locally

### Prerequisites
- Node.js (v18 or newer recommended)
- A Firebase Project (for Authentication and Database)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd solcellekalkulator
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Create a `.env` file in the root directory.
   ```env
   # Required for Firebase Admin
   FIREBASE_PROJECT_ID=your-project-id
   GOOGLE_APPLICATION_CREDENTIALS=path/to/your/service-account.json
   ```
   *Note: If you do not configure Firebase Admin, you might encounter issues with the saving capability, though the core simulation algorithms will function.*

   Configure your Firebase Client parameters by making sure `firebase-applet-config.json` is correctly set up.

4. **Start the Development Server:**
   ```bash
   npm run dev
   ```
   This command starts the Express backend (handled by `tsx`) which dynamically loads the Vite frontend middleware. Open `http://localhost:3000` in your browser.

---

## ☁️ How to run on Render (Deployment)

[Render](https://render.com/) is an excellent PaaS for deploying full-stack Node.js + Vite applications.

### 1. Preparing the Project for Render

Your `package.json` already contains the correct scripts for deployment:
```json
"scripts": {
  "build": "vite build && tsc --project tsconfig.server.json || echo 'No server build needed if running tsx'",
  "start": "tsx server.ts"
}
```

### 2. Create a new Web Service on Render

1. Create a free account on [Render](https://render.com/).
2. Click **New +** and select **Web Service**.
3. Connect your GitHub repository and select the target branch.

### 3. Configure the Web Service

Fill in the required deployment settings as follows:

- **Name:** `norsk-solcellekalkulator` (or arbitrary name)
- **Environment:** `Node`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- *(Important)* Make sure you select the Free or Starter tier.

### 4. Environment Variables

Scroll down to **Advanced** -> **Environment Variables**. You need to configure:

- Any Firebase Admin credentials (e.g. `FIREBASE_PROJECT_ID`, or formatting a service account JSON into `GOOGLE_APPLICATION_CREDENTIALS` if using JSON inline).
- **`NODE_ENV`**: Set to `production` (Render handles this usually, but good practice).
- **Note on `PORT`:** Render will inject the `PORT` environment variable automatically. The Express application in `server.ts` handles this securely, binding to `0.0.0.0`.

### 5. Deploy

Click **Create Web Service**. Render will now automatically install dependencies, build the frontend Vite output into `./dist`, and boot the `tsx` Express server. Once the build finishes, your solar calculator will be live and accessible via your `*.onrender.com` URL!
