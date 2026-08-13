#!/usr/bin/env node
// scripts/write-cjs-package-json.cjs
//
// Writes dist-cjs/package.json with {"type":"commonjs"} so Node treats the
// dist-cjs/ subtree as CJS despite the package root being "type":"module".
// The file is what makes `require('@crediolabs/<pkg>')` resolve to the CJS
// output (the require condition in the exports map points at dist-cjs/).

const fs = require('node:fs')
const path = require('node:path')

const outDir = path.resolve(__dirname, '..', 'dist-cjs')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))
console.log(`wrote ${path.join(outDir, 'package.json')}`)
