<!-- Draft of the wyw-in-js enhancement request (template:
     .github/ISSUE_TEMPLATE/enhancement_request.md). Title suggestion:
     RFC: deterministic specificity for styled(PlainReactComponent)
     Canonical copy: https://github.com/dlehmhus/linaria-styled-specificity/blob/main/docs/RFC.md -->

## Describe the enhancement

Make `styled(Component)` overrides win deterministically when `Component` is a plain React component that forwards `className`, the same way they already do when `Component` is a Linaria component.

Two steps, independently useful:

1. **Small, default-safe:** treat an opaque component target like `React.lazy` and emit the own class twice (`.Styled.Styled`). The override then out-ranks one layer of the wrapped component's own Linaria rules.
2. **Opt-in, precise:** a static `className` tracer that follows the prop through the wrapped component's source to the Linaria components it lands on, and repeats the own class once per layer of the deepest chain. Forwarding it cannot prove is a build error, never a silently weak selector.

Step 2 runs in production on wyw-in-js 2.5.0 as a `styled` processor subclass wired through `tagResolver`, across 451 `styled(X)` sites in a 574-file Next.js monorepo, zero unprovable cases, verified in the browser. Reference implementation, tests, side-by-side demo and design notes: https://github.com/dlehmhus/linaria-styled-specificity. This issue asks whether, and in what shape, it belongs in wyw-in-js itself. Happy to open a PR.

**Terms used below**

- *Linaria component*: result of `styled.div` / `styled(X)`. Carries `__wyw_meta = { className, extends }` at runtime, which is how `styled(LinariaComponent)` learns the classes underneath it.
- *Plain component*: any other React component. No `__wyw_meta`; the evaluator sees `null` or a stub, or (same-file functions) the string sentinel `'FunctionalComponent'`.
- *Own class*: the class the `styled()` rule being emitted belongs to.
- *Chain / depth*: the Linaria classes stacked on the element that finally receives `className`. `Plain` rendering `Deeper = styled(Base)` has depth 2.
- *Compound*: a nested `&.x` rule inside a template.
- Specificity is written `(ids, classes, elements)`.

## Motivation

```tsx
const Base = styled.div`background: red;`;
const Plain = ({ className }) => <Base className={className} />;

export const A = styled(Base)`background: blue;`;   // .A.Base  (0,2,0)  always beats .Base
export const B = styled(Plain)`background: blue;`;  // .B       (0,1,0)  ties with .Base
```

For `B`, stylesheet order decides. That is stable in one bundled stylesheet. It is not stable once the bundler splits CSS into chunks: Next.js (webpack and Turbopack) emits per-route CSS chunks whose order differs per entry route and changes again on client-side navigation. The same page renders `B` red or blue depending on how the user got there. Nothing warns at build time; it surfaces as flaky visual regressions.

The pattern is the norm in component libraries: `Container`, `Button`, `Title`, `Link` wrappers that add props and pass `className` to a styled root. Every workaround is manual and silent when forgotten: `&&` / `&.&` in each override, `!important`, exporting the inner styled component (leaks internals), or a runtime helper that copies `__wyw_meta` onto the plain component with a hand-maintained class list (what we ran before; it went stale).

Upstream already handles one instance of this: `@linaria/react`'s styled processor doubles the selector for `React.lazy` targets because it knows a component is underneath whose classes it cannot see. Plain components are the general case. The order dependence itself is old: callstack/linaria#549 (2020) hit it with a consumer-passed `className`, and the suggested workaround was a duplicated selector; callstack/linaria#1378 hit it with `styled(ImportedLinariaComponent)` and was fixed by evaluating the import, which is the `__wyw_meta` chain plain components fall out of.

What the demo in the reference repo emits (`pnpm demo`, hashes replaced by display names):

```
fixture                        rule     upstream        static-depth processor
01 styled(Base)                Styled   .Styled.Base    .Styled.Base            (unchanged)
02 Plain -> Base               Styled   .Styled         .Styled.Styled
03 Plain -> Deeper -> Base     Styled   .Styled         .Styled.Styled.Styled
05 styled(styled(Plain))       Inner    .Inner          .Inner.Inner
                               Outer    .Outer.Inner    .Outer.Outer.Outer
08 className + ' extra'        Styled   .Styled         BUILD ERROR (reason given)
```

## Possible implementations

### Step 1: double the selector for opaque component targets

In `@linaria/react`'s `StyledProcessor.extractRules`, next to the `React.lazy` case. "Opaque" cannot be decided from the evaluated value alone (plain components evaluate to `null`, a stub, or the `'FunctionalComponent'` sentinel), so the check is on the target:

```js
const isOpaqueComponent =
  (this.component === 'FunctionalComponent' ||
    (typeof this.component !== 'string' && !this.component.nonLinaria)) &&
  !hasEvalMeta(value);

if (isReactLazyValue(value) || isOpaqueComponent) {
  selector += `.${this.className}`;
}
```

In the declarative-semantics layer this is the `styled-target` kinds `opaque-component` and `runtime-callback`.

Effect: `.B.B` (0,2,0) beats `.Base` (0,1,0) regardless of order. It assumes exactly one layer. In our corpus that is wrong for 86 of 451 sites (19%): 80 need three own classes, 6 need four, because the wrapped component renders a two- or three-level Linaria chain. It also does not beat the wrapped component's own compounds (see "Variants and states").

Risk: stronger selectors for existing users. It only changes outcomes that were already order-dependent, so nothing deterministic flips. Still worth a changeset note and possibly an opt-out. Cost: none at build time, a few bytes of CSS.

### Step 2: opt-in `className` tracing for exact depth

A static analysis that answers one number for a plain target: how many Linaria layers can be on the element that receives `className`, at most. The selector repeats the own class `1 + depth` times.

For the repeated own class only the depth is needed, not the class names. That keeps the analysis tractable (branches rendering different Linaria components need no reconciliation, the deepest wins) and cannot be subtly wrong: the repeated class is the processor's own. The list shape discussed below additionally needs the names.

What the tracer follows, driven by the real corpus (full list and fixtures in the repo docs):

- direct forwarding, ternaries, `||` / `??` / `&&`, `cx()` / `clsx()` / `classnames()` including arrays and objects
- rest props and carrier objects, locals, helper functions (module-level and closures), module-level variant maps
- forwarding through another prop into a child, element aliases (`const Root = block ? A : B`)
- imports, re-exports, `export default`, `memo()`, `forwardRef()`, `m.create()`

Contract boundary: values only the *consumer* controls add nothing to the chain. In

```tsx
const Title = ({ as = 'h2', className }) => <Heading as={as} className={className} />;
```

the `as` value is chosen at the same call site that wrote `styled(Title)`; it cannot be a hidden Linaria layer the override must beat. Class strings arriving through other props and elements from hooks or context are treated the same way. This line turns most "cannot trace" cases into "not in scope".

Everything else that cannot be proven (string concatenation, class values from a hook or an untraced call) fails the build with the reason. A wrong-but-silent selector is the exact bug this removes, so the feature never emits one. That makes it opt-in by necessity.

Illustrative configuration:

```js
// wyw-in-js.config.js
module.exports = {
  styledTargets: {
    specificity: 'trace', // 'double' (step 1) | 'trace' (step 2) | 'off' (today)
    classNameHelpers: ['cx', 'clsx', 'classnames'],
  },
};
```

### Linaria targets are affected too

`styled(styled(Plain))` is not covered by the eval path. The `__wyw_meta` chain stops at `Plain`, so upstream emits `.Outer.Inner` (0,2,0) while the inner rule is already `.Inner.Inner` (0,2,0) after step 1 or 2. Tie again (fixture 05).

Our processor keeps upstream's evaluated selector for pure Linaria chains and only falls back to the repeated own class when the static depth through the plain link is greater. If upstream ships step 1 alone this case stays broken; if it ships step 2 the Linaria path should consult it too.

### One selector today, a list eventually

Two ways to emit the rule for a depth-2 target, both (0,3,0) when the whole chain is present:

- **list**, one member per layer: `.own, .own.Base, .own.Base.Deeper`
- **repeated own class**: `.own.own.own`

We prefer the list and think it is the right shape for wyw-in-js. It is self-describing in DevTools (`.own.Base.Deeper` names the rules it is meant to beat), it is exact per branch when a component renders chains of different depth (`.own.Flat` stays (0,2,0) on the shallow branch instead of being lifted to max depth), and it only outranks what it was meant to outrank. What we ship today is the repeated own class, because of what happens to a list after emission on the turbopack path.

stylis expands every nested `&` block by substituting the parent selector, so a list parent turns every nested block into a list:

```css
/* template: color: blue; &:hover { color: navy; } &::before { content: ''; } */

/* repeated: 3 rules */
.own.own.own { color: blue }
.own.own.own:hover { color: navy }
.own.own.own::before { content: '' }

/* list: 3 rules, each with 3 members */
.own, .own.Base, .own.Base.Deeper { color: blue }
.own:hover, .own.Base:hover, .own.Base.Deeper:hover { color: navy }
.own::before, .own.Base::before, .own.Base.Deeper::before { content: '' }
```

Harmless on the webpack path. On the turbopack path the loader wraps each member in `:global()` for CSS modules, and lightningcss folds a `:global()` list into one `:is(.own::before, .own.Base::before, …)` (parcel-bundler/lightningcss#1032). Pseudo-elements are not allowed inside `:is()`, so every `::before` / `::after` rule of every list-emitting wrapper is dropped silently, and `:is()` gives all members the specificity of its most specific one, so the cascade differs from the webpack build. #418 (turbopack-loader 2.5.1) works around that by emitting one `:global(member) { body }` rule per member, which is correct but repeats the body N members × M nested blocks: a wrapper with a three-level chain and ten nested blocks ships thirty rule bodies instead of ten.

The repeated own class is one member on every path: `:global(.own.own.own::before)` unwraps cleanly, nothing is folded or split, no body is repeated. It is upstream's existing technique for `React.lazy` targets, and minifiers leave it alone (lightningcss 1.32 with `minify: true` keeps `.a.a.a`). Its cost is bluntness on shallow branches, which only matters against other class-only rules on the same element, and `state()` covers that.

Measured on our corpus with both shapes implemented (`styledEmit: 'repeated' | 'list'` in the reference processor; `pnpm demo` prints both): 199 of 1834 rules are affected, with 1.9 nested blocks and 5 list members each on average. Members grow with sibling branches (variant maps, `cx()` mixes), not with depth: 128 of the 199 sites need more members than `depth + 1`. The list costs +5.7% minified Linaria CSS on the one-rule-per-list path and +22.5% (+14% gzip) on the per-member-split turbopack path, and changed no cascade outcome in the corpus.

Proposal: emit the repeated own class now, and switch to the list once parcel-bundler/lightningcss#1032 is fixed and the turbopack-loader can go back to emitting one rule per list. The depth-only analysis stays valid either way; the list additionally needs the class name of every layer, which the evaluated `__wyw_meta` chain already provides for Linaria targets and the static resolver has to compute for plain ones.

### Variants and states: what the compiler must not decide

A stronger wrapper selector creates a new tie. `Base`'s compound `&.primary` is `.Base.primary` (0,2,0); the wrapper's `.Own.Own` is also (0,2,0). The same syntax expresses appearance variants a consumer override should beat (`.primary`, `.small`) and state classes that must keep winning (`.only-mobile { display: none }`, `.img-error`). Enumerating compounds into the depth would have fixed 74 variant pairs and flipped 36 state pairs on 11 sites in our corpus; the only safe classifier we found (class from a string-literal-union prop: 21 of 28 variants, 0 states) does not cover boolean props (`fullWidthOnMobile` vs `isHidden`). So the author decides, with two one-line helpers:

```ts
export const variant = (selector: string): string => `&:where(${selector})`;
export const state = (selector: string): string => `&:not(#_)${selector}`;
```

```ts
const image = css`
  ${variant('.small')} { width: 4rem; }        /* wrapper wins */
  ${state('.img-error')} { background: grey; } /* state wins */
`;
```

With `k` = own classes on the template (1 for `css` / `styled.tag`, `1 + depth` for `styled(Plain)`) and `d` = the consumer wrapper's depth:

| rule | written as | specificity |
|---|---|---|
| own base | `.Base { }` | (0,k,0) |
| variant, overridable | `${variant('.primary')}` = `&:where(.primary)` | (0,k,0) |
| consumer wrapper | `styled(X)` = `.Own` x (d+1) | (0,d+1,0) |
| compound, unqualified | `&.primary` | (0,k+1,0), ties |
| state, must win | `${state('.img-error')}` = `&:not(#_).img-error` | (1,k,0) |

`&&.x` is the usual "stronger state" idiom and does not work in general: (0,2k+1,0) loses once wrappers are three or four classes deep (86 sites here). `:not(#_)` adds an ID instead, is Selectors 3 with no browser floor, and `#_` never exists in the DOM, so the selector still matches the element. `variant()` needs `:where()` (Safari 14+); on older engines the variant rule is dropped rather than mis-ordered.

Because a bare compound is a silent tie we lint it (`no-restricted-syntax` on `&.class` / `&:not(.class)` inside `css` / `styled` templates, message naming both helpers). **A stronger `styled()` selector without a way to say "this compound is a state" makes some existing components worse**, so the helpers (or an equivalent) are part of the proposal. Cheapest upstream form: a documented pair exported from `@linaria/core`.

### Runtime: `as` forwarding for plain targets

`@linaria/react`'s runtime forwards `as` to the wrapped component only when it carries `__wyw_meta`; for a plain component `as` replaces it entirely. Wrappers frequently own an `as` prop (`Container`, `Title`), so `<StyledContainer as="section">` renders a bare `section`, leaks wrapper props into the DOM and loses the wrapper's classes. The runtime helper this work replaces set `__wyw_meta` as a side effect, so removing it exposed the bug; any implementation of step 1 or 2 that removes such a helper will hit it. Our processor marks plain targets in the emitted tag expression:

```js
styled(((c) => (c && typeof c !== "string" && !c.__wyw_meta &&
  (c.__wyw_meta = { className: "", extends: null }), c))(Container))
```

Whether `as` should be forwarded to plain components by default is a runtime decision independent of specificity, but it should land with either step.

### Where it plugs in

On 2.5.0 the bug exists on both paths. `extractRules` emits the bare own class for plain targets, and `StyledProcessor.resolveStaticTagTarget` already maps `opaque-component` / `runtime-callback` to the bare own selector too. The static path is not live yet: `declarativeSemantics.js` only installs `resolveStaticTagTarget` as a fallback (`Object.defineProperty`) and nothing calls it, on 2.5.0 or current `main`. Our subclass therefore does the work in `extractRules` and overrides `resolveStaticTagTarget` defensively (returning `null` for those kinds) so a future static plan cannot reintroduce the weak selector.

If the static plan becomes primary, the clean shape is: resolve an `opaque-component` to `{ kind: 'opaque-component', depth: n }` in `@wyw-in-js/transform` and emit the repeated selector in `@linaria/react`. Inside wyw the tracer can reuse the module graph and resolver; our external version brings its own (oxc-parser, parse only, about 50 ms warm for the whole app corpus).

### Open questions, with our position

1. **Step 1 as default?** We think yes. It never changes a deterministic outcome, only order-dependent ones. It is a mitigation, not a fix (wrong-by-one for 19% of our sites), so step 2 stays needed.
2. **Where does step 2 live?** Target resolution in `@wyw-in-js/transform`, emit in `@linaria/react`, tracer configurable (`classNameHelpers`, forwarding patterns) with `cx` / `clsx` / `classnames` built in. Emit shape: repeated own class until parcel-bundler/lightningcss#1032 is fixed, list after that.
3. **Unprovable forwarding: error or warning-plus-step-1?** Error, as we run it. A warning re-creates the silent case. An explicit per-site escape hatch is fine.
4. **Do `variant()` / `state()` belong in `@linaria/core`?** Yes, or the equivalent guidance in the docs. Without them a stronger wrapper selector regresses state compounds in existing code.

## Related Issues

- callstack/linaria#549: consumer-passed `className` loses to the styled component's own rule depending on source order; closed with a duplicated selector as the userland workaround. Same root cause, from the other side.
- callstack/linaria#1378: `styled(ImportedLinariaComponent)` got the parent's specificity only for same-file parents; fixed by evaluating the import (callstack/linaria#1405). Plain components are the case that evaluation cannot reach.
- #417 / #418: turbopack-loader folded selector lists into `:is(...)`, dropping pseudo-element rules and lifting list specificity; now one rule per list member. Why the emit is a single selector today.
- parcel-bundler/lightningcss#1032: the underlying `:global()`-list-into-`:is()` folding; the list emit waits on it.
