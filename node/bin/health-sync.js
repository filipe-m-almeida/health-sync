#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    const message = err?.stack || err?.message || String(err);
    console.error(message);
    process.exitCode = 1;
  },
);
