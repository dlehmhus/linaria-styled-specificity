'use strict';

// Small oxc AST helpers shared by the analyzer modules.

const isNode = (value) =>
  typeof value === 'object' && value !== null && typeof value.type === 'string';

/** Strips TS-only wrappers and parentheses around an expression. */
const unwrapTS = (node) => {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression;
  }
  return current;
};

const nodeStart = (node) => node.start ?? node.range?.[0] ?? 0;

const isFunctionNode = (node) =>
  !!node &&
  (node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration');

/** String value of a string literal node (oxc emits both shapes), else null. */
const stringLiteralValue = (node) => {
  const n = unwrapTS(node);
  if (!n) return null;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  return null;
};

/** True for null / undefined / boolean / numeric literal nodes: no class flows from them. */
const isInertLiteral = (node) => {
  const n = unwrapTS(node);
  if (!n) return true;
  if (n.type === 'NullLiteral' || n.type === 'BooleanLiteral' || n.type === 'NumericLiteral') {
    return true;
  }
  if (n.type === 'Literal' && (n.value === null || typeof n.value !== 'string')) return true;
  if (n.type === 'Identifier' && n.name === 'undefined') return true;
  return false;
};

/** Name of a static property key (`key`, `'key'`), else null. */
const propertyKeyName = (prop) => {
  if (!prop || prop.computed) return null;
  const key = prop.key;
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  return stringLiteralValue(key);
};

// Generic pre-order walk with ancestor tracking. `enter` may return false to
// skip a subtree. oxc reuses node objects for shorthand properties, so visits
// are deduplicated.
const walk = (node, enter, ancestors = [], seen = new WeakSet()) => {
  if (!isNode(node)) return;
  if (seen.has(node)) return;
  seen.add(node);
  if (enter(node, ancestors) === false) return;
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'range' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item, enter, ancestors, seen);
    } else {
      walk(value, enter, ancestors, seen);
    }
  }
  ancestors.pop();
};

module.exports = {
  isNode,
  unwrapTS,
  nodeStart,
  isFunctionNode,
  stringLiteralValue,
  isInertLiteral,
  propertyKeyName,
  walk,
};
