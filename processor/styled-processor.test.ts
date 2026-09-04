/**
 * Tests the build-time wyw-in-js processor. The full processor constructor
 * needs the wyw transform pipeline, so extractRules is exercised on the
 * prototype with a hand-built `this`. The static derivation itself
 * (staticSelector) is covered in analyzer/analyzer.test.ts.
 */
// only the overridden methods are under test, the upstream base class isn't
// loadable in jest (ESM-only dependency chain)
jest.mock('@linaria/react/processors/styled', () => ({
  default: class UpstreamStyledProcessorStub {
    // upstream builds `_exp()` for component targets
    get tagExpressionArgument(): unknown {
      return {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: '_exp' },
        arguments: [],
      };
    }
  },
}));

// oxlint-disable-next-line typescript/no-var-requires, typescript/no-require-imports -- CJS build-tool file without type declarations
const StaticDepthStyledProcessor = require('./styled-processor.cjs')
  .default as new () => unknown;

type FakeProcessor = {
  className: string;
  component:
    | string
    | { node: { name: string }; nonLinaria?: boolean; source?: string };
  displayName: string;
  options?: { styledEmit?: string };
  staticSelector: (loc: unknown) => string;
  staticChains: () => string[][] | null;
};

type Rules = Record<string, { className: string; cssText: string }>;

const extractRules = (
  processor: FakeProcessor,
  valueCache: Map<string, unknown>,
): Rules => {
  const method = (
    StaticDepthStyledProcessor.prototype as {
      extractRules: (
        this: FakeProcessor,
        valueCache: Map<string, unknown>,
        cssText: string,
        loc?: unknown,
      ) => Rules;
    }
  ).extractRules;
  // prototype-backed so extractRules can reach its sibling methods
  const self = Object.assign(
    Object.create(StaticDepthStyledProcessor.prototype) as object,
    processor,
  ) as FakeProcessor;
  return method.call(self, valueCache, 'color: red;', undefined);
};

const staticSelector = jest.fn(() => '.own.own');

const selectorFor = (
  target: unknown,
  component: FakeProcessor['component'] = {
    node: { name: 'target' },
    source: 'Target',
  },
): string => {
  const rules = extractRules(
    {
      className: 'own',
      component,
      displayName: 'Own',
      staticSelector,
      // static chain lookups need real files; covered in analyzer.test.ts
      staticChains: () => null,
    },
    new Map([['target', target]]),
  );
  return Object.keys(rules)[0];
};

// evaluated value of a Linaria component
const linariaValue = (
  className: string,
  extendsValue: unknown = null,
): { __wyw_meta: { className: string; extends: unknown } } => ({
  __wyw_meta: { className, extends: extendsValue },
});

beforeEach(() => {
  staticSelector.mockClear();
});

describe('StaticDepthStyledProcessor#extractRules', () => {
  it('emits a single class for html targets', () => {
    expect(selectorFor(undefined, 'div')).toBe('.own');
    expect(staticSelector).not.toHaveBeenCalled();
  });

  it('emits a single class for nonLinaria targets', () => {
    expect(
      selectorFor(undefined, { node: { name: 'target' }, nonLinaria: true }),
    ).toBe('.own');
    expect(staticSelector).not.toHaveBeenCalled();
  });

  it('chains evaluated Linaria targets', () => {
    // upstream parity: single selector, no list
    expect(selectorFor(linariaValue('base'))).toBe('.own.base');
    expect(selectorFor(linariaValue('deep', linariaValue('base')))).toBe(
      '.own.deep.base',
    );
    expect(staticSelector).not.toHaveBeenCalled();
  });

  it('doubles the selector for React.lazy targets', () => {
    expect(selectorFor({ $$typeof: Symbol.for('react.lazy') })).toBe(
      '.own.own',
    );
  });

  it('does not loop on cyclic metadata', () => {
    const cyclic = linariaValue('loop');
    cyclic.__wyw_meta.extends = cyclic;
    expect(selectorFor(cyclic)).toBe('.own.loop');
  });

  it('derives plain component targets statically', () => {
    // the evaluator replaces plain components with null or a stub function
    for (const value of [null, undefined, () => {}]) {
      expect(selectorFor(value)).toBe('.own.own');
    }
    expect(staticSelector).toHaveBeenCalledTimes(3);
  });

  it('derives same-file plain components statically', () => {
    // upstream collapses those to the string 'FunctionalComponent'
    expect(selectorFor(undefined, 'FunctionalComponent')).toBe('.own.own');
    expect(staticSelector).toHaveBeenCalledTimes(1);
  });

  it('keeps the rule metadata', () => {
    const rules = extractRules(
      {
        className: 'own',
        component: 'div',
        displayName: 'Own',
        staticSelector,
        staticChains: () => null,
      },
      new Map(),
    );
    expect(rules['.own']).toEqual({
      cssText: 'color: red;',
      className: 'own',
      displayName: 'Own',
      start: null,
    });
  });
});

describe('StaticDepthStyledProcessor#selectorFromChains', () => {
  const selectorFromChains = (
    chains: string[][],
    options: FakeProcessor['options'] = {},
  ): string =>
    (
      StaticDepthStyledProcessor.prototype as {
        selectorFromChains: (
          this: { className: string; options: unknown },
          chains: string[][],
        ) => string;
      }
    ).selectorFromChains.call(
      // prototype-backed for the emitShape getter
      Object.assign(
        Object.create(StaticDepthStyledProcessor.prototype) as object,
        { className: 'own', options },
      ),
      chains,
    );

  it('repeats the own class once per level of the deepest chain by default', () => {
    expect(selectorFromChains([])).toBe('.own');
    expect(selectorFromChains([[]])).toBe('.own');
    expect(selectorFromChains([['base']])).toBe('.own.own');
    expect(selectorFromChains([['flat'], ['deeper', 'base']])).toBe(
      '.own.own.own',
    );
    expect(selectorFromChains([['a']], { styledEmit: 'repeated' })).toBe(
      '.own.own',
    );
  });

  it('emits one member per chain prefix with styledEmit: list', () => {
    const list = { styledEmit: 'list' };
    expect(selectorFromChains([], list)).toBe('.own');
    expect(selectorFromChains([['base']], list)).toBe('.own, .own.base');
    expect(selectorFromChains([['flat'], ['deeper', 'base']], list)).toBe(
      '.own, .own.flat, .own.deeper, .own.deeper.base',
    );
  });

  it('dedupes shared prefixes in the list', () => {
    expect(
      selectorFromChains([['deeper', 'base'], ['deeper', 'other']], {
        styledEmit: 'list',
      }),
    ).toBe('.own, .own.deeper, .own.deeper.base, .own.deeper.other');
  });

  it('rejects unknown emit shapes', () => {
    expect(() => selectorFromChains([['a']], { styledEmit: 'both' })).toThrow(
      /styledEmit must be 'repeated' or 'list'/,
    );
  });
});

describe('StaticDepthStyledProcessor#extractRules with static chains', () => {
  // styled(styled(Plain)): the evaluated chain stops at Plain, the static
  // chains go through it
  const evaluated = new Map([['target', linariaValue('inner')]]);
  const rulesFor = (options: FakeProcessor['options']): string =>
    Object.keys(
      extractRules(
        {
          className: 'own',
          component: { node: { name: 'target' }, source: 'Inner' },
          displayName: 'Own',
          options,
          staticSelector,
          staticChains: () => [['inner', 'base']],
        },
        evaluated,
      ),
    )[0];

  it('repeats the own class to the static depth', () => {
    expect(rulesFor({})).toBe('.own.own.own');
  });

  it('lists the static chain prefixes with styledEmit: list', () => {
    expect(rulesFor({ styledEmit: 'list' })).toBe(
      '.own, .own.inner, .own.inner.base',
    );
  });

  it('keeps the evaluated selector when the static chain is not deeper', () => {
    const rules = extractRules(
      {
        className: 'own',
        component: { node: { name: 'target' }, source: 'Inner' },
        displayName: 'Own',
        options: { styledEmit: 'list' },
        staticSelector,
        staticChains: () => [['inner']],
      },
      evaluated,
    );
    expect(Object.keys(rules)[0]).toBe('.own.inner');
  });
});

describe('StaticDepthStyledProcessor#resolveStaticTagTarget', () => {
  const resolve = (target: unknown): unknown =>
    (
      StaticDepthStyledProcessor.prototype as {
        resolveStaticTagTarget: (this: unknown, target: unknown) => unknown;
      }
    ).resolveStaticTagTarget.call({ superCalled: false }, target);

  it('refuses to resolve plain component targets statically', () => {
    // a static resolution would bypass extractRules with a bare selector
    expect(resolve({ kind: 'opaque-component' })).toBeNull();
    expect(resolve({ kind: 'runtime-callback' })).toBeNull();
  });
});

describe('StaticDepthStyledProcessor#tagExpressionArgument', () => {
  type Node = { type: string; [key: string]: unknown };
  const t = {
    identifier: (name: string): Node => ({ type: 'Identifier', name }),
    stringLiteral: (value: string): Node => ({ type: 'StringLiteral', value }),
    nullLiteral: (): Node => ({ type: 'NullLiteral' }),
    memberExpression: (object: Node, property: Node): Node => ({
      type: 'MemberExpression',
      object,
      property,
    }),
    unaryExpression: (operator: string, argument: Node): Node => ({
      type: 'UnaryExpression',
      operator,
      argument,
    }),
    logicalExpression: (operator: string, left: Node, right: Node): Node => ({
      type: 'LogicalExpression',
      operator,
      left,
      right,
    }),
    assignmentExpression: (
      operator: string,
      left: Node,
      right: Node,
    ): Node => ({ type: 'AssignmentExpression', operator, left, right }),
    objectProperty: (key: Node, value: Node): Node => ({
      type: 'ObjectProperty',
      key,
      value,
    }),
    objectExpression: (properties: Node[]): Node => ({
      type: 'ObjectExpression',
      properties,
    }),
    sequenceExpression: (expressions: Node[]): Node => ({
      type: 'SequenceExpression',
      expressions,
    }),
    arrowFunctionExpression: (params: Node[], body: Node): Node => ({
      type: 'ArrowFunctionExpression',
      params,
      body,
    }),
    callExpression: (callee: Node, args: Node[]): Node => ({
      type: 'CallExpression',
      callee,
      arguments: args,
    }),
  };
  const argumentFor = (component: unknown): Node => {
    const descriptor = Object.getOwnPropertyDescriptor(
      StaticDepthStyledProcessor.prototype,
      'tagExpressionArgument',
    );
    if (!descriptor?.get)
      throw new Error('tagExpressionArgument getter missing');
    return (descriptor.get as (this: unknown) => Node).call({
      component,
      astService: t,
      // the static lookup needs real files; covered in analyzer.test.ts
      isStaticLinariaTarget: () => false,
    });
  };

  it('marks plain component targets so the runtime forwards the as prop', () => {
    const node = argumentFor({ node: { name: '_exp' }, source: 'Container' });
    expect(node.type).toBe('CallExpression');
    // the wrapper travels as verbatim source in an identifier node
    const callee = node.callee as Node;
    expect(callee.type).toBe('Identifier');
    expect(callee.name).toContain('__wyw_meta');
    expect(callee.name).toMatch(/^\(\(c\) =>/);
    expect(node.arguments).toEqual([
      {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: '_exp' },
        arguments: [],
      },
    ]);
  });

  it('leaves html and external targets untouched', () => {
    for (const component of [
      'div',
      { node: { name: '_exp' }, nonLinaria: true },
    ]) {
      expect(argumentFor(component)).toEqual({
        type: 'CallExpression',
        callee: { type: 'Identifier', name: '_exp' },
        arguments: [],
      });
    }
  });
});
