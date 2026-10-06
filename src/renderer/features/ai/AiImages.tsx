import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { type AiImage, formatImageSize } from '@/lib/ai-images';
import { cn } from '@/lib/cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

/** "name · 1568 × 980 · 214 KB", plus the GIF note. Also the tile's tooltip. */
export function imageLabel(img: AiImage): string {
  const dims = img.width && img.height ? ` · ${img.width} × ${img.height}` : '';
  const gif = img.firstFrameOnly ? ' · GIF: first frame only' : '';
  return `${img.name}${dims} · ${formatImageSize(img.size)}${gif}`;
}

/**
 * A full-size look at one of a message's images (Radix dialog: Esc closes,
 * focus returns to the tile). Left and right arrows step through the others.
 */
export function ImagePreview({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: AiImage[];
  /** The image shown, or null while closed. */
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const img = index === null ? undefined : images[index];
  // Keep the last image on screen while the dialog fades out.
  const [shown, setShown] = useState<AiImage | undefined>(img);
  useEffect(() => {
    if (img) setShown(img);
  }, [img]);
  const step = (d: number) => {
    if (index === null || images.length < 2) return;
    onIndex((index + d + images.length) % images.length);
  };
  const cur = img ?? shown;
  return (
    <Dialog open={img !== undefined} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        hideClose={false}
        data-testid="ai-image-preview"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') step(-1);
          else if (e.key === 'ArrowRight') step(1);
        }}
        className="w-auto max-w-[min(94vw,980px)] gap-2 bg-[var(--wb-content)] p-2 pt-2"
      >
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        <DialogDescription className="sr-only">
          {cur ? imageLabel(cur) : 'Attached image'}
        </DialogDescription>
        {cur && (
          <div className="grid place-items-center overflow-hidden rounded-[8px] bg-[var(--wb-field)]">
            <img
              src={cur.dataUrl}
              alt={cur.name}
              className="max-h-[78vh] max-w-full object-contain"
              draggable={false}
            />
          </div>
        )}
        <div className="flex min-h-6 items-center gap-2 pl-1 pr-7 text-[12px] text-[var(--wb-text-2)]">
          <span className="min-w-0 flex-1 truncate">{cur ? imageLabel(cur) : ''}</span>
          {images.length > 1 && index !== null && (
            <span className="flex shrink-0 items-center gap-0.5">
              <StepButton label="Previous image" onClick={() => step(-1)}>
                <ChevronLeft />
              </StepButton>
              <span className="min-w-[2.5em] text-center tabular-nums text-[var(--wb-text-3)]">
                {index + 1} / {images.length}
              </span>
              <StepButton label="Next image" onClick={() => step(1)}>
                <ChevronRight />
              </StepButton>
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded-[6px] text-[var(--wb-text-2)] transition-colors hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {children}
    </button>
  );
}

/** The images of a sent message, above its text; a click opens the preview. */
export function ImageGrid({ images }: { images: AiImage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const single = images.length === 1;
  return (
    <>
      <div
        className={cn('flex flex-wrap gap-1.5', 'mb-1.5 justify-end')}
        data-testid="ai-turn-images"
      >
        {images.map((img, i) => (
          <button
            key={img.id}
            type="button"
            data-testid="ai-turn-image"
            aria-label={`Open image ${i + 1} of ${images.length}: ${img.name}`}
            title={imageLabel(img)}
            onClick={() => setOpen(i)}
            className={cn(
              'overflow-hidden rounded-[8px] bg-[var(--wb-field)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--wb-text)_12%,transparent)] transition-[filter,transform] duration-150',
              'cursor-zoom-in hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]',
              single ? 'max-h-[150px] max-w-full' : 'h-14 w-14',
            )}
          >
            <img
              src={img.dataUrl}
              alt={img.name}
              draggable={false}
              className={cn(
                single ? 'max-h-[150px] max-w-full object-contain' : 'h-full w-full object-cover',
              )}
            />
          </button>
        ))}
      </div>
      <ImagePreview images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}
