## What this changes

<!-- One paragraph. What behaviour is different, and why. -->

## Why

<!-- The problem being fixed. Link an issue if there is one. -->

## How it was verified

- [ ] `npx tsc --noEmit`
- [ ] `npx eslint .`
- [ ] `npm run build`
- [ ] Exercised against a real relay with two windows

<!-- If it touches sync, say what you measured: drift, RTT, offset, dropout. -->

## Notes for the reviewer

<!-- Anything unobvious: a tradeoff taken, something deliberately left out. -->

---

**Targeting `main`?** It must carry no dev surface — no DevPanel, no
MockTransport, no network simulation, no diagnostics. CI enforces this. See
`docs/BRANCHING.md`.
