'use strict';

// Same processor as ../wyw-in-js.config.js, emitting the selector-list shape
// (`.own, .own.Deeper, .own.Deeper.Base`) instead of the repeated own class.
// Used by demo/run.mjs for the side-by-side comparison; see
// docs/styled-specificity.md for why the default is `repeated`.

const base = require('../wyw-in-js.config.js');

module.exports = { ...base, styledEmit: 'list' };
