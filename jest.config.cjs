/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/__analyzer-test-tmp__/'],
  moduleNameMapper: {
    // oxc-parser ships ESM only, which the CommonJS test runner cannot load;
    // the adapter loads the napi binding directly. See the adapter header.
    '^oxc-parser$': '<rootDir>/processor/analyzer/__jest__/oxc-parser.cjs',
  },
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: { react: { runtime: 'automatic' } },
        },
      },
    ],
    // ESM-only wyw helpers used by the analyzer (slugify, toValidCSSIdentifier)
    '/node_modules/(.*/)?@wyw-in-js/(shared|processor-utils)/.+\\.js$': [
      '@swc/jest',
      { jsc: { parser: { syntax: 'ecmascript' } } },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.*/)?@wyw-in-js/(shared|processor-utils)/)',
  ],
};
