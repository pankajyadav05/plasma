import { PlateIndex } from '@/components/plate-index';
import { Topbar } from '@/components/topbar';
import { Assistant } from '@/components/sections/Assistant';
import { Dependable } from '@/components/sections/Dependable';
import { Mcp } from '@/components/sections/Mcp';
import { Download } from '@/components/sections/Download';
import { Engines } from '@/components/sections/Engines';
import { FAQ } from '@/components/sections/FAQ';
import { Footer } from '@/components/sections/Footer';
import { Guardrails } from '@/components/sections/Guardrails';
import { Hero } from '@/components/sections/Hero';
import { Local } from '@/components/sections/Local';
import { Shortcuts } from '@/components/sections/Shortcuts';
import { Workbench } from '@/components/sections/Workbench';
import { getCaptures } from '@/lib/captures';

export default function Page() {
  const captures = getCaptures();
  return (
    <>
      <Topbar />
      {/* Wide screens: the plate index on the left, the plates on the right. */}
      <div className="xl:grid xl:grid-cols-[184px_minmax(0,1fr)]">
        <PlateIndex />
        <main id="main" className="min-w-0">
          <Hero captures={captures} />
          <Workbench captures={captures} />
          <Assistant captures={captures} />
          <Mcp captures={captures} />
          <Guardrails />
          <Dependable captures={captures} />
          <Engines captures={captures} />
          <Shortcuts />
          <Local />
          <Download />
          <FAQ />
        </main>
      </div>
      <Footer />
    </>
  );
}
