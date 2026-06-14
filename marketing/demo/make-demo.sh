#!/usr/bin/env bash
# Build the sivru demo repo from scratch — a tiny, legible codebase that tells the
# whole story in two beats: the MAP (authored intent + health) and the GATE (an
# agent's refactor silently deletes the test guarding a security decision, and
# sivru blocks the PR). Regenerates cleanly every run.
#
#   ./make-demo.sh [target-dir]   (default: /tmp/sivru-demo)
#
# Then follow STORYBOARD.md to record.
set -euo pipefail
DIR="${1:-/tmp/sivru-demo}"
rm -rf "$DIR"; mkdir -p "$DIR/src/auth" "$DIR/src/billing" "$DIR/test"
cd "$DIR"

# --- the clean codebase (this is `main`) -------------------------------------

cat > src/auth/session.ts <<'TS'
/**
 * @sivru
 * schema: 1
 * role: session-token validator
 * responsibility: decide whether a session token is still valid for a request.
 * invariants:
 *   - rule: an expired token is always rejected (tokens live 24h, no exceptions)
 *     enforced-by: "test/auth.test.ts::rejects an expired token"
 * decisions:
 *   - chose: hard 24h expiry, checked on every request
 *     because: a stolen token must stop working within a day, even if revocation lags
 *     valid-while: sessions are stateless JWTs with no server-side revocation
 *     revisit-if: we add a server-side session store with instant revocation
 * maturity: stable
 * @end
 */
export function validateSession(token: { issuedAt: number }, now: number): boolean {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  if (now - token.issuedAt > TWENTY_FOUR_HOURS) return false; // expired -> reject
  return true;
}
TS

cat > src/billing/charge.ts <<'TS'
/**
 * @sivru
 * schema: 1
 * role: charge processor
 * responsibility: charge a customer exactly once for a given idempotency key.
 * collaborators: [validateSession]
 * invariants:
 *   - rule: the same idempotency key never charges twice
 *     enforced-by: "test/billing.test.ts::rejects a duplicate charge"
 * maturity: stable
 * @end
 */
const seen = new Set<string>();
export function charge(key: string, cents: number): "charged" | "duplicate" {
  if (seen.has(key)) return "duplicate";
  seen.add(key);
  return "charged";
}
TS

cat > test/auth.test.ts <<'TS'
import { validateSession } from "../src/auth/session";
it("rejects an expired token", () => {
  const dayAgo = 0;
  const now = 25 * 60 * 60 * 1000;
  if (validateSession({ issuedAt: dayAgo }, now) !== false) throw new Error("expired token was accepted");
});
it("accepts a fresh token", () => {
  if (validateSession({ issuedAt: 1000 }, 2000) !== true) throw new Error("fresh token was rejected");
});
TS

cat > test/billing.test.ts <<'TS'
import { charge } from "../src/billing/charge";
it("rejects a duplicate charge", () => {
  charge("k1", 500);
  if (charge("k1", 500) !== "duplicate") throw new Error("double charge!");
});
TS

cat > README.md <<'MD'
# acme — demo service (sivru)
A tiny service used to demo sivru. `auth/session.ts` and `billing/charge.ts` carry
`@sivru` blocks recording the *why*, each linked to the test that guards it.
MD

git init -q; git add -A
git -c user.name=demo -c user.email=demo@example.com commit -q -m "acme service: auth + billing, with @sivru intent"
git branch -M main

# --- the agent's "refactor" (this is the PR that breaks a decision) ----------
# An agent tidies up session.ts and, while "cleaning the tests", renames the one
# guarding the expiry rule — silently removing the guarantee that expired tokens
# are rejected. The code still compiles. Review at agent velocity misses it.
git checkout -q -b agent/refactor-session

# touch the guarded symbol (a harmless-looking responsibility reword)
perl -0pi -e 's/decide whether a session token is still valid for a request\./decide whether a session token is valid \(refactored\)./' src/auth/session.ts
# rename the enforced-by test -> the linkage no longer resolves
perl -0pi -e 's/rejects an expired token/checks token expiry/' test/auth.test.ts

git add -A
git -c user.name=agent -c user.email=agent@example.com commit -q -m "refactor(auth): tidy session validation + tests"

git checkout -q main
echo "Demo repo ready at: $DIR"
echo "  main            = clean"
echo "  agent/refactor-session = the PR that quietly broke the expiry guarantee"
