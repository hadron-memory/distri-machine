import { describe, expect, it } from 'vitest';

import { DistributionMachine } from '../src/index.js';
import type { Bucket } from '../src/index.js';

/** A simple subject for filter-mode tests. */
interface Person {
  id: string;
  age: number;
  country: string;
  email?: string;
}

describe('fraction mode', () => {
  const buckets: Bucket[] = [
    { name: 'A', target_fraction: 0.5 },
    { name: 'B', target_fraction: 0.5 },
  ];

  it('assigns the first item from an empty (zero-total) map', () => {
    const m = new DistributionMachine({ buckets, shuffle: true });
    const dist = new Map<string, number>();
    const result = m.check({ id: '1' }, dist);
    expect(result).not.toBeNull();
    expect(dist.get(result!)).toBe(1);
  });

  it('never deadlocks at perfect balance (the <= guard)', () => {
    // Force a non-shuffling order so the deadlock would be deterministic if the
    // strict `<` bug were present: at counts (1,1) both sit at exactly 0.5.
    const m = new DistributionMachine({ buckets, shuffle: false });
    const dist = new Map<string, number>([
      ['A', 1],
      ['B', 1],
    ]);
    const result = m.check({ id: 'x' }, dist);
    expect(result).not.toBeNull();
  });

  it('converges to a 50/50 split over many checks', () => {
    const m = new DistributionMachine({ buckets, shuffle: true });
    const dist = new Map<string, number>();
    for (let i = 0; i < 1000; i++) m.check({ id: String(i) }, dist);
    const a = dist.get('A') ?? 0;
    const b = dist.get('B') ?? 0;
    expect(a + b).toBe(1000);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it('converges to an uneven 70/30 split', () => {
    const m = new DistributionMachine({
      buckets: [
        { name: 'big', target_fraction: 0.7 },
        { name: 'small', target_fraction: 0.3 },
      ],
      shuffle: true,
    });
    const dist = new Map<string, number>();
    for (let i = 0; i < 1000; i++) m.check({ id: String(i) }, dist);
    expect((dist.get('big') ?? 0) / 1000).toBeCloseTo(0.7, 1);
    expect((dist.get('small') ?? 0) / 1000).toBeCloseTo(0.3, 1);
  });

  it('handles a three-way split', () => {
    const m = new DistributionMachine({
      buckets: [
        { name: 'x', target_fraction: 1 / 3 },
        { name: 'y', target_fraction: 1 / 3 },
        { name: 'z', target_fraction: 1 / 3 },
      ],
      shuffle: true,
    });
    const dist = new Map<string, number>();
    for (let i = 0; i < 900; i++) m.check({ id: String(i) }, dist);
    for (const name of ['x', 'y', 'z']) {
      expect(dist.get(name) ?? 0).toBeGreaterThan(250);
    }
  });

  it('returns null when fractions do not cover all traffic', () => {
    const m = new DistributionMachine({
      buckets: [{ name: 'only', target_fraction: 0.5 }],
      shuffle: true,
    });
    const dist = new Map<string, number>([['only', 5]]);
    // 'only' is at 1.0 (5/5), above its 0.5 target → no bucket accepts.
    expect(m.check({ id: 'n' }, dist)).toBeNull();
  });
});

describe('filter mode', () => {
  const buckets: Bucket[] = [
    {
      name: 'mexico-over-50',
      sort_index: 0,
      rule: {
        and: [
          { '==': [{ var: 'country' }, 'MX'] },
          { '>': [{ var: 'age' }, 50] },
        ],
      },
    },
    {
      name: 'mexico',
      sort_index: 1,
      rule: { '==': [{ var: 'country' }, 'MX'] },
    },
    { name: 'everyone', sort_index: 2, rule: true },
  ];

  const m = new DistributionMachine<Person>({ buckets });

  it('matches the most specific rule first by sort_index', () => {
    const dist = new Map<string, number>();
    expect(m.check({ id: '1', country: 'MX', age: 60 }, dist)).toBe(
      'mexico-over-50',
    );
    expect(m.check({ id: '2', country: 'MX', age: 30 }, dist)).toBe('mexico');
    expect(m.check({ id: '3', country: 'US', age: 60 }, dist)).toBe('everyone');
  });

  it('increments the matched bucket count', () => {
    const dist = new Map<string, number>();
    m.check({ id: '1', country: 'MX', age: 30 }, dist);
    m.check({ id: '2', country: 'MX', age: 40 }, dist);
    expect(dist.get('mexico')).toBe(2);
  });

  it('returns null when no rule matches and there is no catch-all', () => {
    const noCatchAll = new DistributionMachine<Person>({
      buckets: [{ name: 'mx', rule: { '==': [{ var: 'country' }, 'MX'] } }],
    });
    expect(
      noCatchAll.check({ id: '9', country: 'US', age: 20 }, new Map()),
    ).toBeNull();
  });

  it('accepts a rule as a JSON-encoded string', () => {
    const stringRuleMachine = new DistributionMachine<Person>({
      buckets: [
        { name: 'adult', rule: JSON.stringify({ '>=': [{ var: 'age' }, 18] }) },
        { name: 'minor', rule: true },
      ],
    });
    expect(
      stringRuleMachine.check({ id: '1', country: 'US', age: 20 }, new Map()),
    ).toBe('adult');
    expect(
      stringRuleMachine.check({ id: '2', country: 'US', age: 10 }, new Map()),
    ).toBe('minor');
  });
});

describe('variables ($vars)', () => {
  it('exposes variables under $vars without subject shadowing', () => {
    const m = new DistributionMachine<Person>({
      buckets: [
        {
          name: 'eligible',
          rule: {
            and: [
              { '==': [{ var: 'country' }, { var: '$vars.country' }] },
              { '>': [{ var: 'age' }, { var: '$vars.min_age' }] },
            ],
          },
          variables: [
            { name: 'country', type: 'string', value: 'MX' },
            { name: 'min_age', type: 'number', value: 50 },
          ],
        },
        { name: 'rest', rule: true },
      ],
    });
    // Subject also has a `country` property — it must NOT shadow the variable.
    expect(m.check({ id: '1', country: 'MX', age: 60 }, new Map())).toBe(
      'eligible',
    );
    expect(m.check({ id: '2', country: 'US', age: 60 }, new Map())).toBe('rest');
    expect(m.check({ id: '3', country: 'MX', age: 40 }, new Map())).toBe('rest');
  });

  it('compares ISO date strings lexically', () => {
    const m = new DistributionMachine({
      buckets: [
        {
          name: 'joined-after',
          rule: { '>': [{ var: 'joined' }, { var: '$vars.cutoff' }] },
          variables: [
            { name: 'cutoff', type: 'date', value: '2026-01-01T00:00:00Z' },
          ],
        },
        { name: 'before', rule: true },
      ],
    });
    expect(
      m.check({ id: '1', joined: '2026-06-01T00:00:00Z' }, new Map()),
    ).toBe('joined-after');
    expect(
      m.check({ id: '2', joined: '2025-06-01T00:00:00Z' }, new Map()),
    ).toBe('before');
  });
});

describe('custom regex operator', () => {
  const m = new DistributionMachine<Person>({
    buckets: [
      {
        name: 'gmail',
        rule: { regex: [{ var: 'email' }, '@gmail\\.com$', 'i'] },
      },
      { name: 'other', rule: true },
    ],
  });

  it('matches with the regex op', () => {
    expect(
      m.check({ id: '1', country: 'US', age: 20, email: 'a@GMAIL.com' }, new Map()),
    ).toBe('gmail');
    expect(
      m.check({ id: '2', country: 'US', age: 20, email: 'a@yahoo.com' }, new Map()),
    ).toBe('other');
  });

  it('does not match a missing value', () => {
    expect(m.check({ id: '3', country: 'US', age: 20 }, new Map())).toBe('other');
  });
});

describe('override map (D6)', () => {
  const buckets: Bucket[] = [
    { name: 'A', target_fraction: 0.5 },
    { name: 'B', target_fraction: 0.5 },
  ];

  it('forces an assignment before any bucket logic and does not touch counts', () => {
    const m = new DistributionMachine({
      buckets,
      shuffle: true,
      overrides: { vip: 'B' },
    });
    const dist = new Map<string, number>();
    expect(m.check({ id: 'vip' }, dist)).toBe('B');
    // Override is a short-circuit: no count is incremented.
    expect(dist.size).toBe(0);
  });

  it('falls through to normal logic for non-overridden subjects', () => {
    const m = new DistributionMachine({
      buckets,
      shuffle: true,
      overrides: { vip: 'B' },
    });
    const dist = new Map<string, number>();
    const result = m.check({ id: 'someone-else' }, dist);
    expect(['A', 'B']).toContain(result);
    expect(dist.get(result!)).toBe(1);
  });

  it('honours a custom idKey', () => {
    const m = new DistributionMachine({
      buckets,
      overrides: { 'req-1': 'A' },
      idKey: 'requestId',
    });
    expect(m.check({ requestId: 'req-1' }, new Map())).toBe('A');
  });

  it('supports numeric subject ids', () => {
    const m = new DistributionMachine({ buckets, overrides: { '123': 'B' } });
    expect(m.check({ id: 123 }, new Map())).toBe('B');
  });
});

describe('tally isolation', () => {
  it('counts only this machine\'s buckets, ignoring foreign keys in a shared map', () => {
    const m = new DistributionMachine({
      buckets: [
        { name: 'A', target_fraction: 0.5 },
        { name: 'B', target_fraction: 0.5 },
      ],
      shuffle: true,
    });
    // A shared map polluted with another experiment's large counts must not
    // skew this machine's fractions: the first A/B assignment still lands.
    const dist = new Map<string, number>([['other-exp', 10_000]]);
    const result = m.check({ id: '1' }, dist);
    expect(['A', 'B']).toContain(result);
    expect(dist.get(result!)).toBe(1);
    expect(dist.get('other-exp')).toBe(10_000);
  });
});

describe('rule parsing', () => {
  it('throws at construction for an invalid JSON-encoded rule', () => {
    expect(
      () =>
        new DistributionMachine({
          buckets: [{ name: 'bad', rule: '{ not valid json' }],
        }),
    ).toThrow(/bucket "bad"/);
  });
});

describe('determinism via injected RNG', () => {
  it('shuffles deterministically when random is injected', () => {
    const buckets: Bucket[] = [
      { name: 'A', target_fraction: 0.5 },
      { name: 'B', target_fraction: 0.5 },
    ];
    // With random() === 0, Fisher–Yates swaps the [A, B] pair to [B, A]
    // deterministically, so B (first and under target on an empty map) wins
    // every time — proving the shuffle is RNG-driven and reproducible.
    const m = new DistributionMachine({
      buckets,
      shuffle: true,
      random: () => 0,
    });
    expect(m.check({ id: '1' }, new Map())).toBe('B');
    expect(m.check({ id: '2' }, new Map())).toBe('B');
  });
});
