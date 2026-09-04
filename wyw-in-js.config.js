'use strict';

// wyw-in-js picks this file up from the working directory of the build (or
// via `pluginOptions.configFile`). The tagResolver swaps @linaria/react's
// `styled` processor for the subclass in ./processor, which derives the
// selector specificity of `styled(PlainComponent)` statically. Everything
// else (`css`, `styled.div`, `styled(LinariaComponent)`) keeps upstream's
// behavior.

const path = require('path');

const STYLED_PROCESSOR = path.join(__dirname, 'processor/styled.processor.json');

module.exports = {
  tagResolver: (source, imported) => {
    if (source === '@linaria/react' && imported === 'styled') {
      return STYLED_PROCESSOR;
    }
    return null;
  },
};
