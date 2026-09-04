'use strict';

// Test-only CJS stand-in for the ESM-only `oxc-parser` package, wired via
// moduleNameMapper in the root jest.config.cjs. Jest's CommonJS runtime
// cannot load the real entry (its generated bindings.js declares its own
// `const __dirname`, which collides with the CJS wrapper after down-leveling).
// This adapter loads the napi binding directly and replicates the package's
// tiny `wrap()` result shell for the one function the analyzer uses.
//
// Kept honest by the production path: the real package is exercised by
// `pnpm demo` and by every real build.

const { createRequire } = require('module');

// resolve the platform binding through oxc-parser's own dependency tree
const oxcRequire = createRequire(require.resolve('oxc-parser/package.json'));

const candidates = [
  `@oxc-parser/binding-${process.platform}-${process.arch}`,
  `@oxc-parser/binding-${process.platform}-${process.arch}-gnu`,
  `@oxc-parser/binding-${process.platform}-${process.arch}-musl`,
  `@oxc-parser/binding-${process.platform}-${process.arch}-msvc`,
];

let binding = null;
const failures = [];
for (const name of candidates) {
  try {
    binding = oxcRequire(name);
    break;
  } catch (error) {
    failures.push(`${name}: ${error.code ?? error.message}`);
  }
}
if (!binding) {
  throw new Error(
    `oxc-parser test adapter: no napi binding loadable.\n${failures.join('\n')}`,
  );
}

// mirrors oxc-parser/src-js/wrap.js (BigInt/RegExp literal fix-ups included)
const applyFix = (program, fixPath) => {
  let node = program;
  for (const key of fixPath) {
    node = node[key];
  }
  if (node.bigint) {
    node.value = BigInt(node.bigint);
  } else {
    try {
      node.value = RegExp(node.regex.pattern, node.regex.flags);
    } catch {
      // invalid or unsupported regexp; leave the literal without a value
    }
  }
};

const jsonParseAst = (programJson) => {
  const { node: program, fixes } = JSON.parse(programJson);
  for (const fixPath of fixes) {
    applyFix(program, fixPath);
  }
  return program;
};

const wrap = (result) => ({
  get program() {
    return jsonParseAst(result.program);
  },
  get module() {
    return result.module;
  },
  get comments() {
    return result.comments;
  },
  get errors() {
    return result.errors;
  },
});

module.exports = {
  parseSync: (filename, code, options) =>
    wrap(binding.parseSync(filename, code, options)),
};
