/**
 * A small evaluator for the subset of GitHub Actions expressions that action.yml and the
 * workflows use, so tests can decide which steps run from the real `if:` fields:
 *
 *   status functions success() failure() always() cancelled(), context paths
 *   (inputs.x, steps.<id>.outcome, steps.<id>.outputs.<name>, runner.os, github.x),
 *   'string' literals, numbers, true/false/null, == != && || ! and parentheses.
 *
 * Semantics follow GitHub's: == compares strings case-insensitively and coerces
 * mismatched types to numbers (null and '' are 0), && and || return an operand, and an
 * `if:` without a status function means `success() && (...)`.
 */

const STATUS_FUNCTIONS = ['success', 'failure', 'always', 'cancelled'];

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    const two = source.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if ('!().'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    if (ch === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= source.length) throw new Error(`unterminated string in: ${source}`);
        if (source[i] === "'" && source[i + 1] === "'") { value += "'"; i += 2; continue; }
        if (source[i] === "'") { i++; break; }
        value += source[i++];
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    const num = source.slice(i).match(/^-?\d+(\.\d+)?/);
    if (num) { tokens.push({ type: 'number', value: Number(num[0]) }); i += num[0].length; continue; }
    const ident = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (ident) { tokens.push({ type: 'ident', value: ident[0] }); i += ident[0].length; continue; }
    throw new Error(`unexpected "${ch}" in expression: ${source}`);
  }
  return tokens;
}

function truthy(value) {
  return !(value === false || value === null || value === undefined || value === '' || value === 0 || Number.isNaN(value));
}

function looseEquals(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null && b === null) return true;
  if (typeof a === typeof b && a !== null && b !== null) {
    return typeof a === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  const num = (v) => (v === null ? 0 : typeof v === 'boolean' ? Number(v) : Number(v));
  return num(a) === num(b);
}

function parse(tokens, source) {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value) => peek()?.type === 'op' && peek().value === value;
  const expectOp = (value) => {
    if (!isOp(value)) throw new Error(`expected "${value}" in expression: ${source}`);
    pos++;
  };

  function primary() {
    const tok = tokens[pos++];
    if (!tok) throw new Error(`unexpected end of expression: ${source}`);
    if (tok.type === 'op' && tok.value === '(') {
      const node = or();
      expectOp(')');
      return node;
    }
    if (tok.type === 'string' || tok.type === 'number') return { kind: 'lit', value: tok.value };
    if (tok.type === 'ident') {
      if (['true', 'false', 'null'].includes(tok.value)) return { kind: 'lit', value: JSON.parse(tok.value) };
      if (isOp('(')) {
        pos++;
        expectOp(')');
        if (!STATUS_FUNCTIONS.includes(tok.value)) throw new Error(`unsupported function ${tok.value}() in: ${source}`);
        return { kind: 'status', name: tok.value };
      }
      const parts = [tok.value];
      while (isOp('.')) {
        pos++;
        const next = tokens[pos++];
        if (next?.type !== 'ident') throw new Error(`bad property access in: ${source}`);
        parts.push(next.value);
      }
      return { kind: 'path', parts };
    }
    throw new Error(`unexpected token "${tok.value}" in: ${source}`);
  }
  function unary() {
    if (isOp('!')) { pos++; return { kind: 'not', arg: unary() }; }
    return comparison();
  }
  function comparison() {
    const left = primary();
    if (isOp('==') || isOp('!=')) {
      const op = tokens[pos++].value;
      return { kind: 'cmp', op, left, right: primary() };
    }
    return left;
  }
  function and() {
    let node = unary();
    while (isOp('&&')) { pos++; node = { kind: 'and', left: node, right: unary() }; }
    return node;
  }
  function or() {
    let node = and();
    while (isOp('||')) { pos++; node = { kind: 'or', left: node, right: and() }; }
    return node;
  }

  const tree = or();
  if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos].value}" in expression: ${source}`);
  return tree;
}

/** Resolves a context path. Unknown contexts and unknown inputs throw (a typo in action.yml); a missing step value is null. */
function resolve(parts, context) {
  const [root, ...rest] = parts;
  if (!(root in context)) throw new Error(`unknown context "${root}" (in ${parts.join('.')})`);
  let current = context[root];
  for (const [i, part] of rest.entries()) {
    if (current === null || current === undefined || !(part in Object(current))) {
      if (root === 'inputs' && i === 0) throw new Error(`unknown input "${part}"`);
      return null;
    }
    current = current[part];
  }
  return current ?? null;
}

function evalNode(node, context, status) {
  switch (node.kind) {
    case 'lit': return node.value;
    case 'path': return resolve(node.parts, context);
    case 'status':
      if (node.name === 'success') return !status.failed && !status.cancelled;
      if (node.name === 'failure') return status.failed;
      if (node.name === 'always') return true;
      return status.cancelled;
    case 'not': return !truthy(evalNode(node.arg, context, status));
    case 'cmp': {
      const equal = looseEquals(evalNode(node.left, context, status), evalNode(node.right, context, status));
      return node.op === '==' ? equal : !equal;
    }
    case 'and': {
      const left = evalNode(node.left, context, status);
      return truthy(left) ? evalNode(node.right, context, status) : left;
    }
    case 'or': {
      const left = evalNode(node.left, context, status);
      return truthy(left) ? left : evalNode(node.right, context, status);
    }
    default: throw new Error(`bad node ${node.kind}`);
  }
}

const unwrap = (text) => {
  const m = String(text).trim().match(/^\$\{\{([\s\S]*)\}\}$/);
  return (m ? m[1] : String(text)).trim();
};

/**
 * Evaluates an expression (with or without the ${{ }} wrapper).
 *
 * @param {string} expression
 * @param {object} context - { inputs, steps, runner, github, ... }
 * @param {{ failed?: boolean, cancelled?: boolean }} [status] - The job/composite status so far
 */
export function evaluateExpression(expression, context, status = {}) {
  const source = unwrap(expression);
  return evalNode(parse(tokenize(source), source), context, { failed: false, cancelled: false, ...status });
}

/** Whether a step with this `if:` runs. No `if:` means success(); one without a status function means success() && (...). */
export function shouldRunStep(condition, context, status = {}) {
  if (condition === undefined || condition === null || condition === '') return evaluateExpression('success()', context, status);
  const source = typeof condition === 'boolean' ? String(condition) : unwrap(condition);
  const usesStatus = STATUS_FUNCTIONS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
  return truthy(evaluateExpression(usesStatus ? source : `success() && (${source})`, context, status));
}

/** Replaces every ${{ ... }} in a string (env:, with:, output values) by its value; null becomes ''. */
export function interpolate(value, context, status = {}) {
  if (typeof value !== 'string') return String(value);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const result = evaluateExpression(expr, context, status);
    return result === null || result === undefined ? '' : String(result);
  });
}
