'use strict';

// Static replication of wyw's class-name generation for a file, WITHOUT
// evaluating it. `getClassNameAndSlug` is a pure function of
// (displayName, idx, relative(root, filename), options), so any target's
// class name can be computed from a parse alone:
//
//   className = options.displayName
//     ? `${toValidCSSIdentifier(displayName)}_${slug}`
//     : slug
//   slug = toValidCSSIdentifier(
//     displayName[0].toLowerCase() + slugify(`${relativeFilename}:${idx}`))
//
// `idx` is the usage's position in wyw's per-file processor-usage list,
// replicated below from @wyw-in-js/transform. The names are only used by the
// `styledEmit: 'list'` shape; the default `repeated` shape reads chain
// lengths alone. Drift after a wyw bump shows in the unit tests and in the
// demo's list column.

const path = require('path');
const tracer = require('./class-name-tracer.cjs');
const { unwrapTS, nodeStart } = require('./ast-utils.cjs');

// the exact helper implementations the real processors use, pinned versions
const { slugify } = require('@wyw-in-js/shared');
const { toValidCSSIdentifier } = require('@wyw-in-js/processor-utils');

const rootIdentifierName = (node) => {
  const expression = unwrapTS(node);
  if (!expression) return null;
  if (expression.type === 'Identifier') return expression.name;
  if (
    expression.type === 'MemberExpression' ||
    expression.type === 'StaticMemberExpression'
  ) {
    return rootIdentifierName(expression.object);
  }
  if (expression.type === 'CallExpression') {
    return rootIdentifierName(expression.callee);
  }
  return null;
};

/** Local names bound to processor tags in this file (handles aliasing). */
const collectProcessorLocals = (program) => {
  const locals = new Map(); // localName -> 'styled' | 'css'
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source?.value;
    for (const spec of statement.specifiers ?? []) {
      if (spec.type !== 'ImportSpecifier') continue;
      const imported = spec.imported?.name ?? spec.imported?.value;
      const local = spec.local?.name;
      if (!local) continue;
      if (source === '@linaria/react' && imported === 'styled') {
        locals.set(local, 'styled');
      } else if (source === '@linaria/core' && imported === 'css') {
        locals.set(local, 'css');
      }
    }
  }
  return locals;
};

// mirrors transform's getDisplayName (VariableDeclarator / Property /
// JSXOpeningElement owner; falls back to filename-derived + idx)
const displayNameFor = (ancestors, idx, filename) => {
  const owner = [...ancestors]
    .reverse()
    .find(
      (node) =>
        node.type === 'Property' ||
        node.type === 'JSXOpeningElement' ||
        node.type === 'VariableDeclarator',
    );
  if (owner?.type === 'Property') {
    const key = owner.key;
    const name = key?.name ?? (typeof key?.value === 'string' ? key.value : null);
    if (name) return { displayName: name, bindingName: null };
  } else if (owner?.type === 'JSXOpeningElement') {
    if (owner.name?.type === 'JSXIdentifier') {
      return { displayName: owner.name.name, bindingName: null };
    }
  } else if (owner?.type === 'VariableDeclarator') {
    if (owner.id?.type === 'Identifier') {
      return { displayName: owner.id.name, bindingName: owner.id.name };
    }
  }
  let fallback = path.basename(filename).replace(/\.[a-z\d]+$/, '');
  if (/^index\.[a-z\d]+$/.test(path.basename(filename))) {
    fallback = path.basename(path.dirname(filename));
  }
  return { displayName: `${fallback}${idx}`, bindingName: null };
};

const computeClassName = (displayName, idx, filename, options, root) => {
  if (options.classNameSlug !== undefined) {
    // custom slug templates/functions are not replicated; bail loudly
    throw new Error(
      'static class-name computation does not support the classNameSlug option',
    );
  }
  const relativeFilename = (
    root && filename ? path.relative(root, filename) : (filename ?? 'unknown')
  ).replace(/\\/g, path.posix.sep);
  const slug = toValidCSSIdentifier(
    `${displayName.charAt(0).toLowerCase()}${slugify(`${relativeFilename}:${idx}`)}`,
  );
  return options.displayName
    ? `${toValidCSSIdentifier(displayName)}_${slug}`
    : slug;
};

// filename -> { version, byOptionsKey: Map(optionsKey -> info) }
// Versioned via the tracer's stat-derived file version so a dev server never
// serves info from a stale parse; bounded like the parse cache.
const FILE_INFO_CACHE_MAX_ENTRIES = 1000;
const fileInfoCache = new Map();

/**
 * Per-file static processor info:
 *   byBinding: Map(localBindingName -> {
 *     kind: 'styled' | 'css',
 *     className,
 *     styledArg,   // styled(X) arg expression (unwrapped) or null
 *   })
 * Cache key includes the options that feed the class name.
 */
const staticFileInfo = (filename, options, root) => {
  const { program, version } = tracer.parseFile(filename);
  const optionsKey = `${root}|${options.displayName ? 1 : 0}`;
  let slot = fileInfoCache.get(filename);
  if (!slot || slot.version !== version) {
    slot = { version, byOptionsKey: new Map() };
    if (fileInfoCache.size >= FILE_INFO_CACHE_MAX_ENTRIES) {
      fileInfoCache.delete(fileInfoCache.keys().next().value);
    }
    fileInfoCache.delete(filename); // re-insert to refresh recency
    fileInfoCache.set(filename, slot);
  }
  const cached = slot.byOptionsKey.get(optionsKey);
  if (cached) return cached;

  const locals = collectProcessorLocals(program);
  const usages = [];
  if (locals.size > 0) {
    // replicate collectProcessorUsages: tagged templates + calls (that are
    // not the tag of a template), matched by root identifier, source order
    const seen = new WeakSet(); // shorthand properties share key/value nodes
    const walk = (node, ancestors, parent) => {
      if (!node || typeof node.type !== 'string') return;
      if (seen.has(node)) return;
      seen.add(node);
      if (node.type === 'TaggedTemplateExpression') {
        const kind = locals.get(rootIdentifierName(node.tag));
        if (kind) usages.push({ node, ancestors: [...ancestors], kind });
      } else if (
        node.type === 'CallExpression' &&
        !(parent?.type === 'TaggedTemplateExpression' && parent.tag === node)
      ) {
        const kind = locals.get(rootIdentifierName(node.callee));
        if (kind) usages.push({ node, ancestors: [...ancestors], kind });
      }
      ancestors.push(node);
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'range' || key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) walk(item, ancestors, node);
        } else if (value && typeof value === 'object') {
          walk(value, ancestors, node);
        }
      }
      ancestors.pop();
    };
    walk(program, [], null);
    usages.sort((a, b) => nodeStart(a.node) - nodeStart(b.node));
  }

  const byBinding = new Map();
  usages.forEach((usage, idx) => {
    const { displayName, bindingName } = displayNameFor(
      usage.ancestors,
      idx,
      filename,
    );
    if (!bindingName) return; // binding-less tags can't be traced targets
    const entry = {
      kind: usage.kind,
      className: computeClassName(displayName, idx, filename, options, root),
      styledArg: null,
    };
    if (usage.kind === 'styled') {
      // styled(X)`...` -> X; styled.div`...` / styled('div')`...` -> null
      const tag = unwrapTS(usage.node.tag ?? usage.node.callee);
      if (tag?.type === 'CallExpression') {
        const arg = unwrapTS(tag.arguments?.[0]);
        if (arg?.type === 'Identifier') entry.styledArg = arg.name;
      }
    }
    byBinding.set(bindingName, entry);
  });

  const info = { byBinding };
  slot.byOptionsKey.set(optionsKey, info);
  return info;
};

const combineChains = (prefixes, suffixes) =>
  prefixes.flatMap((prefix) =>
    (suffixes.length > 0 ? suffixes : [[]]).map((suffix) => [...prefix, ...suffix]),
  );

/**
 * Resolves the full ancestor class chains for one traced ref, statically.
 * Returns an array of chains (string[][]); throws on anything unprovable.
 */
const staticChainsForRef = (ref, options, root, depth = 0) => {
  if (depth > 10) throw new Error(`extends chain too deep at ${ref.localName}`);
  if (ref.kind === 'css-literal') return [[ref.localName]];

  const resolved = tracer.resolveBinding(ref.file, ref.localName);
  if (resolved.binding.kind === 'external') {
    // external components carry no repo Linaria classes
    return [[]];
  }
  const info = staticFileInfo(resolved.filename, options, root);
  // alias-followed bindings (const A = B, m.create(X), default exports) live
  // in the per-file info under the underlying binding's name
  const entry =
    info.byBinding.get(resolved.name) ??
    (resolved.binding.aliasOf
      ? info.byBinding.get(resolved.binding.aliasOf)
      : undefined);
  if (!entry) {
    if (resolved.binding.kind === 'expression') {
      // a class string constant (or a list of them) mixed in via cx()
      const literal = tracer.staticStringOfExpression(resolved.filename, resolved.binding.node);
      if (literal !== null) {
        return literal
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => [token]);
      }
      const node = unwrapTS(resolved.binding.node);
      if (node?.type === 'ArrayExpression') {
        const chains = [];
        for (const element of node.elements ?? []) {
          if (!element) continue;
          if (element.type === 'SpreadElement') {
            throw new Error(`'${resolved.name}' in ${resolved.filename}: spread inside a class list`);
          }
          const value = tracer.staticStringOfExpression(resolved.filename, element);
          if (value !== null) {
            chains.push([value]);
            continue;
          }
          const e = unwrapTS(element);
          if (e?.type !== 'Identifier') {
            throw new Error(`'${resolved.name}' in ${resolved.filename}: ${e?.type} inside a class list`);
          }
          chains.push(
            ...staticChainsForRef(
              { file: resolved.filename, localName: e.name, kind: 'component' },
              options,
              root,
              depth + 1,
            ),
          );
        }
        return chains;
      }
    }
    // Plain component: recurse through the tracer, like the processor does at
    // the top level. It has no class of its own; its chains are the union of
    // its traced targets' chains.
    if (resolved.binding.kind === 'function') {
      const traced = tracer.traceStyleTargets(resolved.filename, resolved.name, 0);
      if (traced.status !== 'traced') {
        throw new Error(
          `'${resolved.name}' in ${resolved.filename} is not statically traceable: ${traced.failures.join('; ')}`,
        );
      }
      const chains = [];
      for (const tracedChain of traced.chains) {
        let resolvedChains = [[]];
        for (const chainRef of tracedChain) {
          resolvedChains = combineChains(
            resolvedChains,
            staticChainsForRef(chainRef, options, root, depth + 1),
          );
        }
        chains.push(...resolvedChains);
      }
      return chains;
    }
    throw new Error(
      `'${resolved.name}' in ${resolved.filename} is not a statically known styled/css binding (${resolved.binding.kind})`,
    );
  }
  if (entry.kind === 'css' || !entry.styledArg) return [[entry.className]];
  // styled(Parent): own class in front of every parent chain
  const parentChains = staticChainsForRef(
    { file: resolved.filename, localName: entry.styledArg, kind: 'component' },
    options,
    root,
    depth + 1,
  );
  return parentChains.map((parent) => [entry.className, ...parent]);
};

module.exports = { staticFileInfo, staticChainsForRef, computeClassName };
