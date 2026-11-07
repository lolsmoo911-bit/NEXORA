/**
 * Emits the canonical test vectors.
 *
 * Run: `npm run vectors` (from aid/). Writes `aid/vectors.json` and prints a Markdown table
 * ready to paste into `aid/SPEC.md` §8 and into the Solidity test.
 *
 * The vectors are generated, never typed by hand. A hand-typed vector is a transcription
 * error waiting to become a specification bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CHAIN_ID, SPEC_VERSION, domainSeparator,
  nativeId, erc20Id, erc721Id, erc1155Id, toCanonicalString,
} from '../src/aid.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRECOMPILE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0x1111111111111111111111111111111111111111';

const vectors = [
  { n: 1, kind: 'NATIVE', input: 'anex on chain 902024', id: nativeId() },
  { n: 2, kind: 'ERC20', input: ZERO, id: erc20Id(ZERO) },
  { n: 3, kind: 'ERC20', input: PRECOMPILE, id: erc20Id(PRECOMPILE) },
  { n: 4, kind: 'ERC721', input: `${TOKEN} #0`, id: erc721Id(TOKEN, 0) },
  { n: 5, kind: 'ERC721', input: `${TOKEN} #1`, id: erc721Id(TOKEN, 1) },
  { n: 6, kind: 'ERC1155', input: `${TOKEN} #77`, id: erc1155Id(TOKEN, 77) },
  { n: 7, kind: 'NATIVE', input: 'anex on chain 1', id: nativeId(1) },
];

const rows = vectors.map((v) => ({ ...v, hex: toCanonicalString(v.id) }));

const payload = {
  spec: 'aid/SPEC.md',
  specVersion: SPEC_VERSION,
  chainId: DEFAULT_CHAIN_ID,
  domainSeparator: toCanonicalString(domainSeparator()),
  generatedBy: 'aid/test/emit-vectors.mjs',
  note: 'Generated. Do not edit by hand. Re-run `npm run vectors` after any spec change.',
  vectors: rows.map(({ n, kind, input, hex }) => ({ n, kind, input, assetId: hex })),
};

const outFile = path.join(here, '..', 'vectors.json');
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');

console.log('| # | Type | Input | assetId |');
console.log('|---|---|---|---|');
for (const r of rows) console.log(`| ${r.n} | \`${r.kind}\` | \`${r.input}\` | \`${r.hex}\` |`);
console.log('');
console.log(`domainSeparator = ${payload.domainSeparator}`);
console.log(`wrote ${path.relative(process.cwd(), outFile)}`);