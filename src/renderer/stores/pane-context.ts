import { createContext } from 'react';

/**
 * Set by a split pane so `useActiveTab` / `useActiveTabSelect` inside it
 * read that pane's tab instead of the session-wide active tab. `null`
 * (the default, and always the case without a split) means "use the
 * session's active tab".
 */
export const PaneTabContext = createContext<string | null>(null);
