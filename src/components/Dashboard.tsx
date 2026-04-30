import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function Dashboard({ data, targetLocation }: { data: any, targetLocation?: [number, number] }) {
  const { numPanels, totalKwp, production, economics, azimuth, lat, lon } = data;
  const [isExporting, setIsExporting] = useState(false);

  if (!economics) {
     return <div className="p-4 text-destructive text-sm font-semibold bg-destructive/10 border border-destructive/20 rounded-md">Kalkulering feilet eller takflaten er for liten. Minst 1 panel kreves.</div>
  }

  const { totalCapex, netCost, yearlySavings, roiYears } = economics;

  const formatNOK = (val: number) => new Intl.NumberFormat('no-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(val);

  const handleExportCSV = async () => {
    const targetLat = lat || (targetLocation ? targetLocation[0] : null);
    const targetLon = lon || (targetLocation ? targetLocation[1] : null);

    if (!targetLat || !targetLon) {
        alert("Kan ikke eksportere CSV uten en geografisk lokasjon. Tegn inn bygget på nytt for å kalibrere GPS.");
        return;
    }
    setIsExporting(true);
    try {
        const res = await fetch('/api/export-csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: targetLat,
                lon: targetLon,
                totalKwp,
                azimuth
            })
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Generering av historisk produksjon feilet');
        }
        
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `solproduksjon_timesverdier_${totalKwp}kWp.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (e: any) {
        console.error(e);
        alert(`Kunne ikke eksportere CSV-fil: ${e.message}`);
    } finally {
        setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-in fade-in duration-300 relative bg-background p-2">
      
      <div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Systemkonfigurasjon</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="p-3 bg-background border border-border rounded-md shadow-sm">
            <div className="text-2xl font-bold text-foreground">{numPanels} <span className="text-sm font-normal text-muted-foreground italic">stk</span></div>
            <div className="text-[10px] uppercase text-muted-foreground">Paneler ({data.layout || 'Auto'})</div>
          </div>
          <div className="p-3 bg-background border border-border rounded-md shadow-sm">
            <div className="text-2xl font-bold text-foreground">{totalKwp} <span className="text-sm font-normal text-muted-foreground italic">kWp</span></div>
            <div className="text-[10px] uppercase text-muted-foreground">Installert effekt</div>
          </div>
          <div className="p-3 bg-background border border-border rounded-md shadow-sm">
             <div className="text-2xl font-bold text-foreground">{data.yearlyProductionKwh} <span className="text-sm font-normal text-muted-foreground italic">kWh/år</span></div>
             <div className="text-[10px] uppercase text-muted-foreground">Produksjon</div>
          </div>
          <div className="p-3 bg-background border border-border rounded-md shadow-sm">
             <div className="text-2xl font-bold text-foreground">{(data.yearlyProductionKwh * 0.4 / 1000).toFixed(1)} <span className="text-sm font-normal text-muted-foreground italic">t CO2</span></div>
             <div className="text-[10px] uppercase text-muted-foreground">Miljøgevinst</div>
          </div>
          <div className="p-3 bg-background border border-border rounded-md shadow-sm col-span-2">
             <div className="text-lg font-bold text-foreground">{azimuth}° <span className="text-sm font-medium text-muted-foreground font-serif italic">SV</span></div>
             <div className="text-[10px] uppercase text-muted-foreground">Asimut (Retning)</div>
          </div>
        </div>
      </div>

      <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg">
        <div className="flex justify-between items-start mb-2">
          <h3 className="text-sm font-bold text-primary">Økonomisk Oversikt</h3>
        </div>
        <div className="space-y-2">
          <div className="flex justify-between text-base px-1 font-bold text-foreground">
            <span>Estimert Investering</span>
            <span>{formatNOK(totalCapex)}</span>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-4">Forventet Lønnsomhet</h2>
        <div className="space-y-4">
          <div className="flex justify-between p-4 bg-primary text-primary-foreground rounded-lg shadow-md">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-primary-foreground/80">Årlig Besparelse</div>
              <div className="text-xl font-bold">{formatNOK(yearlySavings)}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-primary-foreground/80">Nedbetalingstid</div>
              <div className="text-xl font-bold">{roiYears} År</div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-background border border-border rounded-md p-4 shadow-sm">
         <div className="flex justify-between items-center mb-4">
             <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Estimert Produksjon ({data.yearlyProductionKwh} kWh)</h3>
             <div className="flex items-center gap-2">
                 <button 
                     onClick={handleExportCSV}
                     disabled={isExporting}
                     className="text-[10px] bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 px-2 py-1 rounded shadow-sm transition-colors flex items-center gap-1 uppercase tracking-widest font-bold"
                 >
                     {isExporting ? (
                         <span className="flex items-center gap-1">
                             <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
                             Laster...
                         </span>
                     ) : (
                         <span className="flex items-center gap-1">
                             <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                             CSV
                         </span>
                     )}
                 </button>
             </div>
         </div>
         <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={production} margin={{ top: 0, right: 0, left: -25, bottom: -10 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis 
                  dataKey="month" 
                  tickFormatter={(m) => ['J','F','M','A','M','J','J','A','S','O','N','D'][m-1]} 
                  axisLine={false} 
                  tickLine={false}
                  fontSize={10}
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis axisLine={false} tickLine={false} fontSize={10} tick={{ fill: 'hsl(var(--muted-foreground))' }} />
                <Tooltip 
                  formatter={(val: number) => [`${Math.round(val)} kWh`, 'Produksjon']}
                  labelFormatter={(m: number) => ['Jan','Feb','Mar','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Des'][m-1]}
                  cursor={{ fill: 'hsl(var(--muted))' }}
                  contentStyle={{ borderRadius: '6px', borderColor: 'hsl(var(--border))', fontSize: '12px', backgroundColor: 'hsl(var(--background))', color: 'hsl(var(--foreground))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  itemStyle={{ color: 'hsl(var(--primary))', fontWeight: 'bold' }}
                />
                <Bar dataKey="kWh" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
         </div>
      </div>

      <div className="mt-auto text-[10px] text-muted-foreground italic leading-relaxed border-t border-border pt-4">
         * Regulering: Solceller på eksisterende skråtak er normalt unntatt søknadsplikt. For flate tak anses anlegget ofte som fasadeendring.<br/>
         * Simulering basert på PVGIS TMY værdata og gjennomsnittlig spotpris siste 12 mnd i NO5 inkl. estimert nettleie.
      </div>

    </div>
  );
}
