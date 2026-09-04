# Lint rule: no bare `&.class` compounds in Linaria templates

A bare `&.class` (or `&:not(.class)`) inside a `css` / `styled` template has
specificity (0,k+1,0) and ties with the repeated own class a `styled()`
wrapper emits; stylesheet order then decides, which Next.js does not keep
stable across routes and client navigations. The author has to say which side
wins, with `variant()` or `state()` from `helpers/`.

The originating codebase enforces that with ESLint's `no-restricted-syntax`
(run through oxlint). The two selectors, for reuse:

```jsonc
"no-restricted-syntax": [
  "error",
  {
    "selector": "TaggedTemplateExpression:matches([tag.name='css'], [tag.object.name='styled'], [tag.callee.name='styled']) > TemplateLiteral > TemplateElement[value.raw=/(^|[^&\\w\\-\\]\\)])&\\.[A-Za-z_]/]",
    "message": "Bare `&.class` compound in a Linaria template ties with styled() wrappers (stylesheet order decides). Write `${variant('.class')}` (wrapper overrides it) or `${state('.class')}` (must win). See docs/styled-specificity.md."
  },
  {
    "selector": "TaggedTemplateExpression:matches([tag.name='css'], [tag.object.name='styled'], [tag.callee.name='styled']) > TemplateLiteral > TemplateElement[value.raw=/(^|[^&\\w\\-\\]\\)])&:not\\(\\./]",
    "message": "Bare `&:not(.class)` compound in a Linaria template ties with styled() wrappers (stylesheet order decides). Write `${variant(':not(.class)')}` (wrapper overrides it) or `${state(':not(.class)')}` (must win). See docs/styled-specificity.md."
  }
]
```

The regex only matches a `&.` that is not preceded by `&`, a word character,
`-`, `]` or `)`, so `&&.x`, `.a&.b`, `[x]&.y` and `)&.z` are left alone; the
first is the old strong-state idiom (migrated to `state()`), the others are
not compounds on the own element.
