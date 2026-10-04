import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * One app-wide tooltip for every control, so icon-only buttons all get the
 * same themed, fast tooltip instead of the OS's slow native one.
 *
 * Text comes from (in order) `data-tooltip`, `title`, or — for controls
 * with no visible text — `aria-label`. While a tooltip is up the element's
 * `title` is parked in `data-plasma-title` so the native tooltip doesn't
 * double up; it is restored the moment the pointer leaves.
 *
 * A trailing "(⌘K)"-style suffix renders as a key chip.
 */

const TARGETS =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [data-tooltip]';
const PARKED = 'data-plasma-title';
const SHOW_DELAY = 450;
/** Moving between controls within this window skips the delay. */
const WARM_WINDOW = 400;
const GAP = 6;
const EDGE = 6;

const SHORTCUT_RE = /^(.*\S)\s+\(([^()]*(?:⌘|⇧|⌥|⌃|Ctrl|Shift|Alt|Esc|Enter|⏎)[^()]*)\)$/;

function textFor(el: HTMLElement): string | null {
  const explicit = el.dataset.tooltip ?? el.getAttribute('title') ?? el.getAttribute(PARKED);
  if (explicit?.trim()) return explicit.trim();
  const label = el.getAttribute('aria-label');
  // aria-label alone only when the control shows no text of its own.
  if (label?.trim() && !el.textContent?.replace(/\d/g, '').trim()) return label.trim();
  return null;
}

function park(el: HTMLElement) {
  const title = el.getAttribute('title');
  if (title === null) return;
  el.setAttribute(PARKED, title);
  el.removeAttribute('title');
}

function unpark(el: HTMLElement) {
  const parked = el.getAttribute(PARKED);
  if (parked === null) return;
  el.removeAttribute(PARKED);
  // React may have set a fresh title meanwhile — keep the newer one.
  if (!el.hasAttribute('title')) el.setAttribute('title', parked);
}

interface Tip {
  el: HTMLElement;
  text: string;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    /** Clicked element: no tooltip again until the pointer leaves it. */
    let suppressed: HTMLElement | null = null;
    let timer: number | undefined;
    let lastHidden = 0;
    let visible = false;
    let observer: MutationObserver | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      observer = null;
      if (visible) lastHidden = performance.now();
      visible = false;
      setTip(null);
    };

    const leave = () => {
      hide();
      if (current) unpark(current);
      current = null;
    };

    const show = (el: HTMLElement) => {
      const text = textFor(el);
      if (!text || !el.isConnected) return;
      park(el);
      visible = true;
      setTip({ el, text });
      observer = new MutationObserver(() => {
        if (el.hasAttribute('title')) park(el);
        const next = textFor(el);
        if (next) setTip({ el, text: next });
        else hide();
      });
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['title', 'aria-label', 'data-tooltip'],
      });
    };

    const enter = (el: HTMLElement) => {
      if (el === current) return;
      leave();
      if (el === suppressed) return;
      suppressed = null;
      if (!textFor(el)) return;
      current = el;
      const warm = performance.now() - lastHidden < WARM_WINDOW;
      timer = window.setTimeout(() => show(el), warm ? 0 : SHOW_DELAY);
    };

    const targetOf = (node: EventTarget | null) =>
      node instanceof Element ? (node.closest(TARGETS) as HTMLElement | null) : null;

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = targetOf(e.target);
      if (el) enter(el);
    };
    const onOut = (e: PointerEvent) => {
      const from = targetOf(e.target);
      const to = targetOf(e.relatedTarget);
      if (from && from === to) return;
      if (from === suppressed) suppressed = null;
      if (!to && current) leave();
    };
    const onDown = () => {
      suppressed = current;
      leave();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = targetOf(e.target);
      if (el?.matches(':focus-visible')) enter(el);
    };
    const onFocusOut = () => {
      if (current && !current.matches(':hover')) leave();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!['Tab', 'Shift'].includes(e.key)) hide();
    };

    // Element vanished from under the pointer (tab closed, panel swapped).
    const sweep = window.setInterval(() => {
      if (current && !current.isConnected) leave();
    }, 250);

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', leave);
    return () => {
      leave();
      window.clearInterval(sweep);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', leave);
    };
  }, []);

  // Below the control by default; above when there's no room. Clamped to the window.
  useLayoutEffect(() => {
    if (!tip || !bubble.current) {
      setPos(null);
      return;
    }
    const anchor = tip.el.getBoundingClientRect();
    const box = bubble.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + GAP;
    if (top + box.height > vh - EDGE) top = anchor.top - GAP - box.height;
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - box.width / 2, EDGE),
      vw - box.width - EDGE,
    );
    setPos({ left, top: Math.max(top, EDGE) });
  }, [tip]);

  if (!tip) return null;
  const match = SHORTCUT_RE.exec(tip.text);
  const label = match ? match[1] : tip.text;
  const keys = match?.[2];

  return createPortal(
    <div
      ref={bubble}
      role="tooltip"
      className="pointer-events-none fixed z-[1000] flex max-w-[320px] items-center gap-1.5 rounded-[6px] border border-[var(--wb-toolbar-group-edge)] bg-popover px-2 py-1 text-[12px] leading-[16px] text-popover-foreground shadow-md"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span className="break-words">{label}</span>
      {keys && (
        <kbd className="shrink-0 rounded-[4px] bg-[var(--wb-control)] px-1 font-mono text-[11px] text-[var(--wb-text-2)]">
          {keys}
        </kbd>
      )}
    </div>,
    document.body,
  );
}
