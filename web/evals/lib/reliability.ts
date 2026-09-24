// pass^k (every one of k trials passes) and pass@k (at least one does), as the
// unbiased estimators over n trials with c passes. tau-bench's reliability measure.

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
}

function checkK(n: number, k: number): void {
  if (k < 1 || k > n) throw new RangeError(`k must be between 1 and ${n}, got ${k}`);
}

export function passHatK(n: number, c: number, k: number): number {
  checkK(n, k);
  return choose(c, k) / choose(n, k);
}

export function passAtK(n: number, c: number, k: number): number {
  checkK(n, k);
  return 1 - choose(n - c, k) / choose(n, k);
}
