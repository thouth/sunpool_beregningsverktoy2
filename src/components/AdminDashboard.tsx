import React, { useEffect, useState } from 'react';
import { db } from '../services/firebase';
import { collection, query, getDocs, orderBy } from 'firebase/firestore';

export default function AdminDashboard({ onMapRequested }: { onMapRequested: () => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProjects() {
      try {
        const q = query(collection(db, 'projects'), orderBy('createdAt', 'desc'));
        const querySnapshot = await getDocs(q);
        const fetched = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setProjects(fetched);
      } catch (err) {
        console.error("Error fetching projects", err);
      } finally {
        setLoading(false);
      }
    }
    fetchProjects();
  }, []);

  return (
    <div className="w-full h-full bg-background flex flex-col p-8 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Admin Panel (CRM)</h1>
          <p className="text-sm text-muted-foreground">Oversikt over alle genererte prosjekter (Leads).</p>
        </div>
        <button 
          onClick={onMapRequested}
          className="px-4 py-2 border border-border bg-background font-semibold text-foreground hover:bg-muted rounded-md shadow-sm text-sm transition-colors"
        >
          Tilbake til Kalkulator
        </button>
      </div>

      <div className="bg-background rounded-md border border-border shadow-sm overflow-hidden">
        <table className="w-full text-left text-sm text-foreground">
          <thead className="bg-muted/50 border-b border-border text-xs uppercase font-bold text-muted-foreground">
            <tr>
              <th className="px-6 py-4">Dato</th>
              <th className="px-6 py-4">Adresse</th>
              <th className="px-6 py-4">Bruker (E-post)</th>
              <th className="px-6 py-4">kWp Tot</th>
              <th className="px-6 py-4">Produksjon</th>
              <th className="px-6 py-4">Capex Netto</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                 <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                   <svg className="animate-spin w-6 h-6 mx-auto mb-2 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                   Laster data...
                 </td>
              </tr>
            ) : projects.length === 0 ? (
              <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">Ingen prosjekter lagret i systemet ennå.</td></tr>
            ) : projects.map(p => {
               const sim = p.simulationData;
               const dateStr = p.createdAt?.toDate ? p.createdAt.toDate().toLocaleDateString('no-NO') : '-';
               return (
                 <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors">
                   <td className="px-6 py-4 font-medium text-foreground">{dateStr}</td>
                   <td className="px-6 py-4 font-semibold text-primary">{p.address}</td>
                   <td className="px-6 py-4">{p.userEmail || '-'}</td>
                   <td className="px-6 py-4 font-mono">{sim?.totalKwp || '-'} kWp</td>
                   <td className="px-6 py-4 font-mono">{sim?.yearlyProductionKwh ? `${sim.yearlyProductionKwh} kWh` : '-'}</td>
                   <td className="px-6 py-4 font-mono font-medium">{sim?.economics?.netCost ? `${sim.economics.netCost.toLocaleString('no-NO')} kr` : '-'}</td>
                 </tr>
               );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
