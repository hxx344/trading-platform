// The asset page's pause of the automatic sync while the workbook import panel is shown (A-6; the workbench's
// importOpenRef in dashboard.tsx). The panel holds the gate while it is mounted and releases it when it unmounts, however
// that happens (closed, another tab, the example notice gone), so the sync always resumes. Holding by mount rather than
// by the open flag also survives React StrictMode's mount, unmount, mount in development.
export type ImportGate = { readonly held: boolean; hold: () => () => void };

export function importGate(): ImportGate {
  let holders = 0;
  return {
    get held() { return holders > 0; },
    hold() {
      holders++;
      let released = false;
      return () => { if (!released) { released = true; holders--; } };
    },
  };
}
