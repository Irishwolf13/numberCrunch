// Shared game rules: imported by the browser client and the Node server. No imports, no Node APIs.

export const START_NUMBERS = Object.freeze([1, 2, 3, 4, 5]);
export const UNREACHABLE = new Set([76, 79, 86, 92, 94, 97, 98]);
export const ALL_TARGETS = [];
for (let i = 0; i <= 100; i++) { if (!UNREACHABLE.has(i)) ALL_TARGETS.push(i); }

export function isPlayableTarget(n) {
  return Number.isInteger(n) && n >= 0 && n <= 100 && !UNREACHABLE.has(n);
}

export function applyOp(a, op, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? null : a / b;
    default: return null;
  }
}

// Combine numbers[a] and numbers[b]; returns a new array (others in order, result last) or null if invalid.
export function applyStep(numbers, step) {
  if (!Array.isArray(numbers) || !step) return null;
  const { a, b, op } = step;
  const ok = (i) => Number.isInteger(i) && i >= 0 && i < numbers.length;
  if (!ok(a) || !ok(b) || a === b) return null;
  const result = applyOp(numbers[a], op, numbers[b]);
  if (result === null) return null;
  return [...numbers.filter((_, i) => i !== a && i !== b), result];
}

export function isTargetHit(value, target) {
  return Math.abs(value - Math.round(value)) < 1e-9 && Math.round(value) === target;
}

export function verifySolution(target, steps) {
  if (!isPlayableTarget(target)) return false;
  if (!Array.isArray(steps) || steps.length !== START_NUMBERS.length - 1) return false;
  let numbers = [...START_NUMBERS];
  for (const step of steps) {
    numbers = applyStep(numbers, step);
    if (!numbers) return false;
  }
  return numbers.length === 1 && isTargetHit(numbers[0], target);
}
