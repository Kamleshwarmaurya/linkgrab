'use strict';
// Entry point so that `node --test tests/` works on every Node version.
// Node >= 21 treats a directory argument as a path to require() (-> this file), Node 20 scans the folder itself
// (running each *.test.js directly), so on old Node this file does nothing to avoid running everything twice.
const fs = require('node:fs');
const path = require('node:path');

if (Number(process.versions.node.split('.')[0]) >= 21) {
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
    require(path.join(__dirname, f));
  }
}
