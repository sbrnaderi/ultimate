---
name: sync-upstream
description: Pull Ultimate's upstream (HazAT/ultimate) into this fork's line as a bug-fix feed. Use when someone asks to "sync upstream", "pull the upstream fixes", "get the latest from HazAT", or to integrate upstream's newer commits into main.
---

# Sync upstream into our fork

This repository is the user's own line (`origin` = the fork `sbrnaderi/ultimate`, pushed over SSH), and upstream is `upstream` = `HazAT/ultimate`, fetch-only. The policy (root memory `fork-workflow`): our main is the product, upstream is a periodic bug-fix feed; features arrive with the fixes and are ours to shape or trim afterwards. Never force-push or rewrite history.

Run the whole flow as one coordinator branch (`branch`, medium size) — it changes files and lands through the lander. Verify everything you claim; the lander reruns every check anyway.

## 1. Measure, don't guess

```bash
git fetch origin upstream
git rev-list --left-right --count origin/main...main   # theirs ours
git merge-tree $(git merge-base main origin/upstream/main) main origin/upstream/main | grep -c '<<<<<<<'
```

List the incoming commits and read the ones that change behaviour (`git log --oneline main..origin/upstream/main`). Two classes deserve a line in the report: a `defaultOff` change in `shared/extension-api.ts` (which built-ins stop loading, e.g. `5323967`), and any change to `.ultimate/settings.json`, `agents/`, or `docs/subagents.md` (they can silently replace this project's agent setup).

## 2. Merge, then prove our survivors survived

Merge `origin/upstream/main` into a branch of our `main`. A clean `merge-tree` does not mean a clean merge: read both sides' diffs for every overlapping file. After merging, grep the pushed tree for each thing our line adds, all of which must still be present:

- `lib/failures.ts`, `lib/model-ref.ts`, `checkBranchModel`, and current-model branch inheritance (`extensions/lineage/server.ts`) — the model-pinning fixes
- `webSearch` in `.ultimate/extensions/web-search/`
- the credential scrub in `test/setup.ts` and the hostname-based remote-delivery fixture in `test/messages.test.ts`
- `worktree list --porcelain` **without** `-z` in `extensions/instance/cleanup.ts`
- sequential lander legs and `model: compudu/...` on `lander`, `scout`, `dream-pass` in `.ultimate/`

If upstream and ours clash semantically, stop and report the clash; do not pick a side silently.

## 3. Gates, serialized, alone

`pnpm check`, then `pnpm test`, then `pnpm test:e2e` — one at a time, nothing else running. The lander's own legs are sequential for this reason (`.ultimate/settings.json`): two 8-worker suites on one box produce fake ~30 s timeouts in whichever test is scheduling-sensitive, and each bad run burns a lander model call. A ~30 s timeout on a file you never touched under load is contention, not a bug: rerun it solo before believing it. This box: PATH `git` is the 2.55 shim at `~/.local/bin/git` (needed for `test:e2e`'s config-based hooks and for `-z`), and shell `node` may be v22 while `engines` wants ≥26 — use the host's PATH.

## 4. Land and push

`workspace submit`. The lander (#23, on the compudu model) merges the remote target, reruns the legs, fast-forwards main and pushes to `settings.push`/target, i.e. the fork. Hold your CPU while it runs. Then verify `git rev-list --left-right --count origin/main...main` → `0 0`.

## 5. Report

To @ultimate, reply: false: incoming commits summarized, semantic resolutions per overlapping file, the survivor grep results, which built-ins `defaultOff` now turns off **on this machine** (check live with `ultimate.extensions()`; the user's `extensions.enable` in `~/.ultimate/settings.json` wins and is theirs to edit — never write it from a branch), gate counts, landed+pushed sha, divergence from this brief. Upstream will have moved again; that is normal, and the same flow handles it.
