/**
 * @sivru
 * schema: 1
 * role: deep-nest
 * responsibility: a deliberately deep YAML mapping to stress memory bounds
 * collaborators:
 *   - a
 *   - b
 *   - c
 *   - d
 *   - e
 *   - f
 *   - g
 *   - h
 *   - i
 *   - j
 * invariants:
 *   - the parser does not blow the stack
 *   - the extractor terminates in a few ms
 * decisions:
 *   - chose: deep but bounded
 *     because: long-tail YAML stress without going adversarial
 *     valid-while: js-yaml's default limits hold
 *     revisit-if: js-yaml ever ships a stricter default
 * @end
 */
export function deepNest() {
  return null;
}
