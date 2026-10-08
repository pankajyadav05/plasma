import Image from 'next/image';
import { getCaptures, type CaptureKey } from '@/lib/captures';

/**
 * A real capture of the app (sample data). Reuses the images the homepage
 * uses; never a mockup. Pass `file` for the connection dialog capture.
 */
export function Shot({ k, caption }: { k: CaptureKey | 'connection-dialog'; caption: string }) {
  if (k === 'connection-dialog') {
    return (
      <figure className="my-8">
        <div className="mx-auto max-w-[460px] overflow-hidden rounded-[14px] border border-rule bg-paper-2 shadow-[0_30px_60px_-30px_rgba(22,21,15,0.25)]">
          <Image
            src="/product/connection-setup-light.webp"
            alt="The New connection dialog in the light theme, filled with example values."
            width={1152}
            height={1532}
            sizes="(min-width: 640px) 460px, 100vw"
            className="h-auto w-full"
          />
        </div>
        <figcaption className="label mt-3 text-center normal-case tracking-normal text-[12.5px]">
          {caption} Example values, no live connection.
        </figcaption>
      </figure>
    );
  }
  const c = getCaptures()[k];
  return (
    <figure className="my-8">
      <div className="overflow-hidden rounded-[14px] border border-rule bg-paper-2 shadow-[0_30px_60px_-30px_rgba(22,21,15,0.25)]">
        <Image
          src={c.src}
          alt={c.alt}
          width={c.width}
          height={c.height}
          sizes="(min-width: 1280px) 720px, (min-width: 768px) 70vw, 100vw"
          className="h-auto w-full"
        />
      </div>
      <figcaption className="label mt-3 normal-case tracking-normal text-[12.5px]">
        {caption} Capture of the real app with sample data.
      </figcaption>
    </figure>
  );
}
