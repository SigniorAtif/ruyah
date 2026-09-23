import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The badge sits on top of a full-bleed player wherever it is parked: the
  // play button bottom-left, the sync indicator top-right, the dev panel above
  // it. Compile and runtime errors still surface without it. Set it back to
  // `{ position: 'top-left' }` if you want the route indicator.
  devIndicators: false,
  // The frontend is a static bundle: no server, no build-time config, deployable
  // to any static host and pointed at a relay at runtime (see lib/relayConfig).
  output: 'export',
  compiler: {
    define: {
      // Whether the dev tools are compiled in: always under `next dev`, and in a
      // production build only with RUYAH_DEV_TOOLS=1. See lib/devTools.d.ts.
      __RUYAH_DEV_TOOLS__:
        process.env.NODE_ENV === 'development' || process.env.RUYAH_DEV_TOOLS === '1',
    },
  },
};

export default nextConfig;
