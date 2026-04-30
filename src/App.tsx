import React, { useState, useEffect, useRef } from 'react';
import * as turf from '@turf/turf';
import { toPng } from 'html-to-image';
import jsPDF from 'jspdf';
import MapComponent from './components/Map';
import Dashboard from './components/Dashboard';
import AdminDashboard from './components/AdminDashboard';
import { auth, loginWithGoogle, logout, db } from './services/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [currentView, setCurrentView] = useState<'map' | 'admin'>('map');
  const [simulationData, setSimulationData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [targetLocation, setTargetLocation] = useState<[number, number] | undefined>();
  const [fetchedBuilding, setFetchedBuilding] = useState<any>(null);
  const [toast, setToast] = useState<{message: string, type: 'info' | 'error'} | null>(null);
  const [clearMapTrigger, setClearMapTrigger] = useState(0);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const skipNextSearchRef = useRef(false);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setUser(user);
    });
    return () => unsubscribe();
  }, []);

  const handleReset = () => {
    setSimulationData(null);
    setFetchedBuilding(null);
    setSearchQuery('');
    setClearMapTrigger(prev => prev + 1);
  };

  const handleSimulate = async (roofs: number[][][], obstructionCoords: number[][][]) => {
    if (!roofs || roofs.length === 0) {
      setSimulationData(null);
      return;
    }

    await executeSimulate(roofs, obstructionCoords);
  };

  const executeSimulate = async (roofCoords: number[][][], obstructionCoords: number[][][]) => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roofs: roofCoords, obstructions: obstructionCoords }),
      });
      const data = await response.json();
      
      if (!response.ok) {
        setToast({ message: data.error || 'Kunne ikke simulere. Prøv igjen.', type: 'error' });
        setSimulationData(null);
        return;
      }
      
      setSimulationData(data);
    } catch (error: any) {
      console.error('Simulation failed:', error);
      setToast({ message: error.message || 'Kunne ikke kommunisere med serveren. Sjekk internettilkoblingen.', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePanelRemove = (indexToRemove: number) => {
     if (!simulationData) return;
     const newPanels = simulationData.panels.filter((_: any, i: number) => i !== indexToRemove);
     const newNumPanels = newPanels.length;
     if (newNumPanels === 0) {
        setSimulationData(null);
        return;
     }

     const oldNumPanels = simulationData.numPanels;
     const ratio = newNumPanels / oldNumPanels;

     setSimulationData({
         ...simulationData,
         panels: newPanels,
         numPanels: newNumPanels,
         totalKwp: parseFloat((simulationData.totalKwp * ratio).toFixed(2)),
         yearlyProductionKwh: parseFloat((simulationData.yearlyProductionKwh * ratio).toFixed(0)),
         production: simulationData.production.map((m: any) => ({...m, kWh: Math.round(m.kWh * ratio)})),
         economics: {
           ...simulationData.economics,
           totalCapex: Math.round(simulationData.economics.totalCapex * ratio),
           netCost: Math.round(simulationData.economics.netCost * ratio),
           yearlySavings: Math.round(simulationData.economics.yearlySavings * ratio),
         }
     });
  };

  useEffect(() => {
    const handler = setTimeout(() => {
      if (skipNextSearchRef.current) {
        skipNextSearchRef.current = false;
        return;
      }
      if (searchQuery && searchQuery.length > 2) {
        performSearch(searchQuery);
      } else {
        setSearchResults([]);
      }
    }, 400);

    return () => {
      clearTimeout(handler);
    };
  }, [searchQuery]);

  const performSearch = async (query: string) => {
    try {
      const res = await fetch(`https://ws.geonorge.no/adresser/v1/sok?sok=${encodeURIComponent(query)}&treffPerSide=5`);
      const data = await res.json();
      setSearchResults(data.adresser || []);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery) return;
    performSearch(searchQuery);
  };

  const selectAddress = async (addr: any) => {
    const lat = addr.representasjonspunkt.lat;
    const lon = addr.representasjonspunkt.lon;
    
    skipNextSearchRef.current = true;
    setTargetLocation([lat, lon]);
    setSearchResults([]);
    setSearchQuery(addr.adressetekst);

    setToast({ message: 'Søker etter bygningsdata...', type: 'info' });
    try {
       const res = await fetch(`/api/building?lat=${lat}&lon=${lon}`);
       if (res.ok) {
           const buildingData = await res.json();
           if (buildingData?.geometry?.coordinates) {
               setFetchedBuilding(buildingData);
               setToast(null); // Success, hide toast
           } else {
               setFetchedBuilding(null);
               setToast(null);
           }
       } else {
           if (res.status === 429) {
               const errorData = await res.json();
               setToast({ message: errorData.error || 'For mange forespørsler.', type: 'error' });
           } else {
               setFetchedBuilding(null);
               setToast(null);
           }
       }
    } catch(err) {
       console.error("Failed to fetch building", err);
       setFetchedBuilding(null);
       setToast(null);
    }
  };

  const handleSaveProject = async () => {
    if (!user) {
       setToast({ message: 'Du må logge inn for å lagre prosjektet.', type: 'error' });
       return;
    }
    if (!simulationData || !searchQuery) {
       setToast({ message: 'Ingen simulering eller adresse å lagre ennå.', type: 'error' });
       return;
    }

    setToast({ message: 'Lagrer prosjekt...', type: 'info' });
    try {
      await addDoc(collection(db, 'projects'), {
         userId: user.uid,
         userEmail: user.email || '',
         address: searchQuery,
         targetLocation,
         simulationData,
         createdAt: serverTimestamp(),
         updatedAt: serverTimestamp()
      });
      setToast({ message: 'Prosjekt lagret i skyen! 🎉', type: 'info' });
    } catch (err: any) {
      console.error(err);
      setToast({ message: `Kunne ikke lagre: ${err.message}`, type: 'error' });
    }
  };

  const handleExportPdf = async () => {
    if (!mainRef.current || !simulationData) return;
    setIsExportingPdf(true);
    setToast({ message: 'Genererer PDF...', type: 'info' });
    
    try {
      // Small delay to ensure any UI states settle
      await new Promise(r => setTimeout(r, 100));
      
      const dataUrl = await toPng(mainRef.current, {
        quality: 0.95,
        pixelRatio: 2,
        backgroundColor: '#f8fafc', // safe fallback
        style: {
          // Remove max heights or external styles that might affect render
          transform: 'none'
        }
      });

      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      
      const imgProps = pdf.getImageProperties(dataUrl);
      
      // Calculate aspect ratio to fit the page. landscape A4 is 297x210
      const imgRatio = imgProps.width / imgProps.height;
      const pdfRatio = pdfWidth / pdfHeight;
      
      let finalWidth = pdfWidth;
      let finalHeight = finalWidth / imgRatio;
      
      if (finalHeight > pdfHeight) {
          finalHeight = pdfHeight;
          finalWidth = finalHeight * imgRatio;
      }
      
      const marginX = (pdfWidth - finalWidth) / 2;
      const marginY = (pdfHeight - finalHeight) / 2;

      pdf.addImage(dataUrl, 'PNG', marginX, marginY, finalWidth, finalHeight);
      pdf.save(`solcelle_rapport_${searchQuery || 'prosjekt'}.pdf`);
      setToast(null);
    } catch (err: any) {
      console.error("PDF Export error:", err);
      setToast({ message: `Kunne ikke eksportere PDF: ${err.message || 'Ukjent feil'}`, type: 'error' });
    } finally {
      setIsExportingPdf(false);
    }
  };

  const isAdminUser = user?.email === 'thuthaug@gmail.com';

  return (
    <div className="w-full h-screen bg-background font-sans flex flex-col overflow-hidden text-foreground">
      {/* Top Navigation Bar */}
      <header className="h-16 bg-background border-b border-border px-6 flex items-center justify-between z-[2000] shrink-0">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 100 100" className="w-8 h-8 fill-primary">
              <path fillRule="evenodd" clipRule="evenodd" d="M50 71c-11.598 0-21-9.402-21-21s9.402-21 21-21 21 9.402 21 21-9.402 21-21 21Zm0-5.25c8.698 0 15.75-7.052 15.75-15.75S58.698 34.25 50 34.25 34.25 41.302 34.25 50 41.302 65.75 50 65.75Z" />
              {Array.from({ length: 10 }).map((_, i) => (
                <rect key={i} x="42" y="2" width="16" height="22" rx="1" transform={`rotate(${i * 36} 50 50)`} />
              ))}
            </svg>
            <span className="text-xl font-bold tracking-tight text-foreground">SUNPOOL</span>
          </div>
          <div className="relative w-96">
            <form onSubmit={handleSearch} className="flex flex-row">
              <div className="relative flex-grow">
                <input 
                  type="text" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Søk gateadresse i Norge..." 
                  className="w-full bg-muted border border-input rounded-l-md px-4 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 text-foreground placeholder:text-muted-foreground"
                />
                {!searchQuery && (
                   <div className="absolute right-3 top-2.5 text-muted-foreground pointer-events-none">
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                   </div>
                )}
              </div>
              <button 
                type="submit" 
                className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 text-sm font-semibold rounded-r-md transition-colors"
              >
                Søk
              </button>
            </form>
            {searchResults.length > 0 && (
              <ul className="absolute top-11 left-0 w-full bg-background shadow-lg border border-border rounded-md max-h-60 overflow-y-auto z-50">
                {searchResults.map((r, i) => (
                  <li 
                    key={i} 
                    className="px-4 py-2 hover:bg-muted text-sm cursor-pointer border-b border-border last:border-0 text-foreground font-medium transition-colors"
                    onClick={() => selectAddress(r)}
                  >
                    {r.adressetekst}, {r.poststed}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="flex gap-4 items-center">
          {isAdminUser && (
            <button 
                onClick={() => setCurrentView(currentView === 'map' ? 'admin' : 'map')}
                className="px-4 py-2 border border-primary text-primary bg-primary/5 hover:bg-primary/10 rounded-md text-sm font-semibold shadow-sm transition-colors"
            >
              {currentView === 'map' ? 'Admin Panel (CRM)' : 'Tilbake til Kalkulator'}
            </button>
          )}

          {!user ? (
            <button onClick={loginWithGoogle} className="px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors">Logg inn med Google</button>
          ) : (
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-muted-foreground">{user.email}</span>
              <button onClick={logout} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors border border-border rounded-md hover:bg-muted">Logg ut</button>
            </div>
          )}
          <div className="flex items-center gap-2">
            {simulationData && (
              <button 
                onClick={handleExportPdf}
                disabled={isExportingPdf}
                className="px-4 py-2 bg-secondary hover:bg-secondary/90 text-secondary-foreground rounded-md text-sm font-semibold shadow-sm transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isExportingPdf ? (
                  <>
                     <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                     Lager PDF...
                  </>
                ) : (
                  <>
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                     Eksport PDF
                  </>
                )}
              </button>
            )}
            <button 
              onClick={handleReset}
              className="px-4 py-2 bg-transparent text-sm font-semibold shadow-sm transition-colors border border-border hover:border-destructive hover:text-destructive hover:bg-destructive/10 rounded-md"
            >
              Slett tegning
            </button>
            <button 
              onClick={handleSaveProject} 
              className="px-6 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md text-sm font-semibold shadow-sm transition-colors disabled:opacity-50"
              disabled={!simulationData}
            >
              Send til CRM og lag tilbud
            </button>
          </div>
        </div>
      </header>

      {currentView === 'admin' ? (
        <section className="flex-1 bg-muted/30 overflow-hidden">
          <AdminDashboard onMapRequested={() => setCurrentView('map')} />
        </section>
      ) : (
        <main ref={mainRef} className="flex-1 flex overflow-hidden bg-background">
          {/* Sidebar / Configuration */}
          <aside className="w-1/3 min-w-[350px] max-w-[420px] bg-background border-r border-border flex flex-col overflow-y-auto">
          <div className="p-6 pb-2">
            <div className="bg-muted/50 p-4 rounded-md border border-border mb-6 shadow-sm">
              <div className="flex items-center justify-between cursor-pointer" onClick={() => setShowInstructions(!showInstructions)}>
                <div className="flex items-center gap-2">
                   <div className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold text-xs italic">i</div>
                   <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Instruksjoner for tegning</h2>
                </div>
                <div className="text-muted-foreground">
                   {showInstructions ? (
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 15l7-7 7 7"></path></svg>
                   ) : (
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                   )}
                </div>
              </div>
              {showInstructions && (
                <ol className="list-decimal ml-4 text-xs space-y-1 text-foreground/80 font-medium pt-3 mt-3 border-t border-border">
                  <li>Søk opp en adresse for å sentrere kartet.</li>
                  <li>Bruk &quot;Tegn solceller&quot;-knappen over kartet for å tegne takets ytterkant, eller flere takflater.</li>
                  <li>Høyreklikk på et trukket felt i kartet for å bytte det mellom Tak (Hovedområde) og Hindring (Ikke paneler).</li>
                  <li>Bruk saksen (✂️) i verktøylinjen for å kutte bygget langs mønet for å separere fallretninger!</li>
                  <li>Klikk på enkeltpaneler (blå) i kartet for å slette dem manuelt.</li>
                </ol>
              )}
            </div>
          </div>
          
          <div className="px-6 flex-grow pb-6">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <div className="animate-spin rounded-sm h-6 w-6 border-b-2 border-primary mb-4"></div>
                <p className="text-[10px] font-bold uppercase tracking-widest leading-relaxed">Systemet kalkulerer<br/>optimal dekning...</p>
              </div>
            ) : simulationData ? (
              <Dashboard data={simulationData} targetLocation={targetLocation} />
            ) : (
              <div className="h-48 flex items-center justify-center text-muted-foreground text-center px-8 border-2 border-dashed border-border rounded-md">
                <span className="text-[10px] font-bold uppercase tracking-widest leading-relaxed opacity-70">Ingen bygningsflater definert.<br/>Tegn polygonet for å starte.</span>
              </div>
            )}
          </div>
        </aside>

        {/* Right Map Area */}
          <section className="flex-1 relative bg-muted overflow-hidden">
             <MapComponent clearTrigger={clearMapTrigger} onPolygonDrawn={handleSimulate} panels={simulationData?.panels || []} targetLocation={targetLocation} simulationData={simulationData} fetchedBuilding={fetchedBuilding} onPanelClick={handlePanelRemove} />
          </section>
        </main>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-20 right-6 p-4 rounded-md shadow-lg flex items-center gap-3 z-[4000] animate-in slide-in-from-top-5 fade-in duration-300 ${toast.type === 'error' ? 'bg-destructive/10 text-destructive border border-destructive/20' : 'bg-primary/10 text-primary border border-primary/20'}`}>
          {toast.type === 'error' ? (
             <svg className="w-5 h-5 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
          ) : (
             <svg className="animate-spin w-5 h-5 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          )}
          <span className="text-sm font-medium pr-4">{toast.message}</span>
          <button onClick={() => setToast(null)} className="opacity-50 hover:opacity-100 transition-opacity">✕</button>
        </div>
      )}
    </div>
  );
}
