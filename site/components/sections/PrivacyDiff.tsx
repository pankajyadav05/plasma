'use client';

import { useEffect, useRef, useState } from 'react';
import { InstrumentFrame } from '@/components/instrument-frame';
import { Reveal } from '@/components/reveal';

interface Packet {
  ts: string;
  proto: string;
  endpoint: string;
  event: string;
  bytes: number;
}

const COMPETITOR_PACKETS: Omit<Packet, 'ts'>[] = [
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/launch', event: 'session_start', bytes: 412 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'tab_open', bytes: 188 },
  { proto: 'HTTPS', endpoint: 'lic.vendor.io/check', event: 'license_ping', bytes: 322 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'connection_added', bytes: 564 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'schema_introspect', bytes: 1240 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'query_executed', bytes: 218 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'query_executed', bytes: 224 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/error', event: 'syntax_err · sql', bytes: 488 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'editor_keystroke_avg', bytes: 96 },
  { proto: 'HTTPS', endpoint: 'cdn.vendor.io/banner', event: 'upgrade_nag · v8', bytes: 14_220 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'tab_open', bytes: 188 },
  { proto: 'HTTPS', endpoint: 'lic.vendor.io/heartbeat', event: 'license_ping', bytes: 312 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'export_csv', bytes: 142 },
  { proto: 'HTTPS', endpoint: 'tel.vendor.io/v2/event', event: 'tab_close', bytes: 168 },
];

function nextTs(prev: string | null): string {
  const base = prev ? Date.parse('2026-01-01T' + prev + 'Z') : Date.parse('2026-01-01T08:30:00Z');
  const d = new Date(base + 800 + Math.random() * 2200);
  return d.toISOString().slice(11, 19);
}

/**
 * Privacy Diff — split Wireshark-style packet log. Plasma side stays
 * empty (because that's the truth). Competitor side auto-streams
 * realistic-looking telemetry packets with a running bytes counter.
 */
export function PrivacyDiff() {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [bytes, setBytes] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const armedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) armedRef.current = true;
          else armedRef.current = false;
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const seed = COMPETITOR_PACKETS.slice(0, 8).map((p, i) => ({
        ...p,
        ts: '08:30:' + String(i * 3).padStart(2, '0'),
      }));
      setPackets(seed);
      setBytes(seed.reduce((s, p) => s + p.bytes, 0));
      return;
    }
    let cancelled = false;
    let i = 0;
    let lastTs: string | null = null;
    const loop = () => {
      if (cancelled) return;
      if (armedRef.current) {
        const next = COMPETITOR_PACKETS[i % COMPETITOR_PACKETS.length];
        const ts = nextTs(lastTs);
        lastTs = ts;
        const pkt = { ...next, ts };
        setPackets((p) => [...p.slice(-13), pkt]);
        setBytes((b) => b + next.bytes);
        i += 1;
      }
      const delay = 700 + Math.random() * 900;
      setTimeout(loop, delay);
    };
    setTimeout(loop, 800);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      id="privacy"
      ref={ref}
      className="relative px-4 md:px-8 py-[14vh] border-b border-line-strong"
    >
      <div className="mx-auto max-w-[1440px]">
        <Reveal>
          <div className="grid grid-cols-12 gap-6 mb-12 items-end">
            <div className="col-span-12 md:col-span-9">
              <div className="sec-no mb-5">¶ 08 — Privacy diff</div>
              <h2
                className="font-display leading-[0.92] tracking-[-0.04em]"
                style={{
                  fontSize: 'clamp(40px, 7vw, 120px)',
                  fontVariationSettings: '"opsz" 96, "wdth" 100, "wght" 700',
                }}
              >
                Watch the{' '}
                <span className="text-plasma">network</span>.
              </h2>
              <p className="mt-4 text-fg/70 max-w-[60ch] font-sans text-[16px] leading-relaxed">
                Side-by-side packet capture, simulated. One client sits silent.
                The other is busy. The names are made up; the patterns are not.
              </p>
            </div>
            <div className="col-span-12 md:col-span-3 self-end label">
              recording · since launch <br />
              filter · outbound only <br />
              source · live observation
            </div>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-line-strong border border-line-strong">
          {/* PLASMA pane */}
          <div className="bg-bg-2 p-6 md:p-8 relative">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <span className="block h-2 w-2 rounded-full bg-plasma shadow-[0_0_10px_var(--plasma)]" />
                <span className="label label-strong">plasma</span>
                <span className="label">→ outbound</span>
              </div>
              <span className="label label-plasma tabular-nums">0 B</span>
            </div>

            <div className="font-mono text-[12px] text-dim grid grid-cols-12 gap-2 pb-2 border-b border-line label">
              <span className="col-span-2">time</span>
              <span className="col-span-2">proto</span>
              <span className="col-span-5">endpoint</span>
              <span className="col-span-3 text-right">bytes</span>
            </div>

            <div className="relative h-[420px] mt-2">
              {/* Empty state */}
              <div className="absolute inset-0 grid place-items-center">
                <div className="text-center">
                  <div
                    className="font-display text-plasma glow-plasma leading-none"
                    style={{
                      fontSize: 'clamp(96px, 14vw, 200px)',
                      fontVariationSettings:
                        '"opsz" 96, "wdth" 200, "wght" 800',
                      letterSpacing: '-0.06em',
                    }}
                  >
                    0
                  </div>
                  <div className="label mt-4 label-strong">
                    bytes · since cold start
                  </div>
                  <div className="label mt-1">
                    no outbound · no telemetry · no license check
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-2 pt-3 border-t border-line label flex items-center justify-between">
              <span>
                <span className="label-plasma">● </span>
                stable · packets dropped: 0
              </span>
              <span>tail · live</span>
            </div>
          </div>

          {/* OTHERS pane */}
          <div className="bg-bg-2 p-6 md:p-8 relative">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <span className="block h-2 w-2 rounded-full bg-red shadow-[0_0_10px_var(--red)] animate-pulse" />
                <span className="label label-strong">the others</span>
                <span className="label">→ outbound</span>
              </div>
              <span className="label text-red tabular-nums">
                {(bytes / 1024).toFixed(1)} KB
              </span>
            </div>

            <div className="font-mono text-[12px] text-dim grid grid-cols-12 gap-2 pb-2 border-b border-line label">
              <span className="col-span-2">time</span>
              <span className="col-span-2">proto</span>
              <span className="col-span-5">endpoint</span>
              <span className="col-span-3 text-right">bytes</span>
            </div>

            <div
              className="relative h-[420px] mt-2 overflow-hidden font-mono text-[12px]"
              style={{
                maskImage:
                  'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
                WebkitMaskImage:
                  'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
              }}
            >
              <div className="space-y-1.5 py-3">
                {packets.length === 0 ? (
                  <div className="text-dim">listening…</div>
                ) : (
                  packets.map((p, i) => (
                    <div
                      key={`${p.ts}-${i}`}
                      className="grid grid-cols-12 gap-2 items-baseline animate-[fadeIn_0.5s_ease-out]"
                    >
                      <span className="col-span-2 tabular-nums text-fg/60">
                        {p.ts}
                      </span>
                      <span className="col-span-2 text-faint">{p.proto}</span>
                      <span className="col-span-5 text-fg/85 truncate">
                        {p.endpoint}
                        <span className="text-dim"> · {p.event}</span>
                      </span>
                      <span className="col-span-3 text-right tabular-nums text-red">
                        {p.bytes.toLocaleString()} B
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="mt-2 pt-3 border-t border-line label flex items-center justify-between">
              <span>
                <span className="text-red">● </span>
                streaming · {packets.length} packets visible
              </span>
              <span className="tabular-nums">
                {(bytes / 1024).toFixed(1)} KB total
              </span>
            </div>
          </div>
        </div>

        <Reveal as="div" className="mt-8 flex items-baseline justify-between label">
          <span>
            <span className="label-plasma">tip · </span>
            verify with little snitch / wireshark · packet log under settings
          </span>
          <span>method · simulated · pattern from public sdk docs</span>
        </Reveal>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </section>
  );
}
