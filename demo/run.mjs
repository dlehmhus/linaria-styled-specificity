// Transforms every fixture in ./fixtures three times with the real wyw-in-js
// pipeline: with upstream's `styled` processor (no config file), with the
// static-depth processor from ../processor in its default `repeated` shape
// (../wyw-in-js.config.js) and in its `list` shape (./wyw-in-js.list.config.js),
// then prints the emitted selectors side by side. Class-name hashes are
// replaced by display names for readability.
//
//   node demo/run.mjs            all fixtures
//   node demo/run.mjs 05         fixtures whose name contains "05"

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const filter = process.argv[2] ?? '';

const require = createRequire(import.meta.url);
const resolveSync = require('resolve').sync;
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const asyncResolve = async (token, importer) => {
  const basedir = path.dirname(
    path.isAbsolute(importer) ? importer : path.resolve(ROOT, importer),
  );
  return fs.realpathSync(resolveSync(token, { basedir, extensions: EXTENSIONS }));
};

const runTransform = async (filename, configFile) => {
  const services = {
    options: {
      filename,
      root: ROOT,
      pluginOptions: { configFile, displayName: true },
    },
    cache: new TransformCacheCollection(),
  };
  try {
    const result = await transform(services, fs.readFileSync(filename, 'utf8'), asyncResolve);
    return { rules: result.rules ?? {} };
  } catch (error) {
    return {
      error: String(error.message)
        .split('\n')
        .slice(0, 2)
        .join(' ')
        .split(`${ROOT}/`)
        .join(''),
    };
  }
};

// `.Styled_s1abc.Base_b2def` -> `.Styled.Base`
const readable = (selector, rules) => {
  let out = selector;
  for (const rule of Object.values(rules)) {
    if (rule.className && rule.displayName) {
      out = out.split(rule.className).join(rule.displayName);
    }
  }
  return out;
};

const summarize = ({ rules, error }) => {
  if (error) return { error };
  const bySelector = {};
  const nested = {};
  for (const [selector, rule] of Object.entries(rules)) {
    const name = rule.displayName ?? selector;
    bySelector[name] = readable(selector, rules);
    // nested selectors inside the template (`&:where(.x) {`, `&:not(#_).y {`)
    nested[name] = (rule.cssText.match(/^\s*&[^{]*\{/gm) ?? []).map((line) =>
      line.replace(/\s*\{$/, '').trim(),
    );
  }
  return { bySelector, nested };
};

const files = fs
  .readdirSync(FIXTURES)
  .filter((f) => /^\d\d-.*\.tsx$/.test(f) && f.includes(filter))
  .sort();

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

for (const file of files) {
  const filename = path.join(FIXTURES, file);
  const header = fs
    .readFileSync(filename, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('//'))
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join(' ');
  // sequential: concurrent transforms of the same file share wyw's eval
  // runner and deadlock
  const upstream = summarize(await runTransform(filename, false));
  const ours = summarize(
    await runTransform(filename, path.join(ROOT, 'wyw-in-js.config.js')),
  );
  const list = summarize(
    await runTransform(filename, path.join(__dirname, 'wyw-in-js.list.config.js')),
  );

  console.log(`\n${file}`);
  console.log(`  ${header}\n`);
  console.log(
    `  ${pad('rule', 12)}${pad('upstream', 18)}${pad('repeated (default)', 26)}list (styledEmit: 'list')`,
  );
  const names = new Set([
    ...Object.keys(upstream.bySelector ?? {}),
    ...Object.keys(ours.bySelector ?? {}),
  ]);
  for (const name of names) {
    const left = upstream.error ? `(error) ${upstream.error}` : upstream.bySelector[name] ?? '-';
    const mid = ours.error ? '' : ours.bySelector[name] ?? '-';
    const right = list.error ? '' : list.bySelector[name] ?? '-';
    console.log(`  ${pad(name, 12)}${pad(left, 18)}${pad(mid, 26)}${right}`);
    for (const inner of ours.nested?.[name] ?? []) {
      console.log(`  ${pad('', 12)}${pad('', 18)}  ${inner}`);
    }
  }
  if (ours.error) console.log(`  static-depth processor: BUILD ERROR\n    ${ours.error}`);
  if (upstream.error && names.size === 0) console.log(`  upstream: BUILD ERROR\n    ${upstream.error}`);
}
console.log();
process.exit(0);
