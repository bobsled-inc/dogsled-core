export type RuleExpression =
  | { kind: 'literal'; type: 'Decimal' | 'String' | 'Boolean' }
  | { kind: 'reference'; parts: string[]; args?: RuleExpression[] }
  | { kind: 'unary'; operator: string; value: RuleExpression }
  | { kind: 'binary'; operator: string; left: RuleExpression; right: RuleExpression };

export class RuleIssue extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export const unsupported = (message: string): never => {
  throw new RuleIssue('expression_not_verified', message);
};
const syntax = (message: string): never => {
  throw new RuleIssue('expression_syntax', message);
};

/** Parse only the documented rule forms. Other expression languages stay explicit context. */
export function parseRule(text: string): RuleExpression {
  const tokens: string[] = [];
  const token =
    /\s+|(?:'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*")|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}_]*|<=|>=|==|!=|[<>=().,]/uy;
  let offset = 0;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) unsupported('This expression uses syntax outside the supported rule forms.');
    offset = token.lastIndex;
    if (!/^\s+$/u.test(match![0])) tokens.push(match![0]);
    if (tokens.length > 1000) unsupported('Rule checking is limited to 1000 tokens.');
  }
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++] ?? syntax('Expected an expression.');
  const expect = (value: string) => {
    if (take() !== value) syntax(`Expected ${value}.`);
  };
  const priority = (value: string | undefined) => {
    if (value?.toUpperCase() === 'OR') return 1;
    if (value?.toUpperCase() === 'AND') return 2;
    if (value && ['<', '>', '<=', '>=', '==', '!=', '='].includes(value)) return 3;
    return 0;
  };
  const parse = (minimum = 1, depth = 0): RuleExpression => {
    if (depth > 64) unsupported('Rule nesting exceeds the supported validation depth.');
    const first = take();
    let left: RuleExpression;
    if (first === '(') {
      left = parse(1, depth + 1);
      expect(')');
    } else if (first.toUpperCase() === 'NOT' || first.toUpperCase() === 'EXISTS') {
      left = {
        kind: 'unary',
        operator: first.toUpperCase(),
        value: parse(first.toUpperCase() === 'NOT' ? 3 : 4, depth + 1),
      };
    } else if (/^["']/u.test(first)) left = { kind: 'literal', type: 'String' };
    else if (/^-?\d/u.test(first)) left = { kind: 'literal', type: 'Decimal' };
    else if (/^(true|false)$/iu.test(first)) left = { kind: 'literal', type: 'Boolean' };
    else if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(first)) {
      const parts = [first];
      while (peek() === '.') {
        take();
        const part = take();
        if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(part)) {
          syntax('Expected a relationship name after a dot.');
        }
        parts.push(part);
      }
      let args: RuleExpression[] | undefined;
      if (peek() === '(') {
        take();
        args = [];
        if (peek() !== ')') {
          args.push(parse(1, depth + 1));
          while (peek() === ',') {
            take();
            args.push(parse(1, depth + 1));
          }
        }
        expect(')');
      }
      left = { kind: 'reference', parts, ...(args ? { args } : {}) };
    } else syntax('Expected a value or a concept reference.');
    while (priority(peek()) >= minimum) {
      const operator = take().toUpperCase();
      left = {
        kind: 'binary',
        operator,
        left: left!,
        right: parse(priority(operator) + 1, depth + 1),
      };
    }
    return left!;
  };
  const expression = parse();
  if (position !== tokens.length) {
    unsupported('This expression uses syntax outside the supported rule forms.');
  }
  return expression;
}
