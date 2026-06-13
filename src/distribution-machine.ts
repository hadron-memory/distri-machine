import { applyRule } from './json-logic.js';
import type {
  Bucket,
  DistributionMachineOptions,
  Variable,
} from './types.js';

/** Reserved key under which {@link Variable}s are exposed to JsonLogic rules. */
const VARS_KEY = '$vars';

/**
 * Assigns a subject to a bucket. The machine is **pure on configuration** and
 * **stateless on its own** — the host owns the running tally (`distribution`)
 * and all assignment persistence.
 *
 * Two mutually-exclusive modes, selected by how the buckets are configured (and
 * by the `shuffle` flag):
 *
 * - **Fraction mode** (`shuffle: true`, buckets carry `target_fraction`):
 *   buckets are shuffled each `check`, and the first one at or below its target
 *   share wins. Converges exactly to the target fractions. This is balanced
 *   (block-style) randomization, not independent per-subject coin flips.
 * - **Filter mode** (`shuffle: false`, buckets carry a JsonLogic `rule`):
 *   buckets are evaluated in ascending `sort_index`, first match wins.
 *
 * Do not mix fraction and filter buckets in one machine — undefined behavior.
 *
 * **Stickiness is the host's job.** `check` is not deterministic per subject: a
 * re-check can return a different bucket as counts shift. Persist the first
 * assignment and never re-check an already-assigned subject.
 */
export class DistributionMachine<T extends object = object> {
  private readonly buckets: readonly Bucket[];
  private readonly shuffle: boolean;
  private readonly overrides: Record<string, string>;
  private readonly idKey: string;
  private readonly random: () => number;
  /** Buckets sorted by `sort_index` once, for filter mode. */
  private readonly sorted: readonly Bucket[];

  constructor(options: DistributionMachineOptions) {
    this.buckets = options.buckets;
    this.shuffle = options.shuffle ?? false;
    this.overrides = options.overrides ?? {};
    this.idKey = options.idKey ?? 'id';
    this.random = options.random ?? Math.random;
    this.sorted = [...options.buckets].sort(
      (a, b) => (a.sort_index ?? 0) - (b.sort_index ?? 0),
    );
  }

  /**
   * Assign `subject` to a bucket, incrementing that bucket's count in
   * `distribution`. Returns the winning bucket name, or `null` if nothing
   * matched (configure a final catch-all bucket — `target_fraction: 1` or
   * `rule: true` — to avoid `null`).
   *
   * @param subject  The object being bucketed; rules read its properties.
   * @param distribution  The host-owned running tally `bucketName -> count`.
   *   Mutated in place on a successful assignment.
   */
  check(subject: T, distribution: Map<string, number>): string | null {
    const subj = subject as Record<string, unknown>;

    // D6: the override map wins before any bucket logic.
    const id = subj[this.idKey];
    if (
      typeof id === 'string' &&
      Object.prototype.hasOwnProperty.call(this.overrides, id)
    ) {
      return this.overrides[id]!;
    }

    const order = this.shuffle ? this.shuffled() : this.sorted;
    for (const bucket of order) {
      if (this.accepts(bucket, subj, distribution)) {
        distribution.set(bucket.name, (distribution.get(bucket.name) ?? 0) + 1);
        return bucket.name;
      }
    }
    return null;
  }

  private accepts(
    bucket: Bucket,
    subject: Record<string, unknown>,
    distribution: Map<string, number>,
  ): boolean {
    if (bucket.target_fraction !== undefined) {
      let total = 0;
      for (const n of distribution.values()) total += n;
      // Zero-total guard: an empty map gives 0/0 = NaN, and NaN <= target is
      // false, which would reject the very first item. Treat total-zero (and a
      // missing key) as cur_fraction = 0 so the first item lands.
      const cur =
        total === 0 ? 0 : (distribution.get(bucket.name) ?? 0) / total;
      // `<=` not `<`: at perfect balance (e.g. 1,1 for 0.5/0.5) every bucket
      // sits exactly at target; a strict `<` would make them all refuse and
      // leave half the traffic unassigned. Accept at-or-below target.
      return cur <= bucket.target_fraction;
    }

    if (bucket.rule !== undefined) {
      const data = { ...subject, [VARS_KEY]: buildVars(bucket.variables) };
      return Boolean(applyRule(bucket.rule, data));
    }

    return false;
  }

  /** Fisher–Yates shuffle of a fresh copy of the buckets. */
  private shuffled(): Bucket[] {
    const arr = [...this.buckets];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }
}

/** Build the `$vars` object from a bucket's variable list. */
function buildVars(variables?: Variable[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  if (!variables) return vars;
  for (const v of variables) vars[v.name] = v.value;
  return vars;
}
