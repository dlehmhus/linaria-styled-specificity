/**
 * Tests the build-time analyzer: className-forwarding tracer, static class-name
 * replication, and the processor's static selector derivation.
 *
 * Fixture files are written to a temp directory INSIDE this folder because the
 * tracer resolves relative imports on disk.
 */
import * as fs from 'fs';
import * as path from 'path';

// only the overridden methods are under test; the upstream base class isn't
// loadable in jest (ESM-only dependency chain)
jest.mock('@linaria/react/processors/styled', () => ({
  default: class UpstreamStyledProcessorStub {},
}));

type Ref = { file: string; localName: string; kind: string };
type TraceResult = {
  status: string;
  chains?: Ref[][];
  failures?: string[];
};
type Options = {
  displayName?: boolean;
  classNameSlug?: unknown;
  styledEmit?: 'repeated' | 'list';
};

/* oxlint-disable typescript/no-var-requires, typescript/no-require-imports -- CJS build-tool files without type declarations */
const tracer = require('./class-name-tracer.cjs') as {
  parseFile: (filename: string) => {
    program: { body: unknown[] };
    version: string;
  };
  traceStyleTargets: (filename: string, name: string) => TraceResult;
};
const staticNames = require('./static-class-names.cjs') as {
  computeClassName: (
    displayName: string,
    idx: number,
    filename: string,
    options: Options,
    root: string,
  ) => string;
  staticFileInfo: (
    filename: string,
    options: Options,
    root: string,
  ) => { byBinding: Map<string, { kind: string; className: string | null }> };
  staticChainsForRef: (ref: Ref, options: Options, root: string) => string[][];
};
const StaticDepthStyledProcessor = require('../styled-processor.cjs')
  .default as new () => unknown;
/* oxlint-enable typescript/no-var-requires, typescript/no-require-imports */

const TMP = path.join(__dirname, '__analyzer-test-tmp__');
const ROOT = TMP;
const OPTIONS: Options = { displayName: true };

const write = (name: string, code: string): string => {
  const filename = path.join(TMP, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, code);
  return filename;
};

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const chainNames = (result: TraceResult): string[][] =>
  (result.chains ?? []).map((chain) =>
    chain.map((ref) => `${ref.localName}:${ref.kind}`),
  );

const trace = (file: string, name: string): string[][] => {
  const result = tracer.traceStyleTargets(file, name);
  if (result.status !== 'traced') {
    throw new Error(`expected a trace, got: ${result.failures?.join('; ')}`);
  }
  return chainNames(result);
};

const className = (name: string, idx: number, file: string): string =>
  staticNames.computeClassName(name, idx, file, OPTIONS, ROOT);

describe('class-name-tracer', () => {
  it('traces direct forwarding to a styled component', () => {
    const file = write(
      'direct.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       export const Card = ({ className }: { className?: string }) => (
         <Base className={className} />
       );`,
    );
    expect(trace(file, 'Card')).toEqual([['Base:styled']]);
  });

  it('traces both branches of a ternary', () => {
    const file = write(
      'ternary.tsx',
      `import { styled } from '@linaria/react';
       const A = styled.a\`\`;
       const B = styled.b\`\`;
       export const Duo = ({ className, x }: { className?: string; x?: boolean }) =>
         x ? <A className={className} /> : <B className={className} />;`,
    );
    expect(trace(file, 'Duo')).toEqual([['A:styled'], ['B:styled']]);
  });

  it('collects cx siblings on DOM targets, tagging literals', () => {
    const file = write(
      'cx.tsx',
      `import { css, cx } from '@linaria/core';
       const box = css\`\`;
       export const Boxed = ({ className }: { className?: string }) => (
         <div className={cx(box, 'plain', className)} />
       );`,
    );
    expect(trace(file, 'Boxed')).toEqual([
      ['box:css-ref'],
      ['plain:css-literal'],
    ]);
  });

  it('follows className through carrier object spreads', () => {
    const file = write(
      'carrier.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       export const Merged = (props: { className?: string }) => {
         const merged = { ...props, extra: true };
         return <Base {...merged} />;
       };`,
    );
    expect(trace(file, 'Merged')).toEqual([['Base:styled']]);
  });

  it('resolves components through relative imports and re-exports', () => {
    write(
      'inner.tsx',
      `import { styled } from '@linaria/react';
       const Leaf = styled.span\`\`;
       export const Panel = ({ className }: { className?: string }) => (
         <Leaf className={className} />
       );`,
    );
    write('barrel.ts', `export * from './inner';`);
    const consumer = write(
      'outer.tsx',
      `import { Panel } from './barrel';
       export const Outer = ({ className }: { className?: string }) => (
         <Panel className={className} />
       );`,
    );
    expect(trace(consumer, 'Outer')).toEqual([['Leaf:styled']]);
  });

  it('traces the component a local factory returns', () => {
    write(
      'factory-target.tsx',
      `import { styled } from '@linaria/react';
       const Leaf = styled.span\`\`;
       export const Real = ({ className }: { className?: string }) => (
         <Leaf className={className} />
       );`,
    );
    const file = write(
      'factory.tsx',
      `import { Real } from './factory-target';
       import { Real as Icon } from './factory-target';
       type P = { className?: string };
       const defer = (Inner: React.ComponentType<P>, name: string) => {
         const Deferred = (props: P) => {
           if (name === 'now') return <Inner {...props} />;
           return <span {...props} />;
         };
         Deferred.displayName = \`Deferred\${name}\`;
         return Deferred;
       };
       const wrap = (Inner: React.ComponentType<P>) => (props: P) => (
         <Inner {...props} />
       );
       const wrapIcon = (Icon: React.ComponentType<P>) => (props: P) => (
         <Icon {...props} />
       );
       export const DeferredReal = defer(Real, 'Real');
       export const WrappedReal = wrap(Real);
       export const ShadowNamed = wrapIcon(Icon);`,
    );
    expect(trace(file, 'DeferredReal')).toEqual([['Leaf:styled'], []]);
    expect(trace(file, 'WrappedReal')).toEqual([['Leaf:styled']]);
    // the argument repeats the parameter name: it is resolved at module level,
    // where only the import binding exists, so the alias cannot loop
    expect(trace(file, 'ShadowNamed')).toEqual([['Leaf:styled']]);
  });

  it('resolves factory arguments at module level, not inside the component', () => {
    const file = write(
      'factory-shadow.tsx',
      `import { Real } from './factory-target';
       type P = { className?: string };
       const wrap = (Inner: React.ComponentType<P>) => (props: P) => {
         const Real = 'div';
         return <Inner {...props} />;
       };
       export const Wrapped = wrap(Real);`,
    );
    expect(trace(file, 'Wrapped')).toEqual([['Leaf:styled']]);
  });

  it('fails loudly when a factory param cannot be bound to an argument', () => {
    const file = write(
      'factory-unbound.tsx',
      `import { Real } from './factory-target';
       type P = { className?: string };
       const wrap = (Inner?: React.ComponentType<P>) => (props: P) => (
         <Inner {...props} />
       );
       const wrapDestructured = ({ Inner }: { Inner: React.ComponentType<P> }) =>
         (props: P) => <Inner {...props} />;
       export const Missing = wrap();
       export const Destructured = wrapDestructured({ Inner: Real });`,
    );
    for (const name of ['Missing', 'Destructured']) {
      const result = tracer.traceStyleTargets(file, name);
      expect(result.status).toBe('unsupported');
      expect(result.failures?.join(' ')).toContain(
        "unknown element identifier 'Inner'",
      );
    }
  });

  it('rejects a factory whose returned component is not statically single', () => {
    const file = write(
      'factory-branchy.tsx',
      `type P = { className?: string };
       const pick = (flag: boolean) => {
         if (flag) return (props: P) => <span {...props} />;
         return (props: P) => <div {...props} />;
       };
       export const Picked = pick(true);`,
    );
    const result = tracer.traceStyleTargets(file, 'Picked');
    expect(result.status).toBe('unsupported');
    expect(result.failures?.join(' ')).toContain('not a traceable function');
  });

  it('traces className behind ?? and || fallbacks in the attribute', () => {
    const file = write(
      'logical-fallback.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       export const WithNullish = ({ className }: { className?: string }) => (
         <Base className={className ?? ''} />
       );
       export const WithOr = ({ className }: { className?: string }) => (
         <Base className={className || 'fallback'} />
       );`,
    );
    expect(trace(file, 'WithNullish')).toEqual([['Base:styled']]);
    expect(trace(file, 'WithOr')).toEqual([
      ['Base:styled'],
      ['fallback:css-literal'],
    ]);
  });

  it('rejects className concatenated with +', () => {
    const file = write(
      'concat.tsx',
      `export const Concat = ({ className }: { className?: string }) => (
         <div className={className + ' extra'} />
       );`,
    );
    const result = tracer.traceStyleTargets(file, 'Concat');
    expect(result.status).toBe('unsupported');
    expect(result.failures?.join(' ')).toContain("'+'");
  });

  it('records both operands of || and ?? cx siblings and gated && ones', () => {
    const file = write(
      'cx-logical.tsx',
      `import { css, cx } from '@linaria/core';
       const a = css\`\`;
       const b = css\`\`;
       const gated = css\`\`;
       export const Either = ({ className, on }: { className?: string; on?: boolean }) => (
         <div className={cx(a || b, on && gated, className)} />
       );
       export const Nullish = ({ className }: { className?: string }) => (
         <div className={cx(a ?? b, className)} />
       );`,
    );
    expect(trace(file, 'Either')).toEqual([
      ['a:css-ref'],
      ['b:css-ref'],
      ['gated:css-ref'],
    ]);
    expect(trace(file, 'Nullish')).toEqual([['a:css-ref'], ['b:css-ref']]);
  });

  it('follows className through module-level helper functions', () => {
    write(
      'helpers.ts',
      `import { css, cx } from '@linaria/core';
       export const extra = css\`\`;
       export const decorate = ({ big, className }: { big?: boolean; className?: string }) =>
         cx(extra, big && 'big', className);`,
    );
    const file = write(
      'helper-user.tsx',
      `import { styled } from '@linaria/react';
       import { decorate } from './helpers';
       const Base = styled.button\`\`;
       export const Fancy = (props: { big?: boolean; className?: string }) => {
         const classes = decorate(props);
         return <Base className={classes} />;
       };`,
    );
    expect(trace(file, 'Fancy')).toEqual([
      ['Base:styled'],
      ['extra:css-ref'],
      ['big:css-literal'],
    ]);
  });

  it('rejects helpers whose result is not provable', () => {
    const file = write(
      'helper.tsx',
      `const mangle = (value?: string) => \`x-\${value}\`;
       export const Opaque = ({ className }: { className?: string }) => (
         <div className={mangle(className)} />
       );`,
    );
    const result = tracer.traceStyleTargets(file, 'Opaque');
    expect(result.status).toBe('unsupported');
    expect(result.failures?.join(' ')).toContain("helper 'mangle'");
    expect(result.failures?.join(' ')).toContain('template literal');
  });

  it('rejects className leaking into an untraced call', () => {
    const file = write(
      'leak.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       const track = (value?: string) => value;
       export const Leaky = ({ className }: { className?: string }) => {
         track(className);
         return <Base />;
       };`,
    );
    const result = tracer.traceStyleTargets(file, 'Leaky');
    expect(result.status).toBe('unsupported');
    expect(result.failures?.join(' ')).toContain("passed to function 'track'");
  });

  it('reports an unprovable value hidden behind a local instead of dropping the target', () => {
    // `classes` holds className, but the class expression itself never names
    // it; the inline css literal in the map is not provable
    const file = write(
      'local-unprovable.tsx',
      `import { css, cx } from '@linaria/core';
       import { styled } from '@linaria/react';
       const Root = styled.span\`\`;
       const sizes = { small: css\`\`, large: css\`\` };
       export const Text = ({ size, className }: { size: keyof typeof sizes; className?: string }) => {
         const classes = cx(className, sizes[size]);
         return <Root className={classes} />;
       };`,
    );
    const result = tracer.traceStyleTargets(file, 'Text');
    expect(result.status).toBe('unsupported');
    expect(result.failures?.join(' ')).toContain('TaggedTemplateExpression in class position');
  });

  it('follows local aliases and variant maps', () => {
    const file = write(
      'variants.tsx',
      `import { css, cx } from '@linaria/core';
       import { styled } from '@linaria/react';
       const Root = styled.span\`\`;
       const h1 = css\`\`;
       const h2 = css\`\`;
       const variants = { h1, h2, hidden: false } as const;
       export const Title = ({ variant, className }: { variant: keyof typeof variants; className?: string }) => {
         const styles = cx(className, variants[variant]);
         return <Root className={styles} />;
       };`,
    );
    expect(trace(file, 'Title')).toEqual([
      ['Root:styled'],
      ['h1:css-ref'],
      ['h2:css-ref'],
    ]);
  });

  it('follows let assignments and closures inside the component', () => {
    const file = write(
      'locals.tsx',
      `import { css, cx } from '@linaria/core';
       import { styled } from '@linaria/react';
       const Wrapper = styled.div\`\`;
       const small = css\`\`;
       const large = css\`\`;
       const row = css\`\`;
       export const Container = ({ size, flex, className }: { size: string; flex?: boolean; className?: string }) => {
         let sizeStyle;
         if (size === 'small') {
           sizeStyle = small;
         } else {
           sizeStyle = large;
         }
         const getDisplayStyle = () => {
           if (flex) {
             return row;
           }
         };
         return <Wrapper className={cx(className, sizeStyle, getDisplayStyle())} />;
       };`,
    );
    expect(trace(file, 'Container')).toEqual([
      ['Wrapper:styled'],
      ['small:css-ref'],
      ['large:css-ref'],
      ['row:css-ref'],
    ]);
  });

  it('follows className forwarded through another prop into a child', () => {
    write(
      'child.tsx',
      `import { cx } from '@linaria/core';
       import { styled } from '@linaria/react';
       const Root = styled.div\`\`;
       export const Child = ({ className, rootClassName, extra }: { className?: string; rootClassName?: string; extra?: string }) => (
         <Root className={cx(className, rootClassName, extra)} />
       );`,
    );
    const file = write(
      'parent.tsx',
      `import { css } from '@linaria/core';
       import { Child } from './child';
       const bound = css\`\`;
       export const Parent = ({ className }: { className?: string }) => (
         <Child rootClassName={className} extra={bound} />
       );`,
    );
    expect(trace(file, 'Parent')).toEqual([['Root:styled'], ['bound:css-ref']]);
  });

  it('treats consumer-provided class props as outside the contract', () => {
    const file = write(
      'prop-class.tsx',
      `import { cx } from '@linaria/core';
       import { styled } from '@linaria/react';
       const Root = styled.div\`\`;
       export const Input = ({ className, containerStyle }: { className?: string; containerStyle?: string }) => (
         <Root className={cx(className, typeof containerStyle === 'string' && containerStyle)} />
       );`,
    );
    expect(trace(file, 'Input')).toEqual([['Root:styled']]);
  });

  it('treats consumer- and provider-chosen elements as outside the contract', () => {
    const file = write(
      'runtime-element.tsx',
      `import { css, cx } from '@linaria/core';
       const base = css\`\`;
       const useLink = () => ({ LinkComponent: 'a' as React.ElementType });
       export const Poly = ({ as, className }: { as?: React.ElementType; className?: string }) => {
         const El = as || 'div';
         return <El className={cx(base, className)} />;
       };
       export const Linked = ({ className }: { className?: string }) => {
         const { LinkComponent } = useLink();
         return <LinkComponent className={className} />;
       };`,
    );
    expect(trace(file, 'Poly')).toEqual([['base:css-ref']]);
    expect(trace(file, 'Linked')).toEqual([[]]);
  });

  it('rejects class values coming from hook results', () => {
    const file = write(
      'hook-class.tsx',
      `import { cx } from '@linaria/core';
       const useTheme = () => ({ themeClass: 'x' });
       export const Themed = ({ className }: { className?: string }) => {
         const { themeClass } = useTheme();
         return <div className={cx(themeClass, className)} />;
       };`,
    );
    const result = tracer.traceStyleTargets(file, 'Themed');
    expect(result.status).toBe('unsupported');
    expect(result.failures?.join(' ')).toContain('hook result');
  });

  it('re-parses edited files (dev-watch invalidation)', () => {
    const file = write('watched.tsx', `export const marker1 = 1;`);
    const first = tracer.parseFile(file);
    write('watched.tsx', `export const marker2 = 2; // longer content`);
    const second = tracer.parseFile(file);
    expect(second.version).not.toBe(first.version);
    expect(second).not.toBe(first);
  });
});

describe('static-class-names', () => {
  it('assigns usage indices in source order across tag kinds', () => {
    const file = write(
      'indices.tsx',
      `import { css } from '@linaria/core';
       import { styled } from '@linaria/react';
       const first = css\`\`;
       const Second = styled.div\`\`;
       const third = css\`\`;
       const Fourth = styled(Second)\`\`;`,
    );
    const info = staticNames.staticFileInfo(file, OPTIONS, ROOT);
    expect(info.byBinding.get('first')?.className).toBe(
      className('first', 0, file),
    );
    expect(info.byBinding.get('Second')?.className).toBe(
      className('Second', 1, file),
    );
    expect(info.byBinding.get('third')?.className).toBe(
      className('third', 2, file),
    );
    expect(info.byBinding.get('Fourth')?.className).toBe(
      className('Fourth', 3, file),
    );
  });

  it('prefixes the display name only when the option is set', () => {
    const file = path.join(TMP, 'options.tsx');
    const withName = staticNames.computeClassName(
      'X',
      0,
      file,
      { displayName: true },
      ROOT,
    );
    const bare = staticNames.computeClassName(
      'X',
      0,
      file,
      { displayName: false },
      ROOT,
    );
    expect(withName).toMatch(/^X_x/);
    expect(bare).toMatch(/^x/);
    expect(withName.endsWith(bare)).toBe(true);
  });

  it('bails loudly on the classNameSlug option', () => {
    expect(() =>
      staticNames.computeClassName(
        'X',
        0,
        path.join(TMP, 'x.tsx'),
        { displayName: true, classNameSlug: '[title]' },
        ROOT,
      ),
    ).toThrow(/classNameSlug/);
  });

  it('expands styled extends chains statically', () => {
    const file = write(
      'chain.tsx',
      `import { styled } from '@linaria/react';
       const Inner = styled.span\`\`;
       export const Outer = styled(Inner)\`\`;`,
    );
    expect(
      staticNames.staticChainsForRef(
        { file, localName: 'Outer', kind: 'styled' },
        OPTIONS,
        ROOT,
      ),
    ).toEqual([[className('Outer', 1, file), className('Inner', 0, file)]]);
  });

  it('expands class string constants mixed in via cx', () => {
    write('tokens.ts', `export const TOKEN = 'force-hover';`);
    const file = write(
      'token-user.tsx',
      `import { cx } from '@linaria/core';
       import { styled } from '@linaria/react';
       import { TOKEN } from './tokens';
       const Root = styled.div\`\`;
       export const Hoverable = ({ className }: { className?: string }) => (
         <Root className={cx(TOKEN, className)} />
       );`,
    );
    expect(
      staticNames.staticChainsForRef(
        { file, localName: 'Hoverable', kind: 'component' },
        OPTIONS,
        ROOT,
      ),
    ).toEqual([[className('Root', 0, file)], ['force-hover']]);
  });

  it('resolves m.create() aliases to the underlying styled binding', () => {
    const file = write(
      'motion-alias.tsx',
      `import { styled } from '@linaria/react';
       const Root = styled.nav\`\`;
       const MotionRoot = m.create(Root);
       export const Nav = ({ className }: { className?: string }) => (
         <MotionRoot className={className} />
       );`,
    );
    expect(
      staticNames.staticChainsForRef(
        { file, localName: 'MotionRoot', kind: 'component' },
        OPTIONS,
        ROOT,
      ),
    ).toEqual([[className('Root', 0, file)]]);
  });

  it('serves fresh info after a file edit (dev-watch invalidation)', () => {
    const source = (
      inner: string,
    ): string => `import { styled } from '@linaria/react';
       ${inner}
       const One = styled.div\`\`;`;
    const file = write('watch-info.tsx', source(''));
    const before = staticNames.staticFileInfo(file, OPTIONS, ROOT);
    // an extra tag in front shifts One's usage index and thus its class name
    write('watch-info.tsx', source('const Zero = styled.p``;'));
    const after = staticNames.staticFileInfo(file, OPTIONS, ROOT);
    expect(after.byBinding.get('One')?.className).not.toBe(
      before.byBinding.get('One')?.className,
    );
  });
});

describe('StaticDepthStyledProcessor#staticSelector', () => {
  type FakeProcessor = {
    className: string;
    component: string | { node?: { name: string }; source?: string };
    componentExpression: { source: string } | null;
    context: { filename: string; root: string };
    displayName: string;
    options: Options;
  };

  const staticSelector = (processor: FakeProcessor): string =>
    (
      StaticDepthStyledProcessor.prototype as {
        staticSelector: (this: FakeProcessor, loc: unknown) => string;
      }
    ).staticSelector.call(processor, { start: { line: 1 } });

  // prototype-backed so the methods under test can call their siblings
  const fake = (file: string, source: string): FakeProcessor =>
    Object.assign(Object.create(StaticDepthStyledProcessor.prototype) as object, {
      className: 'own',
      component: { node: { name: '_exp1' }, source },
      componentExpression: null,
      context: { filename: file, root: ROOT },
      displayName: 'Own',
      options: OPTIONS,
    }) as FakeProcessor;

  it('repeats the own class once per chain level for a plain component', () => {
    const file = write(
      'proc-target.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       export const Card = ({ className }: { className?: string }) => (
         <Base className={className} />
       );`,
    );
    expect(staticSelector(fake(file, 'Card'))).toBe('.own.own');
  });

  it('lists one member per chain prefix with styledEmit: list', () => {
    const file = write(
      'proc-target-list.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       const Deeper = styled(Base)\`\`;
       export const Card = ({ className, block }: { className?: string; block?: boolean }) => {
         const Root = block ? Deeper : Base;
         return <Root className={className} />;
       };`,
    );
    const processor = fake(file, 'Card');
    processor.options = { ...OPTIONS, styledEmit: 'list' };
    const base = className('Base', 0, file);
    const deeper = className('Deeper', 1, file);
    expect(staticSelector(processor)).toBe(
      `.own, .own.${deeper}, .own.${deeper}.${base}, .own.${base}`,
    );
    // same file, default shape: deepest branch decides
    expect(staticSelector(fake(file, 'Card'))).toBe('.own.own.own');
  });

  it('falls back to the tag expression for same-file plain components', () => {
    const file = write(
      'proc-same-file.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       const Card = ({ className }: { className?: string }) => <Base className={className} />;
       export const Styled = styled(Card)\`\`;`,
    );
    const processor = fake(file, 'ignored');
    processor.component = 'FunctionalComponent';
    processor.componentExpression = { source: 'Card' };
    expect(staticSelector(processor)).toBe('.own.own');
  });

  it('repeats the own class past a Linaria target whose chain ends in a plain component', () => {
    // styled(styled(Plain)): the evaluator sees Wrapper -> Inner and stops at
    // Plain, so `.Wrapper.Inner` (0,2,0) would only tie with `.Inner.Inner`.
    const file = write(
      'proc-nested.tsx',
      `import { styled } from '@linaria/react';
       const Base = styled.div\`\`;
       const Card = ({ className }: { className?: string }) => <Base className={className} />;
       export const Inner = styled(Card)\`\`;
       export const Wrapper = styled(Inner)\`\`;
       export const Outer = styled(Wrapper)\`\`;`,
    );
    type ExtractRules = (
      this: FakeProcessor,
      valueCache: Map<string, unknown>,
      cssText: string,
      loc?: unknown,
    ) => Record<string, unknown>;
    const extractRules = (
      StaticDepthStyledProcessor.prototype as { extractRules: ExtractRules }
    ).extractRules;
    const meta = (
      className: string,
      extendsValue: unknown,
    ): { __wyw_meta: { className: string; extends: unknown } } => ({
      __wyw_meta: { className, extends: extendsValue },
    });
    const selectorFor = (source: string, evaluated: unknown): string => {
      const processor = fake(file, source);
      processor.component = { node: { name: '_exp1' }, source };
      const rules = extractRules.call(
        processor,
        new Map([['_exp1', evaluated]]),
        'color: red;',
      );
      return Object.keys(rules)[0];
    };
    // Plain evaluates to a stub function without meta
    const inner = meta(className('Inner', 1, file), () => {});
    expect(selectorFor('Inner', inner)).toBe('.own.own.own');
    const wrapper = meta(className('Wrapper', 2, file), inner);
    expect(selectorFor('Wrapper', wrapper)).toBe('.own.own.own.own');
    // list shape: the static chain with real names, one member per prefix
    const listProcessor = fake(file, 'Wrapper');
    listProcessor.component = { node: { name: '_exp1' }, source: 'Wrapper' };
    listProcessor.options = { ...OPTIONS, styledEmit: 'list' };
    const listRules = extractRules.call(
      listProcessor,
      new Map([['_exp1', wrapper]]),
      'color: red;',
    );
    const [w, i, b] = [
      className('Wrapper', 2, file),
      className('Inner', 1, file),
      className('Base', 0, file),
    ];
    expect(Object.keys(listRules)[0]).toBe(
      `.own, .own.${w}, .own.${w}.${i}, .own.${w}.${i}.${b}`,
    );
    // pure Linaria chains keep the upstream selector
    const pure = write(
      'proc-pure-chain.tsx',
      `import { styled } from '@linaria/react';
       export const A = styled.div\`\`;
       export const B = styled(A)\`\`;`,
    );
    const pureProcessor = fake(pure, 'B');
    pureProcessor.component = { node: { name: '_exp1' }, source: 'B' };
    const rules = extractRules.call(
      pureProcessor,
      new Map([['_exp1', meta('B_x', meta('A_x', null))]]),
      'color: red;',
    );
    expect(Object.keys(rules)[0]).toBe('.own.B_x.A_x');
  });

  it('throws a build error when the target is not provable', () => {
    const file = write(
      'proc-opaque.tsx',
      `export const Opaque = ({ className }: { className?: string }) => (
         <div className={className + '-x'} />
       );`,
    );
    expect(() => staticSelector(fake(file, 'Opaque'))).toThrow(
      /Cannot statically derive/,
    );
  });

  it('marks only plain targets for as-prop forwarding at runtime', () => {
    const file = write(
      'proc-marker.tsx',
      `import { styled } from '@linaria/react';
       export const Base = styled.div\`\`;
       export const Card = ({ className }: { className?: string }) => <Base className={className} />;`,
    );
    const upstreamArgument = { type: 'CallExpression', callee: '_exp' };
    const t = {
      identifier: (name: string) => ({ type: 'Identifier', name }),
      callExpression: (callee: unknown, args: unknown[]) => ({
        type: 'CallExpression',
        callee,
        arguments: args,
      }),
    };
    // the upstream getter is stubbed away with the base class; emulate it
    Object.defineProperty(
      Object.getPrototypeOf(StaticDepthStyledProcessor.prototype),
      'tagExpressionArgument',
      { get: () => upstreamArgument, configurable: true },
    );
    const descriptor = Object.getOwnPropertyDescriptor(
      StaticDepthStyledProcessor.prototype,
      'tagExpressionArgument',
    );
    if (!descriptor?.get)
      throw new Error('tagExpressionArgument getter missing');
    const getter = descriptor.get as (this: unknown) => {
      type: string;
      callee?: unknown;
    };
    const argumentFor = (source: string): { type: string; callee?: unknown } =>
      getter.call(Object.assign(fake(file, source), { astService: t }));
    expect(argumentFor('Base')).toBe(upstreamArgument);
    const wrapped = argumentFor('Card');
    expect(wrapped).not.toBe(upstreamArgument);
    expect((wrapped.callee as { name: string }).name).toContain('__wyw_meta');
  });

  it('throws for non-identifier styled() arguments', () => {
    expect(() =>
      staticSelector(
        fake(path.join(TMP, 'proc-target.tsx'), 'items[0].Component'),
      ),
    ).toThrow(/not a plain identifier/);
  });
});
