# linaria-styled-specificity

Deterministic selector specificity for `styled(PlainReactComponent)` in
[Linaria](https://github.com/callstack/linaria) /
[wyw-in-js](https://github.com/wyw-in-js/wyw-in-js).

A drop-in `styled` processor that, at build time, statically traces where a
plain React component forwards its `className` and repeats the wrapper's own
class once per Linaria layer it lands on. The override then wins regardless of
CSS chunk order. Forwarding the tracer cannot prove is a build error, never a
silently weak selector.

This repository accompanies an RFC to wyw-in-js ([docs/RFC.md](docs/RFC.md),
posted as [wyw-in-js#425](https://github.com/wyw-in-js/wyw-in-js/issues/425)).
The processor runs in production in a large Next.js codebase (about 450
`styled(X)` sites, zero unprovable cases).

## The problem

```tsx
const Base = styled.div`background: red;`;

const Plain = ({ className }) => <Base className={className} />;
export const Styled = styled(Plain)`background: blue;`;
```

Upstream emits `.Styled { background: blue }`, specificity (0,1,0), the same
as `.Base`. Stylesheet order decides which wins. In a single bundled
stylesheet that order is stable; with per-route CSS chunks (Next.js, both
webpack and Turbopack) it differs per entry route and changes again on
client-side navigation. The same page renders red or blue depending on how the
user got there.

Wrapping a *Linaria* component does not have this problem: `styled(Base)`
emits `.Styled.Base`. Plain wrappers (`Container`, `Button`, `Title`, `Link`
components that add props and pass `className` through) are the common case
this leaves out.

## Quick start

```sh
pnpm install
pnpm demo                    # upstream vs this processor, side by side
pnpm test                    # processor + analyzer unit tests
```

Requires Node 22.12+ (`require(esm)` for `oxc-parser`); developed and CI-tested on Node 24 (`.nvmrc`).

## Demo

`pnpm demo` transforms each fixture in [demo/fixtures](demo/fixtures) with the
real wyw pipeline three times: upstream's `styled` processor, this processor in
its default `repeated` shape, and this processor with `styledEmit: 'list'`
([demo/wyw-in-js.list.config.js](demo/wyw-in-js.list.config.js)). It prints
the emitted selectors side by side (hashes replaced by display names).
Abridged:

```
02-plain-forward.tsx
  rule     upstream        repeated (default)      list (styledEmit: 'list')
  Base     .Base           .Base                   .Base
  Styled   .Styled         .Styled.Styled          .Styled, .Styled.Base

03-plain-deep.tsx        (Plain renders Deeper = styled(Base))
  Deeper   .Deeper.Base    .Deeper.Base            .Deeper.Base
  Styled   .Styled         .Styled.Styled.Styled   .Styled, .Styled.Deeper, .Styled.Deeper.Base

04-branches-cx.tsx       (ternary root, cx() mix, variant map, local)
  Styled   .Styled         .Styled.Styled.Styled   .Styled, .Styled.Deeper, .Styled.Deeper.Base,
                                                   .Styled.small, .Styled.large, .Styled.Flat

05-styled-styled-plain.tsx
  Inner    .Inner          .Inner.Inner            .Inner, .Inner.Base
  Outer    .Outer.Inner    .Outer.Outer.Outer      .Outer, .Outer.Inner, .Outer.Inner.Base

07-variant-state.tsx
  image    .image          .image                  .image
                             &:where(.small)
                             &:not(#_).img-error

08-unprovable.tsx        (className + ' extra')
  Styled   .Styled         BUILD ERROR
    Cannot statically derive the className targets of 'Plain' ...
    Reason: class value used in '+' expression
```

Fixture 05 shows why the eval path alone is not enough even for Linaria
targets: the evaluated `__wyw_meta` chain stops at the plain link, so upstream's
`.Outer.Inner` (0,2,0) only ties with `.Inner.Inner`.

Both shapes have the same maximum specificity. The list is exact per branch
and self-describing; the repeated class is one selector on every loader path
and independent of the replicated class names. Fixture 04 shows why the list
gets expensive: members grow with sibling branches, not depth, and every nested
block of the template repeats them (or, on the turbopack path, repeats its body
once per member). The default is `repeated`; the trade-off and measurements are
in [docs/styled-specificity.md](docs/styled-specificity.md).

## How it works

1. `processor/analyzer/class-name-tracer.cjs` parses the wrapped component
   (oxc-parser) and follows `className` to the JSX elements it lands on:
   ternaries, `||` / `??` / `&&`, `cx()` / `clsx()` / `classNames()`, rest
   props and carrier objects, locals, helper functions, module-level variant
   maps, forwarding through other props into children, element aliases,
   imports / re-exports / `memo()` / `forwardRef()`.
2. `processor/analyzer/static-class-names.cjs` resolves each target's Linaria
   chain (`styled(X)` extends, `css` classes) without evaluating anything.
3. `processor/styled-processor.cjs` (a subclass of `@linaria/react`'s
   `StyledProcessor`) repeats the own class `1 + depth` times for the deepest
   chain (`styledEmit: 'repeated'`, the default), or emits the own class plus
   one member per chain prefix with the real class names (`styledEmit: 'list'`).
   Pure Linaria chains keep upstream's exact selector; `styled(styled(Plain))`
   gets the static chain.
4. Plain targets are marked with `__wyw_meta` in the emitted tag expression so
   Linaria's runtime forwards the `as` prop to them instead of replacing them.

Values only the consumer controls (class strings through other props,
elements chosen via `as` or a hook) are outside the contract and add nothing.
Everything else that cannot be proven fails the build with the reason.

Nested `&.x` compounds inside a wrapped template are *not* enumerated: the
compiler cannot tell an appearance variant (a wrapper should beat it) from a
state class (must keep winning). The author writes it down with
[`variant()`](helpers/variant.ts) (`&:where(.x)`, keeps base specificity) or
[`state()`](helpers/state.ts) (`&:not(#_).x`, adds one ID). A lint rule for
bare compounds is in [docs/lint-rule.md](docs/lint-rule.md).

Full design notes: [docs/styled-specificity.md](docs/styled-specificity.md).

## Using it in a project

1. Copy `processor/` next to your wyw config and add the tagResolver from
   [wyw-in-js.config.js](wyw-in-js.config.js). wyw finds that file from the
   build's working directory (or pass `pluginOptions.configFile`).
2. Dependencies: `oxc-parser`, `resolve`, plus `@wyw-in-js/shared` and
   `@wyw-in-js/processor-utils` matching your `@wyw-in-js/transform`.
3. Optional: `helpers/variant.ts`, `helpers/state.ts` and the lint rule.
4. Re-run the unit tests after every bump of `@wyw-in-js/*`, `@linaria/*` or
   `oxc-parser`; the processor leans on pinned internals (the `StyledProcessor`
   constructor `params`, the oxc AST shape, and for `styledEmit: 'list'` wyw's
   class-name formula and usage enumeration).

Known limits: the `classNameSlug` option is not supported (the static
class-name replication bails loudly; it is only exercised by `styledEmit:
'list'`, the default `repeated` shape never reads a class name); `variant()`
needs `:where()` (Safari 14+).

## Layout

```
processor/
  styled-processor.cjs        the processor (extractRules, as-prop marker)
  styled.processor.json       wyw processor manifest, referenced by the tagResolver
  analyzer/
    class-name-tracer.cjs     className forwarding tracer
    static-class-names.cjs    static chain resolution; class names only for the list shape
    ast-utils.cjs
    analyzer.test.ts          tracer, replication and staticSelector tests
    __jest__/oxc-parser.cjs   CJS adapter so jest can load the ESM-only parser
  styled-processor.test.ts    extractRules / tagExpressionArgument tests
helpers/                      variant(), state() + tests
demo/                         fixtures, side-by-side runner, list-shape wyw config
docs/                         RFC, design notes, lint rule
wyw-in-js.config.js
```

## License

MIT
