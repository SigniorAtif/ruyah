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
  /* config options here */
};

export default nextConfig;
