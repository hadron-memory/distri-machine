# @hadron-memory/distri-machine

A small traffic-bucketing library for A/B testing. You give it a subject and a
running tally; it gives you back a bucket name. It does **assignment** — not
measurement, persistence, or significance testing. Those stay with the host.

- **Fraction mode** — split traffic toward target shares (e.g. 50/50), balanced
  exactly on live counts.
- **Filter mode** — route by attributes with [JsonLogic](https://jsonlogic.com/)
  rules, first match wins.
- One runtime dependency (`json-logic-js`), MIT, ships ESM + CJS + types.

```bash
npm install @hadron-memory/distri-machine
```

## Fraction mode — A/B split

```ts
import { DistributionMachine } from '@hadron-memory/distri-machine';

const machine = new DistributionMachine({
  shuffle: true, // recommended in fraction mode (see "Randomization" below)
  buckets: [
    { name: 'control', target_fraction: 0.5 },
    { name: 'variant', target_fraction: 0.5 },
  ],
});

// The host owns this tally. Persist it; share it across instances if you can.
const distribution = new Map<string, number>();

const bucket = machine.check({ id: 'user-123' }, distribution);
// → 'control' or 'variant'; `distribution` is incremented for the winner.
```

Counts converge **exactly** to the targets — unlike hash-based assignment, which
is only asymptotic and can skew badly on small/segmented cohorts. Uneven splits
(`0.7 / 0.3`) and three-way splits work the same way.

## Filter mode — route by attributes

```ts
const machine = new DistributionMachine({
  buckets: [
    {
      name: 'mexico-over-50',
      sort_index: 0, // most specific first
      rule: {
        and: [
          { '==': [{ var: 'country' }, 'MX'] },
          { '>': [{ var: 'age' }, 50] },
        ],
      },
    },
    { name: 'mexico', sort_index: 1, rule: { '==': [{ var: 'country' }, 'MX'] } },
    { name: 'everyone', sort_index: 2, rule: true }, // catch-all
  ],
});

machine.check({ id: '1', country: 'MX', age: 60 }, new Map()); // 'mexico-over-50'
```

Buckets are evaluated in ascending `sort_index`; the first rule that matches
wins, so order specific rules before general ones. A `rule` may be a JsonLogic
object **or** the JSON-encoded string you stored in a text field — both are
accepted.

> **Don't mix modes in one machine.** A machine is either fraction buckets or
> filter buckets. Mixing is undefined behavior by design. To do "50/50 *within*
> Mexico-over-50", compose two machines yourself: one gates eligibility, one
> splits.

### Variables

Named constants are merged into the evaluation data under the reserved `$vars`
key, so a subject property can never shadow them. Reference them with
`{ "var": "$vars.<name>" }`:

```ts
{
  name: 'eligible',
  rule: {
    and: [
      { '==': [{ var: 'country' }, { var: '$vars.country' }] },
      { '>':  [{ var: 'age' },     { var: '$vars.min_age' }] },
    ],
  },
  variables: [
    { name: 'country', type: 'string', value: 'MX' },
    { name: 'min_age', type: 'number', value: 50 },
  ],
}
```

### Dates

JsonLogic has no date type. Pass dates as **ISO 8601 strings** (which compare
correctly with `<` / `>` lexically) or as **epoch numbers**. `Variable.type`
(`'date'`) is metadata telling the host how to coerce; the library passes the
value through unchanged.

### `regex` operator

This library adds a `regex` operator to JsonLogic:
`{ "regex": [<value>, <pattern>, <flags?>] }` → boolean. A missing value or an
invalid pattern yields `false` rather than throwing.

```ts
{ name: 'gmail', rule: { regex: [{ var: 'email' }, '@gmail\\.com$', 'i'] } }
```

## Override map

A force-assign escape hatch checked **before** any bucket logic — for QA, demos,
and escalations. Keyed by the subject's id (`idKey`, default `"id"`):

```ts
new DistributionMachine({
  buckets: [/* … */],
  overrides: { 'user-123': 'variant' }, // subjectId → bucketName
  idKey: 'id',
});
```

An overridden subject short-circuits and does **not** increment any count.

## API

```ts
new DistributionMachine<T extends object>(options): DistributionMachine<T>

options: {
  buckets: Bucket[];
  shuffle?: boolean;                  // fraction mode: shuffle order each check
  overrides?: Record<string, string>; // subjectId → bucketName
  idKey?: string;                     // subject id property, default 'id'
  random?: () => number;              // injectable RNG (tests); default Math.random
}

machine.check(subject: T, distribution: Map<string, number>): string | null
```

`check` returns the winning bucket name and increments its count in
`distribution`, or returns `null` if nothing matched. Configure a final
catch-all bucket (`target_fraction: 1` or `rule: true`) if you never want
`null`.

A `Bucket` is **either** a fraction bucket or a filter bucket:

```ts
interface Bucket {
  name: string;
  sort_index?: number;                 // filter mode ordering (default 0)
  target_fraction?: number;            // fraction mode: target share 0–1
  rule?: JsonLogicRule | string;       // filter mode: JsonLogic (object or JSON string)
  variables?: Variable[];              // constants exposed under $vars
}
```

## What the host owns

This library is **pure on configuration and keeps no state of its own.** Two
things are explicitly your responsibility:

1. **The distribution map.** You create, persist, and (ideally) share it.
   `check` mutates it in place. Two server instances with separate in-memory
   maps will drift slightly; back the map with something central if exactness
   across instances matters. Not solved in v1.

2. **Stickiness.** `check` is **not** deterministic per subject — re-checking
   the same subject can return a *different* bucket as counts shift. **Persist
   the first assignment and never re-check an already-assigned subject.**

## Randomization

Fraction mode is **balanced (block-style) randomization**, not independent
per-subject coin flips. Each subject still has roughly its target odds of each
variant, and balanced group sizes *increase* statistical power — this is the
scheme clinical trials use to keep arms evenly sized. Use `shuffle: true` so no
bucket gets systematic preference when several are at or below target.

If you need significance-grade **independent** sampling (assignment
independence per subject), that would be a future hash-based mode — out of scope
for v1.

## License

MIT © Hadron Memory
