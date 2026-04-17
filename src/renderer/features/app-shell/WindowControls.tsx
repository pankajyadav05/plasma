import { useEffect, useState } from "react";

/**
 * Custom Windows/Linux titlebar buttons (minimize / maximize / close).
 *
 * The window is created with `titleBarStyle: 'hidden'` and no
 * `titleBarOverlay`, so we own the entire top strip. These buttons
 * live inside the TopBar's flex row at the right edge and are plain
 * DOM, which means modal overlays can correctly paint above them.
 *
 * macOS is unaffected — `hiddenInset` keeps the native traffic lights,
 * so this component is rendered only on win32/linux (see TopBar).
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.plasma.window.isMaximized().then(setMaximized);
    const off = window.plasmaEvents.on("plasma:window:maximizedChanged", (value) => {
      setMaximized(Boolean(value));
    });
    return off;
  }, []);

  return (
    <div className="no-drag flex h-12 items-stretch self-stretch">
      <ControlButton
        onClick={() => void window.plasma.window.minimize()}
        ariaLabel="Minimize"
      >
        <MinimizeGlyph />
      </ControlButton>
      <ControlButton
        onClick={() => void window.plasma.window.maximizeToggle()}
        ariaLabel={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </ControlButton>
      <ControlButton
        onClick={() => void window.plasma.window.close()}
        ariaLabel="Close"
        danger
      >
        <CloseGlyph />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  onClick,
  ariaLabel,
  danger,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={
        "flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors " +
        (danger
          ? "hover:bg-win-close hover:text-white"
          : "hover:bg-[var(--bg-hover)] hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

// 10px SVG glyphs — matches the Windows 11 titlebar visual weight
// (1px stroke, centered, no fill).

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
