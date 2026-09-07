'use strict';

// Build-time static tracer for the styled processor
// (../styled-processor.cjs): given a file and a component name, discovers
// which JSX targets the component forwards its `className` prop to.
//
// Deliberately conservative: any use of `className` it cannot prove to end up
// in a `className` attribute of a known JSX target makes the whole trace
// `unsupported`, which the processor turns into a build error. Wrong-but-silent
// selector derivation is never acceptable.
//
// Contract boundary (parity with the declaration API this replaced): the
// selector has to out-rank the wrapped component's OWN Linaria rules. Values
// that only the consumer controls are outside that contract and contribute no
// chain:
//   - class strings arriving through OTHER props (`rootClassName`,
//     `containerStyle`), unless the call site inside the traced tree binds
//     them to something provable
//   - elements chosen by the consumer or a provider (`as`-style props,
//     components pulled from a hook / context)
//

const path = require('path');
const fs = require('fs');
const {
  unwrapTS,
  isFunctionNode,
  stringLiteralValue,
  isInertLiteral,
  propertyKeyName,
  walk,
} = require('./ast-utils.cjs');

// oxc-parser ships ESM only: Node's require(esm) loads it natively, jest maps
// it to the CJS adapter in __jest__/oxc-parser.cjs (see jest.config.mjs).
const oxc = require('oxc-parser');
const resolveSync = require('resolve').sync;

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const CX_NAMES = new Set(['cx', 'clsx', 'classNames']);

const isHookName = (name) => /^use[A-Z0-9]/.test(name);

// BinaryExpression operators whose result is a boolean/primitive check: the
// operand value itself does not flow onward.
const COMPARISON_OPERATORS = new Set([
  '==', '!=', '===', '!==', '<', '<=', '>', '>=', 'in', 'instanceof',
]);

const MAX_DEPTH = 10;

class Unprovable extends Error {}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

// Dev servers transform the same files repeatedly while their content
// changes, so entries are keyed on a stat-derived version (mtimeMs:size) and
// re-parsed when it moves. Bounded so retained ASTs cannot grow without limit.
const PARSE_CACHE_MAX_ENTRIES = 1000;
const parseCache = new Map();

/** Stat-derived file version. Exported for dependent caches. */
const fileVersion = (filename) => {
  const stat = fs.statSync(filename);
  return `${stat.mtimeMs}:${stat.size}`;
};

const parseFile = (filename) => {
  const version = fileVersion(filename);
  const cached = parseCache.get(filename);
  if (cached?.version === version) return cached;
  const code = fs.readFileSync(filename, 'utf8');
  const result = oxc.parseSync(filename, code, {
    astType: 'ts',
    range: true,
    sourceType: 'unambiguous',
  });
  const fatal = result.errors.find((e) => e.severity === 'Error');
  if (fatal) {
    throw new Error(`parse error in ${filename}: ${fatal.message}`);
  }
  const parsed = { program: result.program, code, version };
  if (parseCache.size >= PARSE_CACHE_MAX_ENTRIES) {
    // evict the oldest entry (Map preserves insertion order)
    parseCache.delete(parseCache.keys().next().value);
  }
  parseCache.delete(filename); // re-insert to refresh recency
  parseCache.set(filename, parsed);
  return parsed;
};

// ---------------------------------------------------------------------------
// module-level declaration lookup
// ---------------------------------------------------------------------------

const isStyledTag = (tag) => {
  const t = unwrapTS(tag);
  if (!t) return false;
  // styled.div``  |  styled('div')``  |  styled(X)``
  if (t.type === 'MemberExpression' || t.type === 'StaticMemberExpression') {
    return t.object?.type === 'Identifier' && t.object.name === 'styled';
  }
  if (t.type === 'CallExpression') {
    return t.callee?.type === 'Identifier' && t.callee.name === 'styled';
  }
  return false;
};

const isCssTag = (tag) => {
  const t = unwrapTS(tag);
  return t?.type === 'Identifier' && t.name === 'css';
};

// Alias-following (const A = B, m.create(X), memo(X), export aliases) loses
// the name the final binding lives under; it rides along as aliasOf for
// callers that key per-file info by binding name.
const withAliasName = (binding, name) => {
  if (!binding) return binding;
  if (binding.aliasOf) return binding;
  return { ...binding, aliasOf: name };
};

/**
 * The component function a factory returns, or null when there is not exactly
 * one statically visible one: `(Icon) => (props) => <Icon {...props} />`, or
 * the `const C = (props) => ...; C.displayName = ...; return C;` shape HOFs use
 * to name what they produce.
 */
const returnedFunctionOf = (factory) => {
  const returns = returnExpressions(factory);
  if (returns.length !== 1) return null;
  const returned = unwrapTS(returns[0]);
  if (!returned) return null;
  if (isFunctionNode(returned)) return returned;
  if (returned.type !== 'Identifier') return null;
  const declared = [];
  walk(factory.body, (node) => {
    // declarators inside nested functions belong to those, not to the factory
    if (isFunctionNode(node)) return false;
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name === returned.name
    ) {
      declared.push(unwrapTS(node.init));
    }
    return undefined;
  });
  return declared.length === 1 && isFunctionNode(declared[0])
    ? declared[0]
    : null;
};

/**
 * Maps a factory's parameter names to the argument expressions of one call
 * site, so free identifiers of the returned function (`Icon`) resolve to what
 * this instance was built with. Same file by construction: the factory binding
 * is looked up in the program the call sits in. Params the call cannot bind
 * provably (destructured, spread argument, missing) are left out and fail
 * loudly where they are read.
 */
const closureBindings = (factory, args) => {
  const bindings = new Map();
  (factory.params ?? []).forEach((param, index) => {
    const p = param?.type === 'AssignmentPattern' ? param.left : param;
    if (p?.type !== 'Identifier') return;
    const arg = unwrapTS(args?.[index]);
    if (!arg || arg.type === 'SpreadElement') return;
    bindings.set(p.name, arg);
  });
  return bindings;
};

/**
 * Finds what `name` is bound to at module level of `program`.
 * Returns a descriptor:
 *  - { kind: 'function', node } (plus `closure` when the function is what a
 *    local factory call returns: Map(param name -> argument expression))
 *  - { kind: 'styled', node } / { kind: 'css', node }   (Linaria-tagged declarations)
 *  - { kind: 'import', source, imported }   (imported binding)
 *  - { kind: 'reexport', source, imported } (export { x } from '...')
 *  - { kind: 'star-reexports', sources }    (only `export *` candidates left)
 *  - { kind: 'expression', node }           (anything else)
 *  - null (not found)
 */
const findModuleBinding = (program, name, factoriesSeen = new Set()) => {
  const starSources = [];
  for (const rawStatement of program.body) {
    if (rawStatement.type === 'ExportAllDeclaration' && rawStatement.source) {
      starSources.push(rawStatement.source.value);
      continue;
    }
    let statement = rawStatement;
    // export default Foo / export default function Foo() {}
    if (statement.type === 'ExportDefaultDeclaration' && name === 'default') {
      const declaration = unwrapTS(statement.declaration);
      if (isFunctionNode(declaration)) return { kind: 'function', node: declaration };
      if (declaration?.type === 'Identifier') {
        return withAliasName(findModuleBinding(program, declaration.name), declaration.name);
      }
      return { kind: 'expression', node: declaration };
    }
    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
    ) {
      if (statement.type === 'ExportNamedDeclaration') {
        // export { X } from './x'  /  export { Y as X } from './x'
        if (statement.source) {
          for (const spec of statement.specifiers ?? []) {
            const exported = spec.exported?.name ?? spec.exported?.value;
            if (exported === name) {
              return {
                kind: 'reexport',
                source: statement.source.value,
                imported: spec.local?.name ?? spec.local?.value,
              };
            }
          }
          continue;
        }
        // export { Impl as X };  (local alias export)
        for (const spec of statement.specifiers ?? []) {
          const exported = spec.exported?.name ?? spec.exported?.value;
          if (exported === name && spec.local?.name && spec.local.name !== name) {
            return withAliasName(findModuleBinding(program, spec.local.name), spec.local.name);
          }
        }
      }
      if (statement.declaration) statement = statement.declaration;
      else continue;
    }
    if (statement.type === 'ImportDeclaration') {
      for (const spec of statement.specifiers ?? []) {
        if (spec.local?.name !== name) continue;
        if (spec.type === 'ImportDefaultSpecifier') {
          return { kind: 'import', source: statement.source.value, imported: 'default' };
        }
        if (spec.type === 'ImportSpecifier') {
          return {
            kind: 'import',
            source: statement.source.value,
            imported: spec.imported?.name ?? spec.imported?.value,
          };
        }
      }
      continue;
    }
    if (statement.type === 'FunctionDeclaration' && statement.id?.name === name) {
      return { kind: 'function', node: statement };
    }
    if (statement.type === 'VariableDeclaration') {
      for (const decl of statement.declarations) {
        if (decl.id?.type !== 'Identifier' || decl.id.name !== name) continue;
        const init = unwrapTS(decl.init);
        if (!init) return null;
        if (isFunctionNode(init)) return { kind: 'function', node: init };
        if (init.type === 'TaggedTemplateExpression') {
          if (isStyledTag(init.tag)) return { kind: 'styled', node: init };
          if (isCssTag(init.tag)) return { kind: 'css', node: init };
          return { kind: 'expression', node: init };
        }
        if (init.type === 'CallExpression') {
          const callee = unwrapTS(init.callee);
          // memo(Fn) / forwardRef(Fn) / memo(forwardRef(Fn))
          if (
            callee?.type === 'Identifier' &&
            (callee.name === 'memo' || callee.name === 'forwardRef')
          ) {
            const arg = unwrapTS(init.arguments?.[0]);
            if (isFunctionNode(arg)) return { kind: 'function', node: arg };
            if (arg?.type === 'Identifier') return withAliasName(findModuleBinding(program, arg.name), arg.name);
          }
          // m.create(X) / motion.create(X): framer-motion wrappers forward className
          if (
            (callee?.type === 'MemberExpression' || callee?.type === 'StaticMemberExpression') &&
            callee.property?.name === 'create' &&
            callee.object?.type === 'Identifier' &&
            (callee.object.name === 'm' || callee.object.name === 'motion')
          ) {
            const arg = unwrapTS(init.arguments?.[0]);
            if (isFunctionNode(arg)) return { kind: 'function', node: arg };
            if (arg?.type === 'Identifier') return withAliasName(findModuleBinding(program, arg.name), arg.name);
          }
          // factory(Inner, ...): a local function that returns a component
          // function. The returned function is the component; the factory's
          // params ride along bound to this call's arguments.
          if (
            callee?.type === 'Identifier' &&
            callee.name !== name &&
            !factoriesSeen.has(callee.name)
          ) {
            const factory = findModuleBinding(
              program,
              callee.name,
              new Set(factoriesSeen).add(name),
            );
            if (factory?.kind === 'function') {
              const produced = returnedFunctionOf(factory.node);
              if (produced) {
                return {
                  kind: 'function',
                  node: produced,
                  closure: closureBindings(factory.node, init.arguments),
                };
              }
            }
          }
          return { kind: 'expression', node: init };
        }
        if (init.type === 'Identifier') return withAliasName(findModuleBinding(program, init.name), init.name);
        return { kind: 'expression', node: init };
      }
    }
  }
  if (starSources.length > 0) {
    return { kind: 'star-reexports', sources: starSources };
  }
  return null;
};

// ---------------------------------------------------------------------------
// cross-file resolution
// ---------------------------------------------------------------------------

// realpath so pnpm workspace symlinks resolve back into
// repo sources instead of being misread as external packages
const resolveModule = (source, fromFile) => {
  const resolved = resolveSync(source, {
    basedir: path.dirname(fromFile),
    extensions: DEFAULT_EXTENSIONS,
  });
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const isExternalFile = (filename) => filename.includes(`${path.sep}node_modules${path.sep}`);

/**
 * Resolves `name` in `filename` to its defining file + module binding,
 * following imports and re-exports. Returns
 * { filename, name, binding } with binding from findModuleBinding, or throws.
 */
const resolveBinding = (filename, name, depth = 0) => {
  if (depth > MAX_DEPTH) throw new Error(`import chain too deep for ${name}`);
  const { program } = parseFile(filename);
  const binding = findModuleBinding(program, name);
  if (!binding) {
    throw new Error(`no module-level binding '${name}' in ${filename}`);
  }
  if (binding.kind === 'import' || binding.kind === 'reexport') {
    const next = resolveModule(binding.source, filename);
    if (isExternalFile(next)) {
      return { filename: next, name: binding.imported, binding: { kind: 'external' } };
    }
    return resolveBinding(next, binding.imported, depth + 1);
  }
  if (binding.kind === 'star-reexports') {
    for (const source of binding.sources) {
      const next = resolveModule(source, filename);
      if (isExternalFile(next)) continue;
      try {
        return resolveBinding(next, name, depth + 1);
      } catch {
        // not exported from this star source; try the next one
      }
    }
    throw new Error(`'${name}' not found behind export * in ${filename}`);
  }
  return { filename, name, binding };
};

/**
 * Static string value of a module-level identifier (`const X = 'img-error'`,
 * template literals over such constants, imports of either), or null.
 */
const staticStringOf = (filename, name, depth = 0) => {
  if (depth > MAX_DEPTH) return null;
  let resolved;
  try {
    resolved = resolveBinding(filename, name);
  } catch {
    return null;
  }
  if (resolved.binding.kind !== 'expression') return null;
  return staticStringOfExpression(resolved.filename, resolved.binding.node, depth + 1);
};

const staticStringOfExpression = (filename, node, depth = 0) => {
  const n = unwrapTS(node);
  if (!n) return null;
  const literal = stringLiteralValue(n);
  if (literal !== null) return literal;
  if (n.type === 'Identifier') return staticStringOf(filename, n.name, depth);
  if (n.type === 'TemplateLiteral') {
    let assembled = '';
    for (let i = 0; i < n.quasis.length; i += 1) {
      assembled += n.quasis[i].value?.cooked ?? n.quasis[i].value?.raw ?? '';
      if (i < n.expressions.length) {
        const part = staticStringOfExpression(filename, n.expressions[i], depth + 1);
        if (part === null) return null;
        assembled += part;
      }
    }
    return assembled;
  }
  return null;
};

// ---------------------------------------------------------------------------
// function scope model
// ---------------------------------------------------------------------------

const isCxCallee = (callee) => {
  const c = unwrapTS(callee);
  return c?.type === 'Identifier' && CX_NAMES.has(c.name);
};

const isHookCall = (node) => {
  const n = unwrapTS(node);
  if (n?.type !== 'CallExpression') return false;
  const callee = unwrapTS(n.callee);
  if (callee?.type === 'Identifier') return isHookName(callee.name);
  if (callee?.type === 'MemberExpression' || callee?.type === 'StaticMemberExpression') {
    return callee.property?.type === 'Identifier' && isHookName(callee.property.name);
  }
  return false;
};

const isMember = (node) =>
  node?.type === 'MemberExpression' || node?.type === 'StaticMemberExpression';

const patternIdentifiers = (pattern, out = []) => {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'AssignmentPattern':
      patternIdentifiers(pattern.left, out);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties ?? []) {
        if (prop.type === 'RestElement') patternIdentifiers(prop.argument, out);
        else patternIdentifiers(prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements ?? []) patternIdentifiers(element, out);
      break;
    case 'RestElement':
      patternIdentifiers(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
};

/**
 * Builds the scope model of one component / helper function.
 *
 * `inputs` describes what each parameter receives, in call order:
 *   { kind: 'props', tracked: string[] }  an object whose keys named in
 *                                          `tracked` carry the traced value
 *                                          (component props; `tracked` is
 *                                          ['className'] at the top level)
 *   { kind: 'tracked' }                    the traced value itself
 *   { kind: 'value', refs }                a provable class value (helper args)
 *   { kind: 'unknown' }                    anything else
 */
// What a module-level expression sees: nothing local, every identifier is a
// module binding. Factory arguments are resolved against this.
const MODULE_SCOPE = Object.freeze({
  tracked: new Set(),
  carriers: new Set(),
  propNames: new Set(),
  values: new Map(),
  locals: new Map(),
  hookResults: new Set(),
  aliases: new Map(),
  siteProps: null,
});

const buildScope = (fn, inputs, siteProps, parent = null, closure = null) => {
  // A closure declared inside a component (`const getStyle = () => ...`)
  // sees the component's bindings; its own params shadow them.
  const inheritSet = (key) => new Set(parent?.[key] ?? []);
  const inheritMap = (key) => new Map(parent?.[key] ?? []);
  const scope = {
    fn,
    tracked: inheritSet('tracked'), // identifiers carrying the traced class value
    carriers: inheritSet('carriers'), // objects still containing a tracked prop key
    carrierTracked: inheritMap('carrierTracked'), // carrier -> Set(prop keys that are tracked)
    propNames: inheritSet('propNames'), // identifiers bound from a carrier (consumer-controlled)
    propOrigin: inheritMap('propOrigin'), // local identifier -> prop key
    propDefaults: inheritMap('propDefaults'), // local identifier -> default expression
    values: inheritMap('values'), // helper params bound to provable class values
    locals: inheritMap('locals'), // local identifier -> [expressions assigned]
    hookResults: inheritSet('hookResults'), // identifiers bound from hook results (runtime)
    aliases: closure ? new Map(closure) : inheritMap('aliases'), // factory param -> call-site argument expression
    siteProps: siteProps ?? parent?.siteProps ?? null, // Map(prop key -> { tracked, refs }) from the call site
    failures: [],
  };
  const shadow = (name) => {
    scope.tracked.delete(name);
    scope.carriers.delete(name);
    scope.propNames.delete(name);
    scope.values.delete(name);
    scope.locals.delete(name);
    scope.hookResults.delete(name);
    scope.aliases.delete(name);
  };
  if (parent) {
    for (const param of fn.params ?? []) {
      for (const name of patternIdentifiers(param)) shadow(name);
    }
  }

  const bindPattern = (pattern, input) => {
    let p = pattern;
    if (p?.type === 'TSParameterProperty') p = p.parameter;
    if (p?.type === 'AssignmentPattern') p = p.left;
    if (!p) return;
    if (input.kind === 'tracked') {
      if (p.type === 'Identifier') scope.tracked.add(p.name);
      else scope.failures.push('traced value destructured into a non-identifier pattern');
      return;
    }
    if (input.kind === 'value') {
      if (p.type === 'Identifier') scope.values.set(p.name, input.refs);
      return;
    }
    if (input.kind !== 'props') return;
    if (p.type === 'Identifier') {
      scope.carriers.add(p.name);
      scope.carrierTracked.set(p.name, new Set(input.tracked));
      return;
    }
    if (p.type === 'ObjectPattern') destructureCarrier(p, new Set(input.tracked));
  };

  // `{ className, variant = 'x', ...rest }` from a carrier
  const destructureCarrier = (objectPattern, trackedKeys) => {
    const seenKeys = new Set();
    for (const prop of objectPattern.properties ?? []) {
      if (prop.type === 'RestElement') continue;
      const key = propertyKeyName(prop);
      if (key === null) {
        scope.failures.push('computed key in a props destructuring pattern');
        continue;
      }
      seenKeys.add(key);
      let value = prop.value;
      let defaultValue = null;
      if (value?.type === 'AssignmentPattern') {
        defaultValue = value.right;
        value = value.left;
      }
      if (value?.type !== 'Identifier') {
        if (trackedKeys.has(key)) {
          scope.failures.push(`prop '${key}' destructured into a non-identifier pattern`);
        }
        continue;
      }
      if (trackedKeys.has(key)) {
        scope.tracked.add(value.name);
      } else {
        scope.propNames.add(value.name);
        scope.propOrigin.set(value.name, key);
        if (defaultValue) scope.propDefaults.set(value.name, defaultValue);
      }
    }
    for (const prop of objectPattern.properties ?? []) {
      if (prop.type !== 'RestElement' || prop.argument?.type !== 'Identifier') continue;
      const remaining = new Set([...trackedKeys].filter((key) => !seenKeys.has(key)));
      scope.carriers.add(prop.argument.name);
      scope.carrierTracked.set(prop.argument.name, remaining);
    }
  };

  (fn.params ?? []).forEach((param, index) => {
    bindPattern(param, inputs[index] ?? { kind: 'unknown' });
  });

  if (!fn.body) return scope;

  // Body-level bindings, to a fixed point (carriers can be derived from
  // carriers): destructures of carriers, `{...props}` merges, hook results,
  // plain locals and their later assignments.
  let changed = true;
  const handledDeclarators = new WeakSet();
  while (changed) {
    changed = false;
    walk(fn.body, (node) => {
      if (isFunctionNode(node) && node !== fn) {
        // nested callbacks share the scope; their own params are not props
        for (const param of node.params ?? []) {
          for (const name of patternIdentifiers(param)) {
            if (!scope.locals.has(name)) scope.locals.set(name, []);
          }
        }
      }
      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
        const name = node.left.name;
        if (scope.locals.has(name)) {
          const list = scope.locals.get(name);
          if (!list.includes(node.right)) list.push(node.right);
        }
        return;
      }
      if (node.type !== 'VariableDeclarator' || handledDeclarators.has(node)) return;
      const init = unwrapTS(node.init);
      if (node.id?.type === 'ObjectPattern') {
        if (init?.type === 'Identifier' && scope.carriers.has(init.name)) {
          handledDeclarators.add(node);
          destructureCarrier(node.id, scope.carrierTracked.get(init.name) ?? new Set());
          changed = true;
          return;
        }
        if (init && isHookCall(init)) {
          handledDeclarators.add(node);
          for (const name of patternIdentifiers(node.id)) scope.hookResults.add(name);
          return;
        }
        if (!init || init.type === 'Identifier') return; // wait for carrier discovery
        handledDeclarators.add(node);
        for (const name of patternIdentifiers(node.id)) {
          if (!scope.locals.has(name)) scope.locals.set(name, []);
        }
        return;
      }
      if (node.id?.type === 'ArrayPattern') {
        handledDeclarators.add(node);
        const names = patternIdentifiers(node.id);
        for (const name of names) {
          if (init && isHookCall(init)) scope.hookResults.add(name);
          else if (!scope.locals.has(name)) scope.locals.set(name, []);
        }
        return;
      }
      if (node.id?.type !== 'Identifier') return;
      const name = node.id.name;
      if (scope.carriers.has(name) || scope.tracked.has(name)) return;
      if (init?.type === 'ObjectExpression') {
        // `const merged = { ...props, foo }`: a new carrier unless the
        // tracked keys are re-set
        const spreadCarriers = (init.properties ?? [])
          .filter((prop) => prop.type === 'SpreadElement')
          .map((prop) => unwrapTS(prop.argument))
          .filter((arg) => arg?.type === 'Identifier' && scope.carriers.has(arg.name));
        if (spreadCarriers.length > 0) {
          const trackedKeys = new Set();
          for (const carrier of spreadCarriers) {
            for (const key of scope.carrierTracked.get(carrier.name) ?? []) trackedKeys.add(key);
          }
          for (const prop of init.properties ?? []) {
            if (prop.type === 'SpreadElement') continue;
            const key = propertyKeyName(prop);
            if (key !== null) trackedKeys.delete(key);
          }
          handledDeclarators.add(node);
          scope.carriers.add(name);
          scope.carrierTracked.set(name, trackedKeys);
          changed = true;
          return;
        }
      }
      if (init && isHookCall(init)) {
        handledDeclarators.add(node);
        scope.hookResults.add(name);
        return;
      }
      if (!scope.locals.has(name)) {
        scope.locals.set(name, init ? [init] : []);
      }
    });
  }
  // a factory argument is only visible where nothing closer shadows the name
  for (const name of scope.aliases.keys()) {
    if (
      scope.tracked.has(name) ||
      scope.carriers.has(name) ||
      scope.propNames.has(name) ||
      scope.values.has(name) ||
      scope.locals.has(name) ||
      scope.hookResults.has(name)
    ) {
      scope.aliases.delete(name);
    }
  }
  return scope;
};

// ---------------------------------------------------------------------------
// class-expression classification
// ---------------------------------------------------------------------------

// Result of classifying an expression in class position:
//   { tracked: boolean, refs: Ref[] }
// tracked: the traced class value can be part of the result
// refs:    provable classes mixed in alongside it
//   Ref = { kind: 'css-ref', file, localName } | { kind: 'css-literal', file, localName }
const emptyClasses = () => ({ tracked: false, refs: [] });
const mergeClasses = (a, b) => ({ tracked: a.tracked || b.tracked, refs: [...a.refs, ...b.refs] });

const cxLikeArgs = (args, ctx, visiting) => {
  let result = emptyClasses();
  for (const arg of args ?? []) {
    if (arg.type === 'SpreadElement') {
      throw new Unprovable('spread argument inside cx()');
    }
    result = mergeClasses(result, classifyClassExpr(arg, ctx, visiting));
  }
  return result;
};

/**
 * Module-level object literal (`const variants = { a: cssA, b: cssB }`), or
 * null. Follows imports.
 */
const moduleObjectLiteral = (filename, name) => {
  let resolved;
  try {
    resolved = resolveBinding(filename, name);
  } catch {
    return null;
  }
  if (resolved.binding.kind !== 'expression') return null;
  const node = unwrapTS(resolved.binding.node);
  return node?.type === 'ObjectExpression' ? { filename: resolved.filename, node } : null;
};

const classifyClassExpr = (expression, ctx, visiting = new Set()) => {
  const { scope, filename } = ctx;
  const node = unwrapTS(expression);
  if (!node || isInertLiteral(node)) return emptyClasses();

  const literal = stringLiteralValue(node);
  if (literal !== null) {
    if (literal.trim() === '') return emptyClasses();
    // one literal may carry several space-separated tokens
    return {
      tracked: false,
      refs: literal
        .trim()
        .split(/\s+/)
        .map((token) => ({ kind: 'css-literal', file: filename, localName: token })),
    };
  }

  switch (node.type) {
    case 'Identifier': {
      const { name } = node;
      if (scope.tracked.has(name)) return { tracked: true, refs: [] };
      if (scope.carriers.has(name)) {
        throw new Unprovable(`props object '${name}' used as a class value`);
      }
      if (scope.values.has(name)) return { tracked: false, refs: [...scope.values.get(name)] };
      if (scope.locals.has(name)) {
        if (visiting.has(name)) return emptyClasses();
        const next = new Set(visiting).add(name);
        let result = emptyClasses();
        const inits = scope.locals.get(name);
        if (inits.length === 0) {
          throw new Unprovable(`local '${name}' has no statically visible value`);
        }
        for (const init of inits) result = mergeClasses(result, classifyClassExpr(init, ctx, next));
        return result;
      }
      if (scope.propNames.has(name)) {
        // consumer-controlled prop: use the call-site value when the traced
        // tree binds it, else the declared default, else out of contract
        const key = scope.propOrigin.get(name) ?? name;
        const site = scope.siteProps?.get(key);
        if (site) return { tracked: site.tracked, refs: [...site.refs] };
        if (scope.siteProps && scope.propDefaults.has(name)) {
          return classifyClassExpr(scope.propDefaults.get(name), ctx, visiting);
        }
        return emptyClasses();
      }
      if (scope.hookResults.has(name)) {
        throw new Unprovable(`'${name}' comes from a hook result and may carry component classes`);
      }
      const { program } = parseFile(filename);
      if (findModuleBinding(program, name)) {
        return { tracked: false, refs: [{ kind: 'css-ref', file: filename, localName: name }] };
      }
      throw new Unprovable(`unknown identifier '${name}' in class position`);
    }
    case 'TemplateLiteral': {
      if (node.expressions.length === 0) {
        return classifyClassExpr(
          { type: 'StringLiteral', value: node.quasis.map((q) => q.value?.cooked ?? '').join('') },
          ctx,
          visiting,
        );
      }
      throw new Unprovable('class value interpolated into a template literal');
    }
    case 'LogicalExpression': {
      if (node.operator === '&&') return classifyClassExpr(node.right, ctx, visiting);
      return mergeClasses(
        classifyClassExpr(node.left, ctx, visiting),
        classifyClassExpr(node.right, ctx, visiting),
      );
    }
    case 'ConditionalExpression':
      return mergeClasses(
        classifyClassExpr(node.consequent, ctx, visiting),
        classifyClassExpr(node.alternate, ctx, visiting),
      );
    case 'ArrayExpression': {
      let result = emptyClasses();
      for (const element of node.elements ?? []) {
        if (!element) continue;
        if (element.type === 'SpreadElement') throw new Unprovable('spread inside a class array');
        result = mergeClasses(result, classifyClassExpr(element, ctx, visiting));
      }
      return result;
    }
    case 'ObjectExpression': {
      // cx({ [cls]: cond, literal: cond })
      let result = emptyClasses();
      for (const prop of node.properties ?? []) {
        if (prop.type === 'SpreadElement') throw new Unprovable('spread inside a class object');
        if (prop.computed) {
          result = mergeClasses(result, classifyClassExpr(prop.key, ctx, visiting));
        } else {
          const key = propertyKeyName(prop);
          if (key !== null) {
            result = mergeClasses(
              result,
              classifyClassExpr({ type: 'StringLiteral', value: key }, ctx, visiting),
            );
          }
        }
      }
      return result;
    }
    case 'CallExpression': {
      if (isCxCallee(node.callee)) return cxLikeArgs(node.arguments, ctx, visiting);
      return classifyHelperCall(node, ctx, visiting);
    }
    case 'MemberExpression':
    case 'StaticMemberExpression':
    case 'ComputedMemberExpression': {
      const object = unwrapTS(node.object);
      if (object?.type === 'Identifier' && scope.carriers.has(object.name)) {
        if (node.computed) throw new Unprovable(`computed access on props object '${object.name}'`);
        const key = node.property?.name;
        const trackedKeys = scope.carrierTracked.get(object.name) ?? new Set();
        if (trackedKeys.has(key)) return { tracked: true, refs: [] };
        const site = scope.siteProps?.get(key);
        if (site) return { tracked: site.tracked, refs: [...site.refs] };
        return emptyClasses(); // consumer-controlled prop, out of contract
      }
      if (object?.type === 'Identifier') {
        const literalObject = moduleObjectLiteral(filename, object.name);
        if (literalObject) {
          const objectCtx = { ...ctx, filename: literalObject.filename };
          if (!node.computed) {
            const key = node.property?.name;
            const prop = (literalObject.node.properties ?? []).find(
              (p) => p.type !== 'SpreadElement' && propertyKeyName(p) === key,
            );
            if (!prop) throw new Unprovable(`'${object.name}.${key}' is not a literal property`);
            return classifyClassExpr(prop.value, objectCtx, visiting);
          }
          // variants[variant]: any value may apply
          let result = emptyClasses();
          for (const prop of literalObject.node.properties ?? []) {
            if (prop.type === 'SpreadElement') throw new Unprovable(`spread inside '${object.name}'`);
            result = mergeClasses(result, classifyClassExpr(prop.value, objectCtx, visiting));
          }
          return result;
        }
      }
      throw new Unprovable(`member expression '${ctx.code.slice(node.start ?? node.range?.[0], node.end ?? node.range?.[1])}' in class position`);
    }
    case 'BinaryExpression':
      throw new Unprovable(`class value used in '${node.operator}' expression`);
    default:
      throw new Unprovable(`${node.type} in class position`);
  }
};

// `getButtonClasses(props)`: follow the helper's return value with its
// parameters bound to what the call passes in.
const classifyHelperCall = (call, ctx, visiting) => {
  const callee = unwrapTS(call.callee);
  const calleeText = ctx.code.slice(
    call.callee.start ?? call.callee.range?.[0],
    call.callee.end ?? call.callee.range?.[1],
  );
  if (callee?.type !== 'Identifier') {
    throw new Unprovable(`class value passed through helper '${calleeText}'`);
  }
  if (isHookName(callee.name)) {
    throw new Unprovable(`class value produced by hook '${callee.name}'`);
  }
  if (ctx.depth >= MAX_DEPTH) throw new Unprovable('helper nesting too deep');

  // function-local closure (`const getStyle = () => ...` inside the component)
  let helperFn = null;
  let helperFilename = ctx.filename;
  let parentScope = null;
  const localInits = ctx.scope.locals.get(callee.name);
  if (localInits) {
    const fns = localInits.map(unwrapTS).filter(isFunctionNode);
    if (fns.length !== 1 || fns.length !== localInits.length) {
      throw new Unprovable(`class value passed to local '${callee.name}', which is not a single function`);
    }
    helperFn = fns[0];
    parentScope = ctx.scope;
  } else {
    let resolved;
    try {
      resolved = resolveBinding(ctx.filename, callee.name);
    } catch (e) {
      throw new Unprovable(`class value passed to function '${callee.name}' (${e.message})`);
    }
    if (resolved.binding.kind !== 'function') {
      throw new Unprovable(
        `class value passed to function '${callee.name}' (not a statically known function: ${resolved.binding.kind})`,
      );
    }
    helperFn = resolved.binding.node;
    helperFilename = resolved.filename;
  }
  const inputs = (call.arguments ?? []).map((arg) => {
    if (arg.type === 'SpreadElement') throw new Unprovable(`spread argument to '${callee.name}'`);
    const a = unwrapTS(arg);
    if (a?.type === 'Identifier' && ctx.scope.carriers.has(a.name)) {
      return { kind: 'props', tracked: [...(ctx.scope.carrierTracked.get(a.name) ?? [])] };
    }
    const classes = classifyClassExpr(arg, ctx, visiting);
    if (classes.tracked && classes.refs.length === 0) return { kind: 'tracked' };
    if (classes.tracked) {
      throw new Unprovable(`mixed class value passed to '${callee.name}'`);
    }
    return { kind: 'value', refs: classes.refs };
  });
  const helperFile = parseFile(helperFilename);
  const helperScope = buildScope(helperFn, inputs, null, parentScope);
  if (helperScope.failures.length > 0) {
    throw new Unprovable(`helper '${callee.name}': ${helperScope.failures.join('; ')}`);
  }
  const helperCtx = {
    filename: helperFilename,
    code: helperFile.code,
    scope: helperScope,
    depth: ctx.depth + 1,
  };
  const returns = returnExpressions(helperFn);
  if (returns.length === 0) {
    throw new Unprovable(`helper '${callee.name}' has no statically visible return value`);
  }
  let result = emptyClasses();
  try {
    for (const expression of returns) {
      result = mergeClasses(result, classifyClassExpr(expression, helperCtx));
    }
  } catch (e) {
    if (e instanceof Unprovable) throw new Unprovable(`helper '${callee.name}': ${e.message}`);
    throw e;
  }
  return result;
};

// Return expressions of a function, excluding nested functions' returns.
const returnExpressions = (fn) => {
  if (!fn.body) return [];
  if (fn.body.type !== 'BlockStatement') return [fn.body];
  const results = [];
  walk(fn.body, (node) => {
    if (isFunctionNode(node)) return false;
    if (node.type === 'ReturnStatement' && node.argument) results.push(node.argument);
    return undefined;
  });
  return results;
};

// ---------------------------------------------------------------------------
// element resolution
// ---------------------------------------------------------------------------

// -> Array<{ type: 'dom', name } | { type: 'component', name } | { type: 'runtime' }>
const resolveElementExpr = (expression, ctx, visiting = new Set()) => {
  const { scope, filename } = ctx;
  const node = unwrapTS(expression);
  if (!node) throw new Unprovable('element without a resolvable expression');
  const literal = stringLiteralValue(node);
  if (literal !== null) return [{ type: 'dom', name: literal }];
  if (isInertLiteral(node)) return [];
  switch (node.type) {
    case 'Identifier': {
      const { name } = node;
      if (scope.propNames.has(name) || scope.carriers.has(name)) return [{ type: 'runtime' }];
      if (scope.hookResults.has(name)) return [{ type: 'runtime' }];
      // factory params bind to call-site arguments, which live at module
      // level: resolve them there, so neither a component local nor the alias
      // itself (`factory(Icon)` for a param named `Icon`) shadows the lookup
      if (scope.aliases.has(name)) {
        return resolveElementExpr(
          scope.aliases.get(name),
          { ...ctx, scope: MODULE_SCOPE },
          new Set(),
        );
      }
      if (scope.locals.has(name)) {
        if (visiting.has(name)) return [];
        const next = new Set(visiting).add(name);
        const inits = scope.locals.get(name);
        if (inits.length === 0) throw new Unprovable(`element '${name}' has no statically visible value`);
        return inits.flatMap((init) => resolveElementExpr(init, ctx, next));
      }
      const { program } = parseFile(filename);
      if (findModuleBinding(program, name)) return [{ type: 'component', name }];
      throw new Unprovable(`unknown element identifier '${name}'`);
    }
    case 'ConditionalExpression':
      return [
        ...resolveElementExpr(node.consequent, ctx, visiting),
        ...resolveElementExpr(node.alternate, ctx, visiting),
      ];
    case 'LogicalExpression':
      if (node.operator === '&&') return resolveElementExpr(node.right, ctx, visiting);
      return [
        ...resolveElementExpr(node.left, ctx, visiting),
        ...resolveElementExpr(node.right, ctx, visiting),
      ];
    case 'CallExpression':
      if (isHookCall(node)) return [{ type: 'runtime' }];
      throw new Unprovable('element produced by a function call');
    case 'MemberExpression':
    case 'StaticMemberExpression':
    case 'ComputedMemberExpression': {
      const object = unwrapTS(node.object);
      if (object?.type === 'Identifier' && scope.carriers.has(object.name)) return [{ type: 'runtime' }];
      if (object?.type === 'Identifier') {
        const literalObject = moduleObjectLiteral(filename, object.name);
        if (literalObject) {
          const objectCtx = { ...ctx, filename: literalObject.filename };
          const props = (literalObject.node.properties ?? []).filter((p) => p.type !== 'SpreadElement');
          const selected = node.computed
            ? props
            : props.filter((p) => propertyKeyName(p) === node.property?.name);
          return selected.flatMap((p) => resolveElementExpr(p.value, objectCtx, visiting));
        }
      }
      throw new Unprovable('element is a member expression');
    }
    default:
      throw new Unprovable(`element expression of type ${node.type}`);
  }
};

const resolveJsxElementName = (element, ctx) => {
  const nameNode = element.openingElement?.name;
  if (!nameNode) throw new Unprovable('JSX element without a name');
  if (nameNode.type !== 'JSXIdentifier') {
    throw new Unprovable('className forwarded to a JSX member expression element');
  }
  if (/^[a-z]/.test(nameNode.name)) return [{ type: 'dom', name: nameNode.name }];
  return resolveElementExpr({ type: 'Identifier', name: nameNode.name }, ctx);
};

// ---------------------------------------------------------------------------
// tracing one component function
// ---------------------------------------------------------------------------

const attributeName = (attr) => attr.name?.name ?? attr.name?.name?.name ?? null;

/**
 * Traces the given component function. Returns
 *   { targets, failures }
 * where each target is
 *   { kind: 'dom' | 'runtime', refs }
 *   { kind: 'component', name, refs, siteProps: Map(prop -> { tracked, refs }) }
 */
const traceFunction = (fn, code, filename, inputs, siteProps, closure) => {
  const scope = buildScope(fn, inputs, siteProps, null, closure);
  const failures = [...scope.failures];
  const targets = [];
  if (!fn.body) return { targets, failures: ['function has no body'] };
  const ctx = { filename, code, scope, depth: 0 };

  const isTrackedReference = (node) =>
    node.type === 'Identifier' && (scope.tracked.has(node.name) || scope.carriers.has(node.name));

  // True when the traced value can reach this expression, directly or through
  // a local (`const classes = cx(className, x)`). Deciding it syntactically
  // would let an Unprovable behind a local pass as "not our concern" and drop
  // the target silently.
  const containsTracked = (expression, visiting = new Set()) => {
    let found = false;
    walk(expression, (node, ancestors) => {
      if (found) return false;
      const parent = ancestors[ancestors.length - 1];
      if (
        node.type === 'Identifier' &&
        !isTrackedReference(node) &&
        scope.locals.has(node.name) &&
        !visiting.has(node.name) &&
        !(isMember(parent) && parent.property === node && !parent.computed) &&
        !(parent?.type === 'Property' && parent.key === node && !parent.shorthand)
      ) {
        const next = new Set(visiting).add(node.name);
        if (scope.locals.get(node.name).some((init) => containsTracked(init, next))) {
          found = true;
          return false;
        }
        return undefined;
      }
      if (!isTrackedReference(node)) return undefined;
      // `props.other` is not a read of the tracked value
      if (isMember(parent) && parent.object === node && scope.carriers.has(node.name)) {
        const trackedKeys = scope.carrierTracked.get(node.name) ?? new Set();
        if (!parent.computed && !trackedKeys.has(parent.property?.name)) return undefined;
      }
      if (isMember(parent) && parent.property === node && !parent.computed) return undefined;
      if (parent?.type === 'Property' && parent.key === node && !parent.shorthand) return undefined;
      found = true;
      return false;
    });
    return found;
  };

  // accounted expression nodes: anything the traced value may legitimately
  // flow into (JSX attribute values, spreads, local bindings)
  const accounted = new Set();

  walk(fn.body, (node) => {
    if (node.type !== 'JSXElement') return undefined;
    const opening = node.openingElement;
    let receivesTracked = false;
    let classAttr = null;
    let spreadsCarrier = false;
    const siteAttrs = [];
    for (const attr of opening.attributes ?? []) {
      if (attr.type === 'JSXSpreadAttribute') {
        accounted.add(attr.argument);
        const arg = unwrapTS(attr.argument);
        if (arg?.type === 'Identifier' && scope.carriers.has(arg.name)) {
          if ((scope.carrierTracked.get(arg.name) ?? new Set()).size > 0) spreadsCarrier = true;
        } else if (arg && containsTracked(arg)) {
          failures.push('traced value inside a computed JSX spread');
        }
        continue;
      }
      if (attr.type !== 'JSXAttribute') continue;
      const name = attributeName(attr);
      const value = attr.value;
      if (!value) continue;
      const expression =
        value.type === 'JSXExpressionContainer' ? value.expression : value;
      accounted.add(expression);
      if (name === 'className') {
        classAttr = expression;
      } else {
        siteAttrs.push({ name, expression });
      }
    }

    let classes = emptyClasses();
    if (classAttr) {
      try {
        classes = classifyClassExpr(classAttr, ctx);
      } catch (e) {
        if (!(e instanceof Unprovable)) throw e;
        if (containsTracked(classAttr)) {
          failures.push(e.message);
          return undefined;
        }
        // className not derived from the traced value: not our concern
        classes = emptyClasses();
      }
    }
    if (classes.tracked || spreadsCarrier) receivesTracked = true;

    // other attributes: provable class values travel into the child as
    // call-site bindings; attributes carrying the traced value make the
    // child a target through that prop
    const siteProps = new Map();
    for (const { name, expression } of siteAttrs) {
      const carriesTracked = containsTracked(expression);
      try {
        const attrClasses = classifyClassExpr(expression, ctx);
        siteProps.set(name, attrClasses);
        if (attrClasses.tracked) receivesTracked = true;
      } catch (e) {
        if (!(e instanceof Unprovable)) throw e;
        if (carriesTracked) {
          failures.push(`className forwarded via prop '${name}': ${e.message}`);
          return undefined;
        }
        // not a class-like value (handlers, nodes): irrelevant to the child
      }
    }
    if (!receivesTracked) return undefined;

    let resolved;
    try {
      resolved = resolveJsxElementName(node, ctx);
    } catch (e) {
      if (!(e instanceof Unprovable)) throw e;
      failures.push(e.message);
      return undefined;
    }
    for (const target of resolved) {
      if (target.type === 'dom') {
        targets.push({ kind: 'dom', name: target.name, refs: classes.refs });
      } else if (target.type === 'runtime') {
        targets.push({ kind: 'runtime', refs: classes.refs });
      } else {
        targets.push({
          kind: 'component',
          name: target.name,
          refs: classes.refs,
          siteProps,
          trackedProps: [
            ...(classes.tracked || spreadsCarrier ? ['className'] : []),
            ...[...siteProps.entries()].filter(([, v]) => v.tracked).map(([k]) => k),
          ],
        });
      }
    }
    return undefined;
  });

  // Accounting: every read of the traced value must sit inside an accounted
  // expression (or a pure boolean position). Anything else could leak the
  // class name to an element the tracer never saw.
  walk(fn.body, (node, ancestors) => {
    if (!isTrackedReference(node)) return undefined;
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return undefined;
    // non-reference positions
    if (
      (parent.type === 'JSXAttribute' && parent.name === node) ||
      (parent.type === 'Property' && parent.key === node && !parent.shorthand) ||
      (isMember(parent) && parent.property === node && !parent.computed) ||
      (parent.type === 'VariableDeclarator' && parent.id === node)
    ) {
      return undefined;
    }
    if (isMember(parent) && parent.object === node && scope.carriers.has(node.name)) {
      const trackedKeys = scope.carrierTracked.get(node.name) ?? new Set();
      if (!parent.computed && !trackedKeys.has(parent.property?.name)) return undefined;
    }
    if (ancestors.some((a) => a.type === 'ObjectPattern' || a.type === 'ArrayPattern')) {
      return undefined; // binding pattern: declaration, not a read
    }
    // innermost non-cx call the value passed through, for the failure text
    let viaCall = null;
    const leak = (what) => {
      failures.push(viaCall ? `className passed to function '${viaCall}'` : what);
    };
    for (let i = ancestors.length - 1; i >= 0; i -= 1) {
      const ancestor = ancestors[i];
      const child = ancestors[i + 1] ?? node;
      if (accounted.has(ancestor) || accounted.has(child)) return undefined;
      if (ancestor.type === 'VariableDeclarator') {
        // `const x = ...tracked...`: x is a local the classifier follows when
        // x reaches a class position, or a carrier destructure the scope
        // already modelled
        if (unwrapTS(ancestor.init) === unwrapTS(child) || ancestor.id?.type === 'ObjectPattern') {
          return undefined;
        }
        if (viaCall) {
          // `const x = helper(props)`: followed when x reaches a class position
          return undefined;
        }
      }
      if (ancestor.type === 'AssignmentExpression' && ancestor.left?.type === 'Identifier') {
        if (scope.locals.has(ancestor.left.name)) return undefined;
        leak(`traced value assigned to '${ancestor.left.name}'`);
        return undefined;
      }
      if (ancestor.type === 'ConditionalExpression' && ancestor.test === child) return undefined;
      if (ancestor.type === 'LogicalExpression' && ancestor.operator === '&&' && ancestor.left === child) {
        return undefined;
      }
      if (ancestor.type === 'BinaryExpression') {
        if (COMPARISON_OPERATORS.has(ancestor.operator)) return undefined;
        failures.push(`className used in '${ancestor.operator}' expression`);
        return undefined;
      }
      if (
        ancestor.type === 'UnaryExpression' ||
        ancestor.type === 'IfStatement' ||
        ancestor.type === 'WhileStatement' ||
        ancestor.type === 'SwitchStatement'
      ) {
        return undefined;
      }
      if (ancestor.type === 'CallExpression' && !isCxCallee(ancestor.callee)) {
        // decided by where the call result goes: a local declarator or an
        // accounted position further out is fine, a bare statement leaks
        if (ancestor.callee === child) return undefined; // `props.render()`-style callee use
        viaCall ??= code.slice(
          ancestor.callee.start ?? ancestor.callee.range?.[0],
          ancestor.callee.end ?? ancestor.callee.range?.[1],
        );
        if (scope.carriers.has(node.name) && isHookCall(ancestor)) return undefined; // hooks do not render
        continue;
      }
      if (ancestor.type === 'ReturnStatement' || isFunctionNode(ancestor)) {
        if (ancestor === fn) break;
        if (isFunctionNode(ancestor) && ancestor.body !== child) continue; // params
        leak('className returned/used outside JSX');
        return undefined;
      }
      if (ancestor.type === 'Property' || ancestor.type === 'ArrayExpression') {
        // stored into an object/array the classifier cannot follow back to
        // the traced value
        leak(`className stored into ${ancestor.type}`);
        return undefined;
      }
      if (ancestor.type === 'ExpressionStatement') {
        leak('className used in a bare statement');
        return undefined;
      }
    }
    leak('className reference with unclassifiable ancestry');
    return undefined;
  });

  return { targets, failures };
};

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Top-level entry: trace which class chains `styled(X)` has to beat, where
 * X is `name` bound in `filename` (typically via the consumer's import).
 *
 * Returns { status: 'traced', chains } or { status: 'unsupported', failures }.
 * Each chain entry is a list of refs to resolve to class names:
 * { file, localName, kind: 'styled' | 'css' | 'css-ref' | 'css-literal' }.
 *
 * opts (used when recursing into a child component):
 *   trackedProps: string[]            props carrying the traced value (default ['className'])
 *   siteProps:    Map(prop -> { tracked, refs })  class values the call site binds
 */
const traceStyleTargets = (filename, name, depth = 0, opts = {}) => {
  if (depth > MAX_DEPTH) {
    return { status: 'unsupported', failures: ['component nesting too deep'] };
  }
  let resolved;
  try {
    resolved = resolveBinding(filename, name);
  } catch (e) {
    return { status: 'unsupported', failures: [e.message] };
  }
  const { binding } = resolved;
  if (binding.kind === 'styled' || binding.kind === 'css') {
    return {
      status: 'traced',
      chains: [
        [{ file: resolved.filename, localName: resolved.name, kind: binding.kind }],
      ],
    };
  }
  if (binding.kind === 'external') {
    // A truly external component (post-realpath) cannot carry classes from
    // this repo's Linaria rules, so there is nothing to out-rank.
    return { status: 'traced', chains: [[]], external: resolved.filename };
  }
  if (binding.kind !== 'function') {
    return {
      status: 'unsupported',
      failures: [`'${name}' in ${resolved.filename} is not a traceable function (${binding.kind})`],
    };
  }
  const { code } = parseFile(resolved.filename);
  const trackedProps = opts.trackedProps ?? ['className'];
  const { targets, failures } = traceFunction(
    binding.node,
    code,
    resolved.filename,
    [{ kind: 'props', tracked: trackedProps }],
    opts.siteProps ?? null,
    binding.closure ?? null,
  );
  if (failures.length > 0) {
    return {
      status: 'unsupported',
      failures: failures.map((f) => `${resolved.filename}: ${f}`),
    };
  }
  const chains = [];
  const pushRefs = (refs) => {
    for (const ref of refs) chains.push([ref]);
  };
  for (const target of targets) {
    if (target.kind === 'dom' || target.kind === 'runtime') {
      // One single-ancestor chain per sibling class: `.own.sibling` out-ranks
      // that sibling's own rules. No siblings -> nothing to beat.
      if (target.refs.length === 0) chains.push([]);
      pushRefs(target.refs);
      continue;
    }
    const inner = traceStyleTargets(resolved.filename, target.name, depth + 1, {
      trackedProps: target.trackedProps,
      siteProps: target.siteProps,
    });
    if (inner.status !== 'traced') return inner;
    chains.push(...inner.chains);
    pushRefs(target.refs);
  }
  if (targets.length === 0) chains.push([]);
  // dedupe identical chains (the same target referenced from several branches)
  const uniqueChains = [
    ...new Map(
      chains.map((chain) => [
        chain.map((e) => `${e.file}#${e.localName}#${e.kind}`).join('|'),
        chain,
      ]),
    ).values(),
  ];
  return { status: 'traced', chains: uniqueChains };
};

module.exports = {
  parseFile,
  fileVersion,
  findModuleBinding,
  resolveBinding,
  staticStringOf,
  staticStringOfExpression,
  traceStyleTargets,
};
