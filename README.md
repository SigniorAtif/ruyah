# ruyah

Watch the same film together, from two different places, each playing your own
copy of the file.

Nothing but timing crosses the network — a position, a play, a pause, a clock
ping. The video never leaves your machine, is never uploaded, and never passes
through a server.

## Why

Streaming a film to someone else is the obvious approach and the wrong one. It
needs upload bandwidth you probably do not have, it re-encodes something you
already have at better quality, and it puts a copy of your file on somebody
else's computer.

If you both already have the file, the only thing genuinely missing is
agreement about *when*. That is a tiny problem: a few dozen bytes every few
seconds. So ruyah synchronises the clock instead of the content.

The consequences are worth stating plainly:

- **The file never moves.** No upload, no transcode, no third party holding it.
- **Quality is whatever your own copy is.** No streaming ladder, no artefacts.
- **The relay cannot see anything interesting.** It forwards opaque timing
  messages between two sockets. There is no video, no account, and nothing
  written to disk.
- **The bandwidth is trivial** — a few hundred kilobytes for a whole film,
  against tens of gigabytes to stream one.

## How it works

Two clients, one dumb relay.

```
  you                        relay                      them
  ├── <video> local file     ├── rooms (in memory)      ├── <video> local file
  ├── PlayerEngine           ├── verbatim message relay ├── PlayerEngine
  └── clock sync ────────────┤ stamps ping/pong         ├──────── clock sync
                             └── no video, no storage
```

- **Clock sync.** Both clients estimate their offset to the *relay's* clock
  with a burst of ping/pong samples, discarding the worst half by round-trip
  time. Every scheduled action is expressed on that shared timeline, so two
  machines with drifting system clocks still act at the same instant.
- **Scheduled execution.** Play and seek are not "do it now" — they carry an
  `executeAt` a few hundred milliseconds in the future, so both sides start
  together instead of one lagging by the network delay.
- **Differential resume.** If one of you is ahead when you pause, resuming does
  not seek anybody. The one who is ahead simply waits out their lead. Nobody is
  ever dragged forward over footage they have not seen.
- **Drift correction.** One client is the authority and plays normally; the
  other corrects. Small drift is absorbed by nudging playback rate to 0.98 or
  1.02 — imperceptible. A hard seek only happens after three consecutive
  heartbeats agree the gap is over a second, because a seek is visible and
  jitter must never cause one.

The relay is deliberately stupid. It holds rooms, forwards bytes unmodified,
and answers pings. It does not know what a video is.

## Running it locally

Requires Node 20+.

```bash
# 1. the relay
cd server
npm install
node index.js            # ws://127.0.0.1:8080/ws

# 2. the app
cd ..
npm install
npm run dev              # http://localhost:3000
```

Open the app, click **Advanced**, and set the relay address to
`ws://localhost:8080/ws`. Both people need the same film file, and the same
encode — ruyah fingerprints the file and warns you if they differ, because two
different rips have different timestamps and syncing them is meaningless.

### Testing without a relay

Visit `http://localhost:3000/?dev=1` once to turn on dev mode. Then leave the
relay field **empty** and two tabs in the same browser will talk to each other
over `BroadcastChannel`, with a network simulator (latency, jitter, packet
loss, and a cable-pull toggle) in the dev panel.

Use two separate windows rather than two tabs. Background tabs get their timers
throttled by the browser, which breaks scheduled playback in ways that look
like real bugs and are not.

## Configuration

There is no build-time configuration. The frontend is a static bundle that
takes its relay address at runtime, so the same build works against any relay.

To change the default for your own deployment, edit one line:

```ts
// lib/relayConfig.ts
export const DEFAULT_RELAY_URL = 'wss://your-relay.example.com/ws';
```

Anyone can override it in the UI under **Advanced**; the last value used is
remembered in `localStorage`.

Relay addresses must be `wss://`. A browser refuses a plain `ws://` socket from
an HTTPS page and fails silently when you try, which is a genuinely miserable
thing to debug — so the app rejects it up front and says why. (In dev mode
`ws://localhost` is allowed, since browsers treat loopback as a secure context.)

## Deploying

### The frontend

It exports to static files. Any static host will do.

```bash
npm run build     # → out/
```

### The relay

Node and one dependency (`ws`). It holds no state worth preserving — rooms live
in memory and a restart costs a 90-second room grace period — so
`Restart=always` under systemd is the whole operational story.

```ini
# /etc/systemd/system/ruyah-relay.service
[Unit]
Description=ruyah sync relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/ruyah/server/index.js
Environment=RUYAH_HOST=127.0.0.1
Environment=RUYAH_PORT=8080
Restart=always
User=ruyah

[Install]
WantedBy=multi-user.target
```

Put TLS in front of it. Caddy needs about four lines and renews certificates on
its own:

```
your-relay.example.com {
    reverse_proxy /ws localhost:8080
    reverse_proxy localhost:3000
}
```

The relay binds to `127.0.0.1` by default, on purpose: TLS terminates at the
proxy, and binding `0.0.0.0` would expose the relay directly, past the
certificate.

## Two things that will cost you an evening

Both of these fail the same miserable way — the connection just hangs, with no
error in the browser and no log line on the server.

**1. Oracle Cloud has two firewalls, and opening one is not enough.**

There is the **VCN security list** in the web console, and there is the
instance's **own firewall**. You must open both.

```bash
# on the instance
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --reload
```

Opening only the console-side rule gives you a port that accepts a TCP
connection and then goes silent. This is the single most common way this stalls.

**2. SELinux on Oracle Linux 9 blocks the proxy from connecting outbound.**

Caddy (or nginx) will fail to reach the Node process on localhost, and the
denial is not obvious from the proxy's own logs:

```bash
sudo setsebool -P httpd_can_network_connect 1
```

Without it the proxy returns a gateway error for every WebSocket upgrade while
the relay sits there perfectly healthy, logging nothing, because nothing ever
reached it.

## Privacy

- No accounts, no database, nothing written to disk.
- The relay logs connections, never message contents. Room codes and user
  identifiers are logged as short digests, because a room code is the only
  access control in the system and a display name is a real person's name.
- Room codes are generated with a CSPRNG from an alphabet with no `I`, `L`,
  `O`, `0` or `1` — they get read aloud, and rooms hold exactly two people.

## Licence

MIT. See [LICENSE](LICENSE).
