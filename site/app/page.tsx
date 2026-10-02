import { Topbar } from '@/components/topbar';
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
      <main id="main">
        <Hero captures={captures} />
        <Workbench captures={captures} />
        <Engines captures={captures} />
        <Guardrails />
        <Shortcuts />
        <Local />
        <Download />
        <FAQ />
      </main>
      <Footer />
    </>
  );
}
