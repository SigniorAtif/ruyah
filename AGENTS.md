<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# How work lands in this repo

`main` only ever changes through a pull request. While a `release/x.y` branch is
open, it is where the work goes — and the unbroken line down the left of the
graph is the point, so nothing here is optional.

- **Never commit to `release/*`, `dev` or `main` directly.** Branch per concern:
  `feat|fix|chore|docs|refactor|perf|test/<short-kebab-topic>`, cut from the open
  release branch.
- **Atomic, conventional commits:** `type(scope): imperative summary`, lowercase,
  no trailing period, ≈65 chars, short body saying what and why. Each commit
  builds on its own (add a module, then wire it up). No emoji, no AI attribution
  trailers of any kind.
- **Merge back with `--no-ff`, always:**
  `git merge --no-ff feat/x -m "Merge branch 'feat/x' into release/0.6"`.
  A fast-forward splices the commits into the release line and loses the side
  rail. Never rebase, squash or cherry-pick onto a release branch.
- **Carry it to `dev` by fast-forward**, so `dev` stays runnable with the dev
  surface: `git checkout dev && git merge --ff-only release/0.6`. While `dev` is
  an ancestor of the release branch this leaves both labels on one commit and
  one lane. Do **not** use `--no-ff` here: that merge commit takes `dev` as its
  first parent, which moves `dev` into the graph's leftmost lane and redraws the
  whole release line as a side rail off it. Only when `dev` has commits of its
  own does it need a real merge — and then the merge belongs on a branch off the
  release branch, so the release line keeps the lane.
- **Before merging:** `npx next typegen && npx tsc --noEmit && npx eslint . && npm run build`.
- **Check the shape:** `git log --graph --oneline --first-parent release/0.6`
  should be merge commits and nothing else.
- Local tooling state (`agentdb.rvf`, `PRODUCT.md`, scratch images) stays
  untracked; never `git add -A`. Pushing is a separate, deliberate step.
- Delete a work branch only once it is merged into both the release branch and
  `dev`.

`docs/BRANCHING.md` has the long version, including the dev surface that a
release strips. `docs/` is gitignored — internal working documents — so these
rules live here, where they are tracked.
