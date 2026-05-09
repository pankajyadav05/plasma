import { TopNav } from '@/components/nav';
import { Atlas } from '@/components/sections/Atlas';
import { Day } from '@/components/sections/Day';
import { ExplainTheatre } from '@/components/sections/ExplainTheatre';
import { FAQ } from '@/components/sections/FAQ';
import { Footer } from '@/components/sections/Footer';
import { Hero } from '@/components/sections/Hero';
import { Open } from '@/components/sections/Open';
import { Pillars } from '@/components/sections/Pillars';
import { PrivacyDiff } from '@/components/sections/PrivacyDiff';
import { Roadmap } from '@/components/sections/Roadmap';
import { Showcase } from '@/components/sections/Showcase';
import { Specs } from '@/components/sections/Specs';
import { Vault } from '@/components/sections/Vault';
import { Versus } from '@/components/sections/Versus';

export default function Page() {
  return (
    <>
      <TopNav />
      <main>
        <Hero />
        <Specs />
        <Showcase />
        <ExplainTheatre />
        <Day />
        <Pillars />
        <Vault />
        <PrivacyDiff />
        <Atlas />
        <Versus />
        <Roadmap />
        <FAQ />
        <Open />
      </main>
      <Footer />
    </>
  );
}
