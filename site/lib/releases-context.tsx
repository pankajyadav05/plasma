'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Releases } from './version';

const EMPTY: Releases = { win: null, mac: null, linux: null, latestVersion: null };
const ReleasesContext = createContext<Releases>(EMPTY);

/** Hands the build-time releases (fetched on the server) to client components. */
export function ReleasesProvider({ releases, children }: { releases: Releases; children: ReactNode }) {
  return <ReleasesContext.Provider value={releases}>{children}</ReleasesContext.Provider>;
}

export function useReleases(): Releases {
  return useContext(ReleasesContext);
}
