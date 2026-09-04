// `&&.x` was the previous convention, but it is only (0,2k+1,0): it loses to
// wrapper chains deeper than one level (the corpus has 80 wrapper sites with
// three own classes and 6 with four). `:not(#_)` adds an ID instead, which
// outranks any class stack no matter how deep. It is Selectors 3, has no
// browser floor, and `#_` is an id that never exists in the DOM, so the
// selector still matches the element itself.
/**
 * Nested selector for a state class, for use inside `css` / `styled` templates.
 *
 * Adds one ID of specificity ((1,k,0)), so the state wins over any `styled()`
 * wrapper at any chain depth, and also over the (0,3,0) hover/focus helpers
 * (`isHover`, `isPressed`, `isFocus`). To let hover restyle a stateful element,
 * nest the hover helper inside the state block.
 *
 * @example
 *   ```ts
 *   const image = css`
 *   ${state('.img-error')} { background: grey; }
 *   `;
 *   ```
 *
 * @param selector Raw simple-selector suffix, e.g. `.img-error`, `.a.b`,
 *   `:not(.small)`, `[data-state=open]`
 */
export const state = (selector: string): string => `&:not(#_)${selector}`;
