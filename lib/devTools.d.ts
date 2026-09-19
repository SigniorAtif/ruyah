/**
 * Whether this build carries the dev tools: the network simulator and mock
 * transport, the instruments and network panels, the sync pill and the §8
 * dropout log.
 *
 * A compile-time constant, set in next.config.ts (`compiler.define`) and
 * replaced by a literal at every use. `next dev` always has them; a production
 * build has them only when built with `RUYAH_DEV_TOOLS=1`. Every dev-only
 * module is imported behind a check of this constant, so a build without it
 * drops them entirely rather than hiding them, and main and dev carry the same
 * source.
 *
 * Use it directly, not through a re-exported variable: a value read from a
 * shared module is not folded, and the dev code it guards would stay in.
 *
 * Inside a build that has them, the `?dev=1` flag (lib/relayConfig.ts) still
 * decides whether they show.
 */
declare const __RUYAH_DEV_TOOLS__: boolean;
