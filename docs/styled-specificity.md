# Selector specificity for `styled(Component)`

## The problem

```tsx
import { styled } from '@linaria/react';

const BaseComponent = styled.div`
  background-color: red;
`;

export const StyledComponent = styled(BaseComponent)`
  background-color: blue;
`;
```

Linaria emits

```css
.BaseComponent {
  background-color: red;
}
.StyledComponent.BaseComponent {
  background-color: blue;
}
```

The compound selector makes the extending rule more specific than the base
rule, so it wins regardless of stylesheet order. That matters here: Next.js
splits CSS into chunks whose order differs per route and changes during
client-side navigation, so rule order is never guaranteed.

Upstream only does this when the wrapped component is itself a Linaria
component. Wrapping a plain React component that merely forwards `className`
gets a bare `.StyledComponent` rule with the same specificity as the inner
component's, and the winner becomes a coin flip:

```tsx
const ReactComponent: React.FC<{ className?: string }> = ({ className }) => (
  <BaseComponent className={className}>BaseComponent</BaseComponent>
);

export const StyledComponent = styled(ReactComponent)`
  background-color: blue;
`;
```

## What the build does

The custom `styled` processor (`processor/styled-processor.cjs`, wired through
the repo root `wyw-in-js.config.js`) derives the forwarding targets of a plain
component statically at build time:

1. `analyzer/class-name-tracer.cjs` parses the component's source (oxc) and
   follows the `className` prop to the JSX elements it lands on, across
   files, helpers and nested plain components.
2. `analyzer/static-class-names.cjs` computes the class names of those
   targets without evaluating anything (wyw's class-name formula is a pure
   function of display name, per-file usage index and file path).
3. `extractRules` repeats the own class once per level of the deepest
   reachable chain, so the rule out-ranks every ancestor rule whenever the
   own class is present:

```css
.StyledComponent.StyledComponent.StyledComponent /* deepest chain: .OtherTarget.ItsBase */
```

Why a repeated class and not a selector list (`.own, .own.Base, ...`):
the unpatched turbopack-loader wraps each selector of a list in `:global()`
and lightningcss folds that into `:is(...)` with pseudo-elements inside
(`:is(.a:after, .a.b:after)`, parcel-bundler/lightningcss#1032), which is
invalid CSS and silently drops the rule, taking every `&::before` /
`&::after` of the styled component with it. `@wyw-in-js/turbopack-loader`
2.5.1 works around that by emitting one rule per list member, so a list works
today, but every nested block's body is then repeated once per member. In the
originating corpus (199 affected rules, 1.9 nested blocks each, 5 list members
on average because sibling branches add members) that is +22.5% minified
Linaria CSS on the turbopack path and +5.7% on the one-rule-per-list webpack
path, for no observable cascade difference: the extra strength of the repeated
class on a shallower branch can only hit class-only rules on the same element,
and those are `variant()` / `state()` (see below). The repeated selector also
does not depend on the replicated class *names* being right, only on chain
length. Repeating the own class is upstream's own technique for `React.lazy`
targets. Pure Linaria chains keep upstream's exact
`.StyledComponent.BaseComponent` selector.

The list shape is implemented for comparison: `styledEmit: 'list'` in the wyw
config emits the own class plus one member per chain prefix with the real
class names (`.Styled, .Styled.Deeper, .Styled.Deeper.Base`); `pnpm demo`
prints both shapes next to upstream's output.

`styled(styled(Plain))` is the one Linaria target that needs more: the
evaluator's `__wyw_meta` chain stops at `Plain`, so `.Outer.Inner` (0,2,0)
would only tie with the inner rule `.Inner.Inner`. The processor resolves the
chain statically through the plain link and repeats the own class to the
full depth (`.Outer.Outer.Outer`).

No annotation is needed. The analysis is pure parse work (about 50ms warm
for the whole streaming-portal corpus), so build times stay where they are.

## Supported forwarding patterns

The tracer follows `className` through:

- direct forwarding: `<Base className={className} />`
- conditionals and fallbacks: ternaries, `a || b`, `a ?? b`, `cond && cls`
- `cx()` / `clsx()` / `classNames()` mixes, including arrays and objects.
  Joiners are recognised by their import only (`cx` from `@linaria/core`,
  anything from `clsx` / `classnames`, aliases included); a function of that
  name from any other module, file or component local is followed as a helper
- rest props and carrier objects: `{...props}`, `const merged = { ...props }`.
  Spreads and attributes are last-write-wins: `{ ...props, className: 'x' }`
  and `<Base {...props} className="x" />` do not forward `props.className`,
  the reversed orders do
- locals: `const classes = cx(className, x)`, `let style; if (...) style = a;`
  (`classes += '-x'` and `classes++` are `+` expressions and fail like one)
- destructuring defaults of class props (`extra = 'foo'`) count as what the
  element carries when the consumer passes nothing
- helpers, module-level or closures inside the component:
  `className={getButtonClasses(props)}`, `cx(className, getSizeStyle())`
- variant maps: `variants[variant]` on a module-level object literal, also
  for elements (`const El = elements[kind]`). A spread that could still decide
  the selected key (`{ a: A, ...more }`, any spread under a computed access) is
  unprovable
- forwarding through another prop into a child:
  `<Child rootClassName={className} />`
- element aliases: `const Root = floating ? A : B`, `const El = as || 'div'`
- imports, re-exports, `export *`, `export default`, `memo()`,
  `forwardRef()`, `m.create()`, aliased tag imports (`styled as s`,
  `css as linariaCss`)
- component factories: `const Deferred = deferUntilNear(Icon, 'Icon')`, where
  the factory is a function in the same module that returns exactly one
  component function (directly, or as a local it names and returns). The
  factory's parameters resolve to that call site's arguments, so the element
  the instance renders (`<Icon />`) is traced like a plain reference. Arguments
  are resolved at module level, so nothing inside the component shadows them.
  Branchy factories, destructured or unbound parameters, and locals of the
  factory body itself (outside the returned component) stay unprovable.

## The `as` prop on wrapped plain components

Linaria's runtime reads `as` as "render this element instead of the wrapped
one" and only forwards it to the wrapped component when that component
carries `__wyw_meta`. Plain components in this repo own an `as` prop
(`Container`, `Title`), so `<StyledContainer as="div">` must reach
`Container`, not replace it. The processor therefore marks plain targets in
the runtime tag expression:
`styled(((c) => { if (c && typeof c !== "string" && !c.__wyw_meta) { ...; c.__wyw_meta = {...}; } return c; })(Container))`.
A frozen component cannot take the marker; the wrapper throws with a reason
instead of leaving `as` broken.
Without the marker the wrapper renders a bare element, all props leak to the
DOM ("React does not recognize the `isInnerContainer` prop") and the
component's own classes are missing. (The old runtime `makeItStylish` set the
same marker as a side effect, which is why main never showed the problem.)

## Nested variants: what the compiler does not decide

Chains carry class names only. A target's nested compounds (`&.primary`,
`&.only-mobile`, `&.player-ready`) are NOT appended, so a bare `&.x` ties
with a consumer's wrapper rule and stylesheet order decides, which Next.js
does not keep stable across routes and client navigations.

Enumerating them is not an option: the same syntax expresses appearance
variants that a wrapper should override (`.primary`, `.small`) and state
classes that must not lose to it (`.only-mobile { display: none }`,
`.player-ready`, `.img-error`). Which is which is a design decision per
component, so the author writes it down with one of two helpers from
`helpers/`:

```ts
import { state } from './helpers/state';
import { variant } from './helpers/variant';

const image = css`
  ${variant('.small')} { width: 4rem; }        /* wrapper wins */
  ${state('.img-error')} { background: grey; } /* state wins */
`;
```

`k` below is the number of own classes on the template (1 for `css` and
`styled.tag`, 1 + chain depth for `styled(PlainComponent)`); `d` is the chain
depth of the consumer's wrapper.

| rule | written as | specificity |
|---|---|---|
| own base | `.Base { }` | (0,k,0) |
| variant, overridable | `${variant('.primary')}` -> `&:where(.primary)` | (0,k,0) |
| consumer wrapper | `styled(X)` -> `.Own` x (d+1) | (0,d+1,0) |
| compound, unqualified | `&.primary` | (0,k+1,0), ties |
| state, must win | `${state('.img-error')}` -> `&:not(#_).img-error` | (1,k,0) |

`variant()` keeps the base specificity, so any wrapper override wins over it
while same-template source order keeps it above the base declarations.
(`:where()` needs Safari 14+.) `state()` adds one ID, so it wins over a
wrapper at any depth. Class repetition (`&&.x`, (0,2k+1,0)) was the earlier
convention for states and is no longer used: it only beats depth-1 wrappers
when `k` is 1, and the corpus has 80 wrapper sites with three own classes and
6 with four.

`state()` also outranks the (0,3,0) hover/focus helpers (`isHover`,
`isPressed`, `isFocus`). To let hover restyle a stateful element, nest the
hover helper inside the state block.

In the codebase this comes from, unqualified compounds are a lint error: an
`no-restricted-syntax` rule rejects `&.class` and `&:not(.class)` inside
`css` / `styled` templates and names both helpers in the message (see
`docs/lint-rule.md` for the selectors).

## The contract boundary

The selector has to out-rank the wrapped component's OWN Linaria rules.
Values only the consumer controls are outside that contract and add nothing
to the chain:

- class strings arriving through other props (`rootClassName`,
  `containerStyle`), unless a call site inside the traced tree binds them to
  something provable
- elements chosen by the consumer or a provider: `as`-style props, components
  pulled from a hook or context

A consumer passing such a value competes with their own `styled()` override
locally and visibly, which is a different problem from cross-chunk ordering.

## When the build fails

Anything the tracer cannot prove fails the build with the reason, for
example `className used in '+' expression` or `class value produced by hook
'useTheme'`. A call the tracer does not follow that receives the class value
is a leak unless its result reaches a class position: a bare statement, a
condition (`if (consume(className))`) or a local that is only tested
(`const flag = consume(className); if (flag)`) all fail. The scope model is
flat across nested callbacks, so a callback that redeclares a name bound
outside it (`className`, the props object, a factory parameter, a local of the
component, a module binding such as a component or `cx`) fails as well.
Wrong-but-silent selectors are never emitted. Restructure the forwarding into
one of the supported patterns above.

## Validation

- `processor/styled-processor.test.ts`, `processor/analyzer/analyzer.test.ts`:
  unit tests for the processor, tracer and class name replication (`pnpm test`).
- `pnpm run demo`: transforms the fixtures with upstream's processor and with
  this one in both shapes and prints the emitted selectors side by side. The
  list column is the only consumer of the replicated class names; a wrong name
  there shows up as a member that does not match the fixture's own rule.

The class-name replication exists only for `styledEmit: 'list'`. The default
`repeated` shape uses chain depth alone, which is also what the originating
codebase ships (it derives depth only and has no replication). Inside wyw-in-js
the names would be available natively, so an upstream implementation of the
list shape would not need it either.

The processor leans on pinned internals: the `params` shape handed to the
upstream `StyledProcessor` constructor, wyw's class-name formula and usage
enumeration (`@wyw-in-js/shared`, `@wyw-in-js/processor-utils`, list shape
only), the `oxc-parser` AST shape (plus the jest-only CJS adapter in
`processor/analyzer/__jest__/oxc-parser.cjs`, which mirrors the package's
`wrap()`), and the runtime marker travelling as verbatim identifier source. Run
the unit tests after every bump of `@wyw-in-js/*`, `@linaria/*` or
`oxc-parser`.
