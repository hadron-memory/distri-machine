import jsonLogic from 'json-logic-js';

import type { JsonLogicRule } from './types.js';

let opsRegistered = false;
/** Compiled-RegExp cache keyed by `pattern::flags` — patterns are static. */
const regexCache = new Map<string, RegExp>();

/**
 * Register custom operators on the json-logic-js singleton, once.
 *
 * JsonLogic has no regex operator, so we add one:
 *   `{ "regex": [<value>, <pattern>, <flags?>] }`  →  boolean
 *
 * Registration is lazy and idempotent so it survives tree-shaking and repeated
 * imports without re-adding the operation.
 */
function ensureOps(): void {
  if (opsRegistered) return;
  jsonLogic.add_operation(
    'regex',
    (value: unknown, pattern: unknown, flags?: unknown): boolean => {
      if (value == null || pattern == null) return false;
      const patternStr = String(pattern);
      const flagsStr = flags == null ? '' : String(flags);
      const cacheKey = `${patternStr}::${flagsStr}`;
      try {
        let re = regexCache.get(cacheKey);
        if (re === undefined) {
          re = new RegExp(patternStr, flagsStr || undefined);
          regexCache.set(cacheKey, re);
        }
        return re.test(String(value));
      } catch {
        // Invalid pattern/flags → no match rather than throwing into check().
        return false;
      }
    },
  );
  opsRegistered = true;
}

/**
 * Evaluate a JsonLogic rule against `data`. Accepts the rule as an object or as
 * the raw JSON-encoded string the host stores in a text field.
 */
export function applyRule(rule: JsonLogicRule | string, data: unknown): unknown {
  ensureOps();
  const parsed: unknown =
    typeof rule === 'string' ? (JSON.parse(rule) as unknown) : rule;
  // json-logic-js' types are loose; the cast keeps our public types clean.
  return jsonLogic.apply(parsed as never, data as never);
}
