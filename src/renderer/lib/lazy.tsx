import {
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
  lazy,
  useEffect,
  useState,
} from 'react';

/**
 * `React.lazy` for a module with named exports (the codebase never uses
 * default exports): `lazyNamed(() => import('./Foo'), 'Foo')`.
 */
export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyExoticComponent<M[K] extends ComponentType<infer P> ? ComponentType<P> : never> {
  return lazy(() => load().then((m) => ({ default: m[name] as never }))) as LazyExoticComponent<
    M[K] extends ComponentType<infer P> ? ComponentType<P> : never
  >;
}

/**
 * Mount-on-first-open gate for lazy dialogs. The chunk is only requested the
 * first time `open` is true; afterwards the dialog stays mounted so Radix
 * can run its close animation and keep its state.
 */
export function LazyOnOpen({
  open,
  children,
  fallback = null,
}: { open: boolean; children: ReactNode; fallback?: ReactNode }) {
  const [seen, setSeen] = useState(open);
  useEffect(() => {
    if (open) setSeen(true);
  }, [open]);
  if (!seen && !open) return null;
  return <Suspense fallback={fallback}>{children}</Suspense>;
}
