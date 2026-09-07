'use strict';

// Custom wyw-in-js processor for the `styled` tag of '@linaria/react', wired
// up via the `tagResolver` in the repo root `wyw-in-js.config.js`.
//
// Problem: when `styled(X)` wraps a plain React component that forwards
// `className` to a Linaria component inside, upstream emits a selector with
// the same specificity as the base component's rule. With CSS split across
// chunks (and re-ordered on client-side navigation), the winning rule is
// non-deterministic.
//
// Fix: the className-forwarding targets of X are derived by static analysis
// (./analyzer/class-name-tracer.cjs) and their class names computed
// statically (./analyzer/static-class-names.cjs). extractRules then repeats
// the own class once per level of the deepest reachable chain, so the rule
// out-ranks every ancestor rule whenever the own class is present:
//
//   .Styled.Styled.Styled      (deepest chain: .BaseB.Deeper)
//
// One selector, never a list, by default: turbopack-loader < 2.5.1 rewrote
// grouped selectors into `:is(...)` with pseudo-elements inside
// (`:is(.a:after, .a.b:after)`), invalid CSS that silently drops the rule,
// and 2.5.1 splits a list into one rule per member, repeating the body.
// Repeating the own class is upstream's own technique for React.lazy targets.
// The list shape (`.own, .own.Deeper, .own.Deeper.Base`, same maximum
// specificity, real class names) is available as `styledEmit: 'list'` in the
// wyw config for comparison; `pnpm demo` prints both.
//
// Linaria targets (`styled(LinariaComponent)`) keep upstream's evaluated
// `__wyw_meta` chain and selector (`.Styled.Base.Deeper`). A plain target the
// analyzer cannot prove is a build error; see ./docs/styled-specificity.md for the
// supported forwarding patterns.

const StyledProcessor = require('@linaria/react/processors/styled').default;
const tracer = require('./analyzer/class-name-tracer.cjs');
const staticNames = require('./analyzer/static-class-names.cjs');

const DOCS = './docs/styled-specificity.md';

// Shape of statically derived selectors, wyw config key `styledEmit`.
const EMIT_SHAPES = new Set(['repeated', 'list']);

// Runtime wrapper around a plain component target, see tagExpressionArgument.
// A frozen / sealed target cannot take the marker; without it Linaria would
// replace the component on `as` instead of forwarding, so that is an error
// with a reason rather than a bare TypeError or a silent fallback.
const AS_FORWARDING_MARKER =
  '((c) => { if (c && typeof c !== "string" && !c.__wyw_meta) { if (!Object.isExtensible(c)) throw new Error("styled(): cannot mark a non-extensible component for as-prop forwarding: " + (c.displayName || c.name || "component")); c.__wyw_meta = { className: "", extends: null }; } return c; })';

// Mirrors the module-private helper in @linaria/react/dist/processors/styled.js.
const isReactLazyValue = (value) =>
  typeof value === 'object' &&
  value !== null &&
  value.$$typeof === Symbol.for('react.lazy');

// Length of the deepest chain (0 for none).
const chainDepth = (chains) =>
  chains.reduce((depth, chain) => Math.max(depth, chain.length), 0);

const hasEvalMeta = (value) =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  '__wyw_meta' in value;

// Ancestor class names of an evaluated Linaria component, outermost first.
const evaluatedChain = (value) => {
  const chain = [];
  const seen = new Set();
  let current = value;
  while (hasEvalMeta(current) && !seen.has(current)) {
    seen.add(current);
    const meta = current.__wyw_meta;
    if (!meta || typeof meta.className !== 'string') break;
    chain.push(meta.className);
    current = meta.extends;
  }
  return chain;
};

class StaticDepthStyledProcessor extends StyledProcessor {
  constructor(params, ...args) {
    super(params, ...args);
    // Same-file plain components reach the upstream constructor as
    // ValueType.FUNCTION and collapse to the string 'FunctionalComponent',
    // losing their identifier. Keep the original tag expression for tracing.
    const tagOp = params[1];
    this.componentExpression =
      tagOp?.[0] === 'call' && tagOp.length === 2 ? tagOp[1] : null;
  }

  extractRules(valueCache, cssText, loc) {
    const own = `.${this.className}`;
    let selector = own;

    if (this.component === 'FunctionalComponent') {
      // same-file plain component; upstream would silently emit `.own` only
      selector = this.staticSelector(loc);
    } else if (
      typeof this.component !== 'string' &&
      !this.component.nonLinaria
    ) {
      const value = valueCache.get(this.component.node.name);
      if (hasEvalMeta(value)) {
        // upstream parity: the target's classes are always on the element
        const chain = evaluatedChain(value);
        selector = own + chain.map((c) => `.${c}`).join('');
        // The evaluated chain stops at the first plain component (no
        // __wyw_meta), so for `styled(styled(Plain))` it is shorter than the
        // rules on the element: the inner rule is `.Inner.Inner` (repeated for
        // Plain's own chain) and `.own.Inner` would only tie with it. The
        // static resolver follows the chain through the plain component; when
        // it is deeper, repeat the own class like the static path does.
        const staticChains = this.staticChains();
        if (staticChains !== null && chainDepth(staticChains) > chain.length) {
          selector = this.selectorFromChains(staticChains);
        }
      } else if (isReactLazyValue(value)) {
        // Parity with upstream, which doubles the selector for React.lazy values.
        selector = own + own;
      } else {
        // Plain React components reach the evaluator as null or a stub.
        selector = this.staticSelector(loc);
      }
    }

    return {
      [selector]: {
        cssText,
        className: this.className,
        displayName: this.displayName,
        start: loc?.start ?? null,
      },
    };
  }

  // Source text of the styled() argument. The runtime-collect stage rewrites
  // the tag argument to a generated helper (`_exp<n>`); the SOURCE text is
  // stable across stages.
  get targetSourceName() {
    return (
      (typeof this.component !== 'string' ? this.component.source : null) ??
      this.componentExpression?.source ??
      null
    );
  }

  // The styled() argument as a plain identifier, or null.
  get targetLocalName() {
    const sourceName = this.targetSourceName;
    return sourceName && /^[A-Za-z_$][\w$]*$/.test(sourceName.trim())
      ? sourceName.trim()
      : null;
  }

  // 'repeated' (default) or 'list', validated.
  get emitShape() {
    const shape = this.options?.styledEmit ?? 'repeated';
    if (!EMIT_SHAPES.has(shape)) {
      throw new Error(
        `🚨 wyw option styledEmit must be 'repeated' or 'list', got '${String(shape)}'.`,
      );
    }
    return shape;
  }

  // Selector for fully resolved ancestor chains (class names, outermost
  // first). 'repeated' repeats the own class once per level of the deepest
  // chain; 'list' emits the own class plus one member per chain prefix.
  // Both have the specificity of the deepest chain plus one when the whole
  // chain is present on the element.
  selectorFromChains(chains) {
    const own = `.${this.className}`;
    if (this.emitShape === 'list') {
      const members = new Set([own]);
      for (const chain of chains) {
        let prefix = own;
        for (const className of chain) {
          prefix += `.${className}`;
          members.add(prefix);
        }
      }
      return [...members].join(', ');
    }
    return own.repeat(chainDepth(chains) + 1);
  }

  // Fully resolved ancestor chains (class names) on the element that carry
  // rules the styled rule has to beat. `chains` are tracer refs (see
  // traceStyleTargets); `fail` reports unprovable refs.
  resolveChains(chains, fail) {
    const root = this.context?.root;
    const resolved = [];
    for (const chain of chains) {
      let resolvedChains = [[]];
      for (const ref of chain) {
        let suffixes;
        try {
          suffixes = staticNames.staticChainsForRef(ref, this.options, root);
        } catch (e) {
          fail(`'${ref.localName}': ${e.message}`);
        }
        if (suffixes.length === 0) suffixes = [[]];
        resolvedChains = resolvedChains.flatMap((prefix) =>
          suffixes.map((suffix) => [...prefix, ...suffix]),
        );
      }
      resolved.push(...resolvedChains);
    }
    return resolved;
  }

  // Static ancestor chains of a Linaria target (`styled(StyledX)`), following
  // `styled(Plain)` links the evaluator cannot see. Returns null when the
  // target is not a plain identifier or cannot be resolved statically: the
  // evaluated chain is upstream-exact for pure Linaria chains, and a plain
  // link that is unprovable already fails the build where it is styled.
  staticChains() {
    const filename = this.context?.filename;
    const localName = this.targetLocalName;
    if (!filename || !localName) return null;
    try {
      return this.resolveChains(
        [[{ file: filename, localName, kind: 'component' }]],
        (reason) => {
          throw new Error(reason);
        },
      );
    } catch {
      return null;
    }
  }

  // True when the styled() argument provably resolves to a Linaria binding
  // (`styled.x`/`styled(X)`/`css`), which carries `__wyw_meta` at runtime.
  // Anything unresolvable counts as plain so the runtime marker stays.
  isStaticLinariaTarget() {
    const filename = this.context?.filename;
    const localName = this.targetLocalName;
    if (!filename || !localName) return false;
    try {
      const { binding } = tracer.resolveBinding(filename, localName);
      return binding.kind === 'styled' || binding.kind === 'css';
    } catch {
      return false;
    }
  }

  // Selector for a plain-component target, derived statically.
  staticSelector(loc) {
    const filename = this.context?.filename;
    const sourceName = this.targetSourceName;
    const localName = this.targetLocalName;
    const fail = (reason) => {
      throw new Error(
        `🚨 Cannot statically derive the className targets of '${sourceName ?? 'the styled component'}' ` +
          `(styled at ${filename}:${loc?.start?.line}).\n` +
          `Reason: ${reason}\n` +
          `Without them the generated CSS rule can lose against the styles of the component it wraps, depending on CSS chunk order.\n` +
          `Supported forwarding patterns: ${DOCS}\n`,
      );
    };
    if (!filename) fail('no filename in the transform context');
    if (!localName) fail('the styled() argument is not a plain identifier');

    let traced;
    try {
      traced = tracer.traceStyleTargets(filename, localName, 0);
    } catch (e) {
      fail(`tracer crashed: ${e.message}`);
    }
    if (traced.status !== 'traced') fail(traced.failures.join('; '));

    // A plain component with no Linaria ancestors, or with branches
    // rendering none, has depth 0 and gets the bare own class.
    return this.selectorFromChains(this.resolveChains(traced.chains, fail));
  }

  // Linaria's runtime reads an `as` prop as "render this element instead of
  // the wrapped one" and only forwards it to the wrapped component when that
  // component carries `__wyw_meta`. Plain components here own an `as` prop
  // (Container, Title), so the runtime tag expression marks them:
  //
  //   styled(((c) => (c && !c.__wyw_meta && (c.__wyw_meta = {...}), c))(_exp()))
  //
  // Linaria targets already carry the meta, so statically provable ones are
  // left unwrapped; external components (nonLinaria) keep upstream semantics.
  get tagExpressionArgument() {
    const argument = super.tagExpressionArgument;
    if (typeof this.component === 'string' || this.component.nonLinaria) {
      return argument;
    }
    if (this.isStaticLinariaTarget()) return argument;
    // wyw's AST service offers only a few builders; an identifier node prints
    // its name verbatim through the serializer, which carries the wrapper
    // source through (the same trick the former makeItStylish processor used).
    const t = this.astService;
    return t.callExpression(t.identifier(AS_FORWARDING_MARKER), [argument]);
  }

  // Defensive: wyw's processor contract lets a static plan resolve styled
  // targets without evaluation; upstream maps opaque components and same-file
  // callbacks to a bare `.className` selector there, which is the exact
  // specificity bug this processor exists to fix. Returning null marks those
  // targets as not statically resolvable and forces extractRules. Verified
  // not to be invoked by wyw 2.5.0 (only defined as a fallback in
  // declarativeSemantics.js); kept for forward compatibility.
  resolveStaticTagTarget(target) {
    if (
      target?.kind === 'opaque-component' ||
      target?.kind === 'runtime-callback'
    ) {
      return null;
    }
    return super.resolveStaticTagTarget(target);
  }
}

exports.default = StaticDepthStyledProcessor;
