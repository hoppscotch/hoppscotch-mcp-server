/**
 * Validate every GraphQL document this client sends against a real backend
 * schema. The unit tests mock the transport, so they cannot catch a wrong
 * argument name or a missing selection set: the mock returns whatever the test
 * expects regardless of what was asked for. Four such bugs shipped that way.
 *
 * Usage: node scripts/validate-graphql.mjs <introspection.json>
 * Capture the schema with the standard introspection query, e.g. against
 * https://api.hoppscotch.io/graphql or a self-hosted instance.
 */
import { buildClientSchema, parse, validate, specifiedRules } from 'graphql';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const intro = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const schema = buildClientSchema(intro.data);

// pull every exported template-literal operation out of the source
const files = ['src/graphql/queries.ts', 'src/graphql/mutations.ts'];
const ops = [];
for (const f of files) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const re = /export const (\w+)\s*=\s*`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(src))) ops.push({ file: f, name: m[1], doc: m[2] });
}

let bad = 0;
for (const o of ops) {
  let errs;
  try { errs = validate(schema, parse(o.doc), specifiedRules); }
  catch (e) { errs = [{ message: 'PARSE: ' + e.message }]; }
  if (errs.length) {
    bad++;
    console.log(`\nFAIL  ${o.name}  (${o.file})`);
    for (const e of errs.slice(0, 4)) console.log('        ' + e.message);
  }
}
console.log(`\n=== ${ops.length} operations validated against the live Cloud schema ===`);
console.log(bad === 0 ? 'ALL VALID' : `${bad} INVALID`);
process.exit(bad === 0 ? 0 : 1);
