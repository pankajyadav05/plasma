import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { QueryResult } from '@shared/protocol';
import { Map as MapIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Tiny PostGIS preview. Auto-detects geometry/geography columns and
 * renders any GeoJSON values it can parse into a bbox-fit SVG viewport.
 *
 * Detection: column dataType matches `geometry` / `geography`. We only
 * understand GeoJSON output (i.e. the user must wrap the column in
 * `ST_AsGeoJSON(geom)` for now). For raw WKB hex we surface a hint
 * rather than parsing — proper WKB support is a follow-up.
 */
export function PostGisDialog({
  result,
  open,
  onOpenChange,
}: {
  result: QueryResult | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const geomCols = useMemo(
    () =>
      (result?.columns ?? [])
        .filter(
          (c) =>
            /geometry|geography/i.test(c.dataTypeName) ||
            // Cells emitted via ST_AsGeoJSON come back as text/json — let
            // the user pick those manually if they don't carry a geom OID.
            c.dataTypeName === 'text' ||
            c.dataTypeName === 'json' ||
            c.dataTypeName === 'jsonb',
        )
        .map((c) => c.name),
    [result],
  );
  const [pickedCol, setPickedCol] = useState<string>(geomCols[0] ?? '');

  const features = useMemo(() => {
    if (!result || !pickedCol) return [];
    const idx = result.columns.findIndex((c) => c.name === pickedCol);
    if (idx === -1) return [];
    const out: GeoJsonGeom[] = [];
    for (const row of result.rows) {
      const v = row[idx];
      if (!v) continue;
      const geom = tryParseGeoJson(v);
      if (geom) out.push(geom);
    }
    return out;
  }, [result, pickedCol]);

  const bbox = useMemo(() => computeBbox(features), [features]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-primary" />
            Map preview
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <span className="font-display text-xs uppercase tracking-wider text-muted-foreground">
            Geometry column
          </span>
          <Select value={pickedCol} onValueChange={setPickedCol}>
            <SelectTrigger className="h-8 w-[240px] text-xs">
              <SelectValue placeholder="Pick a column…" />
            </SelectTrigger>
            <SelectContent>
              {result?.columns.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name} <span className="ml-1 text-muted-foreground">({c.dataTypeName})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-2 font-display text-xs italic text-muted-foreground">
            wrap in <code>ST_AsGeoJSON(geom)</code> if needed
          </span>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-2">
          {features.length === 0 ? (
            <div className="flex h-[360px] items-center justify-center font-display text-sm italic text-muted-foreground">
              No GeoJSON features found in the selected column.
            </div>
          ) : (
            <MapSvg features={features} bbox={bbox} />
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {features.length} feature{features.length === 1 ? '' : 's'} ·{' '}
          {bbox && (
            <span className="font-mono">
              bbox [{bbox.minX.toFixed(2)}, {bbox.minY.toFixed(2)}] → [{bbox.maxX.toFixed(2)},{' '}
              {bbox.maxY.toFixed(2)}]
            </span>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── geometry types ────────────────────────────────────────────────────

type Pt = [number, number];

interface PointGeom {
  kind: 'Point';
  coords: Pt;
}
interface LineGeom {
  kind: 'LineString';
  coords: Pt[];
}
interface PolyGeom {
  kind: 'Polygon';
  coords: Pt[][];
}
interface MultiPointGeom {
  kind: 'MultiPoint';
  coords: Pt[];
}
interface MultiLineGeom {
  kind: 'MultiLineString';
  coords: Pt[][];
}
interface MultiPolyGeom {
  kind: 'MultiPolygon';
  coords: Pt[][][];
}

type GeoJsonGeom = PointGeom | LineGeom | PolyGeom | MultiPointGeom | MultiLineGeom | MultiPolyGeom;

function tryParseGeoJson(v: unknown): GeoJsonGeom | null {
  if (v == null) return null;
  let obj: unknown;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  } else if (typeof v === 'object') {
    obj = v;
  } else {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { type?: unknown; coordinates?: unknown; geometry?: unknown };
  if (o.type === 'Feature' && o.geometry && typeof o.geometry === 'object') {
    return tryParseGeoJson(o.geometry);
  }
  if (typeof o.type !== 'string' || o.coordinates === undefined) return null;
  switch (o.type) {
    case 'Point':
      return { kind: 'Point', coords: o.coordinates as Pt };
    case 'LineString':
      return { kind: 'LineString', coords: o.coordinates as Pt[] };
    case 'Polygon':
      return { kind: 'Polygon', coords: o.coordinates as Pt[][] };
    case 'MultiPoint':
      return { kind: 'MultiPoint', coords: o.coordinates as Pt[] };
    case 'MultiLineString':
      return { kind: 'MultiLineString', coords: o.coordinates as Pt[][] };
    case 'MultiPolygon':
      return { kind: 'MultiPolygon', coords: o.coordinates as Pt[][][] };
    default:
      return null;
  }
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBbox(features: GeoJsonGeom[]): BBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const visit = (p: Pt) => {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };
  for (const f of features) walk(f, visit);
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function walk(geom: GeoJsonGeom, fn: (p: Pt) => void): void {
  switch (geom.kind) {
    case 'Point':
      fn(geom.coords);
      return;
    case 'MultiPoint':
    case 'LineString':
      for (const p of geom.coords) fn(p);
      return;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coords) for (const p of ring) fn(p);
      return;
    case 'MultiPolygon':
      for (const poly of geom.coords) for (const ring of poly) for (const p of ring) fn(p);
      return;
  }
}

function MapSvg({ features, bbox }: { features: GeoJsonGeom[]; bbox: BBox | null }) {
  const W = 720;
  const H = 360;
  if (!bbox) return null;
  // Pad bbox so points don't sit on the edge.
  const padX = (bbox.maxX - bbox.minX) * 0.05 || 1;
  const padY = (bbox.maxY - bbox.minY) * 0.05 || 1;
  const minX = bbox.minX - padX;
  const minY = bbox.minY - padY;
  const w = bbox.maxX + padX - minX;
  const h = bbox.maxY + padY - minY;
  const sx = W / w;
  const sy = H / h;
  const s = Math.min(sx, sy);
  const project = ([x, y]: Pt): [number, number] => [
    (x - minX) * s,
    H - (y - minY) * s, // flip y so north is up
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[360px] w-full" role="img" aria-label="Map">
      <title>Map preview</title>
      <rect x={0} y={0} width={W} height={H} className="fill-background" />
      {features.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: feature order is stable per query
        <FeatureSvg key={i} feature={f} project={project} />
      ))}
    </svg>
  );
}

function FeatureSvg({
  feature,
  project,
}: {
  feature: GeoJsonGeom;
  project: (p: Pt) => [number, number];
}) {
  const stroke = 'oklch(0.55 0.15 240)';
  const fill = 'oklch(0.55 0.15 240 / 0.18)';
  switch (feature.kind) {
    case 'Point': {
      const [x, y] = project(feature.coords);
      return <circle cx={x} cy={y} r={3} fill={stroke} />;
    }
    case 'MultiPoint':
      return (
        <>
          {feature.coords.map((p, i) => {
            const [x, y] = project(p);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: vertex order is stable
              <circle key={i} cx={x} cy={y} r={3} fill={stroke} />
            );
          })}
        </>
      );
    case 'LineString':
      return (
        <path d={pathFor(feature.coords, project)} fill="none" stroke={stroke} strokeWidth={1.5} />
      );
    case 'MultiLineString':
      return (
        <>
          {feature.coords.map((ls, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ring order is stable
            <path key={i} d={pathFor(ls, project)} fill="none" stroke={stroke} strokeWidth={1.5} />
          ))}
        </>
      );
    case 'Polygon':
      return (
        <path
          d={feature.coords.map((r) => pathFor(r, project)).join(' ')}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.2}
        />
      );
    case 'MultiPolygon':
      return (
        <>
          {feature.coords.map((poly, i) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: polygon order is stable
              key={i}
              d={poly.map((r) => pathFor(r, project)).join(' ')}
              fill={fill}
              stroke={stroke}
              strokeWidth={1.2}
            />
          ))}
        </>
      );
  }
}

function pathFor(ring: Pt[], project: (p: Pt) => [number, number]): string {
  return ring
    .map((p, i) => {
      const [x, y] = project(p);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
