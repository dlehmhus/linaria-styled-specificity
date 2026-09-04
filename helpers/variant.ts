// Counterpart of `state`. Both exist because a bare `&.x` compound is
// (0,k+1,0) and ties with the `.own` repetitions a `styled()` wrapper emits;
// stylesheet order then decides, and Next.js does not keep it stable.
// `:where()` contributes zero specificity, which is what makes the variant
// overridable. See linaria/styled-specificity.md.
/**
 * Nested selector for an appearance variant, for use inside `css` / `styled`
 * templates.
 *
 * Keeps the specificity of the template's own class ((0,k,0)), so any
 * `styled()` wrapper override wins over the variant, while same-template source
 * order keeps the variant above the base declarations. Needs Safari 14+
 * (`:where()`).
 *
 * @example
 *   ```ts
 *   const button = css`
 *   ${variant('.primary')} { background: black; }
 *   `;
 *   ```
 *
 * @param selector Raw simple-selector suffix, e.g. `.primary`, `.a.b`,
 *   `:not(.small)`, `[data-size=large]`
 */
export const variant = (selector: string): string => `&:where(${selector})`;
