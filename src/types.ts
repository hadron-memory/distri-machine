/**
 * A JsonLogic rule. Stored JSON-encoded in a text field by the host and either
 * pre-parsed into an object or passed to the machine as the raw JSON string —
 * {@link DistributionMachine} accepts both.
 *
 * @see https://jsonlogic.com/
 */
export type JsonLogicRule = boolean | { [operator: string]: unknown };

/** How the host wants a {@link Variable} value coerced before evaluation. */
export type VariableType = 'string' | 'number' | 'date';

/**
 * A named, reusable constant merged into the JsonLogic evaluation data under the
 * reserved `$vars` key, so a subject property can never shadow it.
 *
 * Reference it from a rule with `{ "var": "$vars.<name>" }`.
 *
 * Dates have no JsonLogic type: pass them as ISO 8601 strings (which compare
 * correctly lexically) or as epoch numbers. `type` is metadata that tells the
 * host how to coerce; the library passes `value` through unchanged.
 */
export interface Variable {
  name: string;
  type: VariableType;
  value: string | number;
}

/**
 * One assignment target. A bucket is **either** a fraction bucket
 * (`target_fraction` set) **or** a filter bucket (`rule` set) — never both, and
 * a machine should not mix the two kinds. Mixing is undefined behavior by
 * design.
 */
export interface Bucket {
  /** Returned by {@link DistributionMachine.check} when this bucket wins. */
  name: string;

  /**
   * Filter-mode ordering. Buckets are evaluated in ascending `sort_index` and
   * the first matching rule wins, so put specific rules before general ones.
   * Defaults to `0`. Unused in fraction mode.
   */
  sort_index?: number;

  /**
   * Fraction mode. The share of traffic this bucket should converge to
   * (`0`–`1`). When set, `rule` is ignored.
   */
  target_fraction?: number;

  /**
   * Filter mode. A JsonLogic rule, as an object or a JSON-encoded string.
   * Evaluated against the subject (merged with `$vars`). When set,
   * `target_fraction` should be undefined.
   */
  rule?: JsonLogicRule | string;

  /** Named constants exposed to `rule` under `$vars`. */
  variables?: Variable[];
}

export interface DistributionMachineOptions {
  buckets: Bucket[];

  /**
   * Fraction mode: shuffle the bucket order on every `check` so no bucket gets
   * systematic preference when several are at or below target. This removes the
   * arrival-order bias of in-order iteration. Leave `false` for filter mode,
   * where `sort_index` order is load-bearing.
   */
  shuffle?: boolean;

  /**
   * Force-assign / override map: `{ subjectId -> bucketName }`. Checked before
   * any bucket logic — a QA/demo/escalation escape hatch. The subject's id is
   * read from {@link DistributionMachineOptions.idKey}.
   */
  overrides?: Record<string, string>;

  /** Subject property used as the id for {@link overrides}. Defaults to `"id"`. */
  idKey?: string;

  /** Injectable RNG for the shuffle (defaults to `Math.random`). For tests. */
  random?: () => number;
}
