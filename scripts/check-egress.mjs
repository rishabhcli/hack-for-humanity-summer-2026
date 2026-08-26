/**
 * Build-time enforcement of the frame-egress policy.
 *
 * Walks the TypeScript AST of every shipped source file and reports any reference to a network or
 * frame-serialization API. Runs inside `npm run lint`, which runs inside `verify-all`.
 *
 * This is deliberately a *name* check rather than a type-aware one. `globalThis['fet' + 'ch']`
 * would evade it — but so would anything short of a full taint analysis, and the point is to make
 * frame egress something a contributor has to work at rather than something they can reach by
 * accident. The end-to-end network assertion covers the runtime side of the same invariant.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { egressViolation, prohibitedApiCount } from './egress-policy.mjs';

const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');

/** @param {string} directory @returns {string[]} */
export function shippedSourceFiles(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...shippedSourceFiles(path));
      continue;
    }
    // Test files are not shipped, and they deliberately name prohibited APIs in order to assert
    // that the gate rejects them.
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Every identifier and member name referenced in a source file, with its line.
 *
 * Declaration names are skipped: a local called `fetch` that is never a call target is not an
 * egress path, and flagging it would push contributors toward writing exemptions.
 *
 * @param {string} path
 * @param {string} contents
 * @returns {Array<{line: number, name: string}>}
 */
export function referencedNames(path, contents) {
  const sourceFile = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  /** @type {Array<{line: number, name: string}>} */
  const names = [];

  /** @param {import('typescript').Node} node @returns {void} */
  function visit(node) {
    if (ts.isPropertyAccessExpression(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
      names.push({ line: line + 1, name: node.name.text });
    } else if (ts.isIdentifier(node)) {
      const parent = /** @type {import('typescript').Node | undefined} */ (node.parent);
      const isDeclarationName =
        parent !== undefined &&
        (ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isImportSpecifier(parent)) &&
        parent.name === node;
      // The member name of a property access was already recorded by the branch above; recording
      // it again here would double-count `globalThis.fetch(...)` as two violations.
      const isAlreadyRecordedMemberName =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isDeclarationName && !isAlreadyRecordedMemberName) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        names.push({ line: line + 1, name: node.text });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

/**
 * Every egress violation in one file's contents.
 *
 * @param {string} file repository-relative path
 * @param {string} contents
 * @returns {Array<{code: string, line: number, name: string, rationale: string}>}
 */
export function egressViolationsIn(file, contents) {
  /** @type {Array<{code: string, line: number, name: string, rationale: string}>} */
  const findings = [];
  for (const reference of referencedNames(file, contents)) {
    const violation = egressViolation(file, reference.name);
    if (violation !== null) {
      findings.push({ ...violation, line: reference.line, name: reference.name });
    }
  }
  return findings;
}

/** @returns {void} */
function main() {
  /** @type {Array<{code: string, location: string, name: string, rationale: string}>} */
  const findings = [];
  let scannedFiles = 0;

  for (const path of shippedSourceFiles(SOURCE_ROOT)) {
    scannedFiles += 1;
    const file = relative(REPOSITORY_ROOT, path);
    for (const finding of egressViolationsIn(file, readFileSync(path, 'utf8'))) {
      findings.push({
        code: finding.code,
        location: `${file}:${String(finding.line)}`,
        name: finding.name,
        rationale: finding.rationale,
      });
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `EGRESS_POLICY_VIOLATION ${finding.code} location=${finding.location} api="${finding.name}" reason="${finding.rationale}"`,
      );
    }
    console.error(`egress-check failed violations=${String(findings.length)}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `egress-check passed files=${String(scannedFiles)} prohibited-apis=${String(prohibitedApiCount())} exemptions=0 scope=src/**/*.ts`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
