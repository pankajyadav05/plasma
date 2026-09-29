/**
 * Bundled UI fonts (V9 / VF1). Every face offered in Settings → Fonts &
 * Themes ships inside the renderer bundle, so nothing is fetched from a
 * font CDN (the CSP blocks those, and offline users would get fallbacks).
 * The browser only downloads a woff2 subset when a family is in use.
 */
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/inter';
import '@fontsource-variable/outfit';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
