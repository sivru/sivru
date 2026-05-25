# coach/__fixtures__/

DESIGN-0005 §2 names four fixture repos under this directory:
`repo-fresh`, `repo-stale`, `repo-mixed`, `repo-rename`.

v0.9.0 implementation note: the equivalent test coverage is realized
**inline** in `../index.test.ts` (and `../git-stats.test.ts` for
rename history). Each test seeds a fresh git repo in a `tmpdir`,
commits the labelled file set, and runs `runCheckup` against it. The
inline form avoids checking binary git history into the repo and
keeps the named cases adjacent to their assertions.

The FP-rate corpus subdirectory (`fp-corpus/` per §Test plan) is
**deferred to v0.9.x** per the CHANGELOG entry. Sourcing 10–20
real-world OSS memory files with per-span labels and per-file
attribution requires manual license + anonymization judgment that
wasn't available during the v0.9.0 cut.

TODO (v0.9.x):
- Extract `repo-fresh`, `repo-stale`, `repo-mixed`, `repo-rename`
  into standalone shell scripts under `./scripts/seed-fixtures.sh`
  so a human can run them and inspect the resulting state.
- Source the `fp-corpus/` files per design D7 (real-world only;
  permissive license; sanitized; attribution.md per file).
