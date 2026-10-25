/**
 * A binary heap: `push` and `pop` in log n, the item `compare` puts first always on top
 * (`compare(a, b) < 0` — a comes out before b). The planner's two queues are this
 * [scheduleSuggest.service]: the jobs, heaviest weightage first, and each job's presses, the one
 * free soonest first.
 */
export class PriorityQueue {
  constructor(compare, items = []) {
    this.compare = compare;
    this.heap = [];
    for (const item of items) this.push(item);
  }

  get size() { return this.heap.length; }

  peek() { return this.heap[0]; }

  push(item) {
    const heap = this.heap;
    heap.push(item);
    let at = heap.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.compare(heap[at], heap[parent]) >= 0) break;
      [heap[at], heap[parent]] = [heap[parent], heap[at]];
      at = parent;
    }
    return this;
  }

  pop() {
    const heap = this.heap;
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let first = at;
        if (left < heap.length && this.compare(heap[left], heap[first]) < 0) first = left;
        if (right < heap.length && this.compare(heap[right], heap[first]) < 0) first = right;
        if (first === at) break;
        [heap[at], heap[first]] = [heap[first], heap[at]];
        at = first;
      }
    }
    return top;
  }
}

/**
 * A job's weightage: what the Production in charge gave it (1–10), else its order's priority —
 * urgent 9, high 7, normal 5, low 3. Higher runs sooner.
 */
export const PRIORITY_WEIGHT = { urgent: 9, high: 7, normal: 5, low: 3 };
export const weightOf = (job) => {
  const given = Number(job?.weightage);
  return Number.isFinite(given) && given >= 1 ? given : PRIORITY_WEIGHT[job?.priority] ?? PRIORITY_WEIGHT.normal;
};

/** Heaviest first; then the earliest due; then the biggest (hardest to fit late); then by number. */
export const byWeight = (a, b) => weightOf(b) - weightOf(a)
  || String(a.dueDay || '9').localeCompare(String(b.dueDay || '9'))
  || (b.toMake || 0) - (a.toMake || 0)
  || String(a.number || '').localeCompare(String(b.number || ''));
