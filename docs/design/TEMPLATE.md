# DESIGN-NNNN: <title>

**Status:** Draft <!-- Draft → Accepted → Implemented → Superseded -->
**Issue:** #N
**Created:** YYYY-MM-DD
**Author:** @handle

## Problem

What's broken or missing today, and how does a user feel it? One or
two paragraphs. Include the failure mode in concrete terms — "today,
when X, the user sees Y." Avoid abstract framing.

## Proposal

The approach we're choosing, in 3–5 paragraphs. Include the public
API surface (TypeScript types are useful here), data flow, and key
modules. Don't dump full implementation code; do dump the contract
the implementation has to satisfy.

When applicable, link to the type stubs in code (e.g., for new
extensible features, point at `packages/<pkg>/src/<feat>/types.ts`).

## Alternatives considered

Other approaches looked at + why rejected. One short paragraph each.
Three or four is plenty.

## Open questions

What's still undecided. Each entry has an owner and a deadline ("by
the time we cut v0.X.0").

## Acceptance criteria

Concrete bullets. The feature is done when:

- ...
- ...
- ...

Match (or extend) the issue's acceptance section. The design doc is
the source of truth once accepted.

## Test plan

How we'll know it works.

- Unit tests: ...
- Manual verification: ...
- Bench re-baseline: ... (if applicable)
- Performance gate: ... (if applicable)

## Customization shape

If this feature has a registry / ruleset / catalog, spell out the
three layers per CONTRIBUTING.md "Extensibility":

1. Built-in defaults: where they live, what ships.
2. Declarative override: JSON path + schema.
3. Code-level extension: TS file path + interface.

If the feature has no user-customizable surface, omit this section
and note why.
