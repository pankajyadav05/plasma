import { TopNav } from '@/components/nav';
import { Atlas } from '@/components/sections/Atlas';
import { Footer } from '@/components/sections/Footer';
import { Hero } from '@/components/sections/Hero';
import { Open } from '@/components/sections/Open';
import { Showcase } from '@/components/sections/Showcase';
import { Versus } from '@/components/sections/Versus';

export default function Page() {
  return (
    <>
      <TopNav />
      <main>
        <Hero />
        <Showcase />
        <Atlas />
        <Versus />
        <Open />
      </main>
      <Footer />
    </>
  );
}
