import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  START_NUMBERS, UNREACHABLE, ALL_TARGETS,
  isPlayableTarget, applyOp, applyStep, isTargetHit, verifySolution,
} from '../public/game-rules.js';

const gcd = (a, b) => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const frac = (n, d) => {
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  return [n / g, d / g];
};

// Exact rational search over every way to combine the start numbers.
function reachableIntegers() {
  const found = new Set();
  const seen = new Set();
  const search = (nums) => {
    const key = nums.map(([n, d]) => `${n}/${d}`).sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    if (nums.length === 1) {
      const [n, d] = nums[0];
      if (d === 1n && n >= 0n && n <= 100n) found.add(Number(n));
      return;
    }
    for (let i = 0; i < nums.length; i++) {
      for (let j = 0; j < nums.length; j++) {
        if (i === j) continue;
        const [an, ad] = nums[i], [bn, bd] = nums[j];
        const rest = nums.filter((_, k) => k !== i && k !== j);
        const results = [
          frac(an * bd + bn * ad, ad * bd),
          frac(an * bd - bn * ad, ad * bd),
          frac(an * bn, ad * bd),
        ];
        if (bn !== 0n) results.push(frac(an * bd, ad * bn));
        for (const r of results) search([...rest, r]);
      }
    }
  };
  search(START_NUMBERS.map((n) => [BigInt(n), 1n]));
  return found;
}

const EXAMPLE = [
  { a: 4, b: 3, op: '+' },
  { a: 3, b: 2, op: '+' },
  { a: 1, b: 0, op: '-' },
  { a: 0, b: 1, op: '*' },
];

test('ALL_TARGETS has 94 entries, ascending, none unreachable', () => {
  assert.equal(ALL_TARGETS.length, 94);
  for (const n of UNREACHABLE) assert.ok(!ALL_TARGETS.includes(n));
  assert.deepEqual(ALL_TARGETS, [...ALL_TARGETS].sort((a, b) => a - b));
});

test('UNREACHABLE is exactly the integers 0..100 that brute force cannot reach', () => {
  const found = reachableIntegers();
  const missing = [];
  for (let i = 0; i <= 100; i++) if (!found.has(i)) missing.push(i);
  assert.deepEqual(missing, [...UNREACHABLE].sort((a, b) => a - b));
});

test('START_NUMBERS is frozen', () => {
  assert.deepEqual(START_NUMBERS, [1, 2, 3, 4, 5]);
  assert.ok(Object.isFrozen(START_NUMBERS));
});

test('isPlayableTarget', () => {
  assert.equal(isPlayableTarget(0), true);
  assert.equal(isPlayableTarget(100), true);
  for (const bad of [76, -1, 101, 1.5, '12', null, undefined, NaN]) assert.equal(isPlayableTarget(bad), false);
});

test('applyOp', () => {
  assert.equal(applyOp(6, '+', 2), 8);
  assert.equal(applyOp(6, '-', 2), 4);
  assert.equal(applyOp(6, '*', 2), 12);
  assert.equal(applyOp(6, '/', 2), 3);
  assert.equal(applyOp(6, '/', 0), null);
  assert.equal(applyOp(6, '^', 2), null);
});

test('isTargetHit tolerates float error but not near-misses', () => {
  assert.equal(isTargetHit(12, 12), true);
  assert.equal(isTargetHit(12 + 1e-12, 12), true);
  assert.equal(isTargetHit(12.001, 12), false);
  assert.equal(isTargetHit(11, 12), false);
});

test('How to Play example reaches 12 step by step', () => {
  let nums = [...START_NUMBERS];
  const expected = [[1, 2, 3, 9], [1, 2, 12], [12, 1], [12]];
  EXAMPLE.forEach((step, i) => {
    nums = applyStep(nums, step);
    assert.deepEqual(nums, expected[i]);
  });
  assert.equal(verifySolution(12, EXAMPLE), true);
});

test('verifySolution rejects bad input', () => {
  assert.equal(verifySolution(13, EXAMPLE), false);
  assert.equal(verifySolution(12, EXAMPLE.slice(0, 3)), false);
  assert.equal(verifySolution(12, [...EXAMPLE, EXAMPLE[0]]), false);
  assert.equal(verifySolution(12, null), false);
  assert.equal(verifySolution(12, 'steps'), false);
  assert.equal(verifySolution(76, EXAMPLE), false);
  const bad = (i, step) => EXAMPLE.map((s, k) => (k === i ? step : s));
  assert.equal(verifySolution(12, bad(0, { a: 2, b: 2, op: '+' })), false);
  assert.equal(verifySolution(12, bad(0, { a: 9, b: 3, op: '+' })), false);
  assert.equal(verifySolution(12, bad(0, { a: 1.5, b: 3, op: '+' })), false);
  assert.equal(verifySolution(12, bad(0, { a: 4, b: 3, op: '^' })), false);
  assert.equal(verifySolution(12, bad(0, null)), false);
});

test('verifySolution rejects division by zero', () => {
  const steps = [
    { a: 3, b: 2, op: '-' }, // 4-3=1 -> [1,2,5,1]
    { a: 3, b: 0, op: '-' }, // 1-1=0 -> [2,5,0]
    { a: 0, b: 2, op: '/' }, // 2/0 -> null
    { a: 0, b: 1, op: '+' },
  ];
  assert.equal(applyStep(applyStep(applyStep([...START_NUMBERS], steps[0]), steps[1]), steps[2]), null);
  assert.equal(verifySolution(0, steps), false);
});

test('applyStep does not mutate its input', () => {
  const input = [1, 2, 3, 4, 5];
  const copy = structuredClone(input);
  applyStep(input, { a: 4, b: 3, op: '+' });
  assert.deepEqual(input, copy);
});

test('fractions work', () => {
  assert.deepEqual(applyStep([1, 3], { a: 0, b: 1, op: '/' }), [1 / 3]);
  const steps = [
    { a: 2, b: 1, op: '/' }, // 3/2 -> [1,4,5,1.5]
    { a: 3, b: 1, op: '*' }, // 1.5*4 -> [1,5,6]
    { a: 2, b: 1, op: '-' }, // 6-5 -> [1,1]
    { a: 0, b: 1, op: '*' }, // 1*1 -> [1]
  ];
  assert.deepEqual(applyStep(START_NUMBERS, steps[0]), [1, 4, 5, 1.5]);
  assert.equal(verifySolution(1, steps), true);
  assert.equal(verifySolution(2, steps), false);
});
