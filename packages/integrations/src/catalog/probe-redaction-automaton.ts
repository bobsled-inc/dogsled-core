interface AutomatonNode {
  depth: number;
  fail: number;
  outputLength: number;
  transitions: Map<number, number>;
}

export function buildAutomaton(patterns: readonly (readonly number[])[]): AutomatonNode[] {
  const nodes: AutomatonNode[] = [{ depth: 0, fail: 0, outputLength: 0, transitions: new Map() }];

  for (const pattern of patterns) {
    let current = 0;
    for (const value of pattern) {
      const currentNode = nodes[current] as AutomatonNode;
      let next = currentNode.transitions.get(value);
      if (next === undefined) {
        next = nodes.length;
        nodes.push({
          depth: currentNode.depth + 1,
          fail: 0,
          outputLength: 0,
          transitions: new Map(),
        });
        currentNode.transitions.set(value, next);
      }
      current = next;
    }
    const terminalNode = nodes[current] as AutomatonNode;
    terminalNode.outputLength = Math.max(terminalNode.outputLength, pattern.length);
  }

  const queue: number[] = [];
  for (const child of (nodes[0] as AutomatonNode).transitions.values()) queue.push(child);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] as number;
    const currentNode = nodes[current] as AutomatonNode;
    for (const [value, child] of currentNode.transitions.entries()) {
      let fallback = currentNode.fail;
      while (fallback !== 0 && !(nodes[fallback] as AutomatonNode).transitions.has(value)) {
        fallback = (nodes[fallback] as AutomatonNode).fail;
      }
      const childNode = nodes[child] as AutomatonNode;
      const fallbackNode = nodes[fallback] as AutomatonNode;
      childNode.fail = fallbackNode.transitions.get(value) ?? 0;
      childNode.outputLength = Math.max(
        childNode.outputLength,
        (nodes[childNode.fail] as AutomatonNode).outputLength
      );
      queue.push(child);
    }
  }

  return nodes;
}

export function scanAutomaton(
  nodes: readonly AutomatonNode[],
  length: number,
  valueAt: (index: number) => number,
  onMatch: (start: number, end: number) => void
): number {
  let state = 0;
  for (let index = 0; index < length; index += 1) {
    const value = valueAt(index);
    let next = (nodes[state] as AutomatonNode).transitions.get(value);
    while (state !== 0 && next === undefined) {
      state = (nodes[state] as AutomatonNode).fail;
      next = (nodes[state] as AutomatonNode).transitions.get(value);
    }
    state = next ?? 0;
    const matchLength = (nodes[state] as AutomatonNode).outputLength;
    if (matchLength > 0) onMatch(index - matchLength + 1, index + 1);
  }
  return (nodes[state] as AutomatonNode).depth;
}
