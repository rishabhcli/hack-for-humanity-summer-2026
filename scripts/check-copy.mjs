/**
 * Build-time enforcement of the shipped-copy policy.
 *
 * `GOAL.md` §6 Tier 2 item 8 requires a build-time lint that fails on diagnostic or
 * return-to-activity language anywhere in shipped copy. This walks the TypeScript AST of every
 * shipped source file and collects every string and template literal — the runtime module can only
 * police the strings routed through it, and the strings that would do harm are exactly the ones a
 * future contributor writes somewhere else.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { copyViolations } from './copy-policy.mjs';

const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');
const DOCUMENT_SHELL = join(REPOSITORY_ROOT, 'index.html');

/** @param {string} directory @returns {string[]} */
function shippedSourceFiles(directory) {
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
    // Test files are not shipped, and they deliberately contain prohibited phrasing in order to
    // assert that it is refused.
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Every string and template literal in a source file, with its line number.
 *
 * @param {string} path
 * @returns {Array<{line: number, text: string}>}
 */
export function literalsIn(path) {
  const contents = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  /** @type {Array<{line: number, text: string}>} */
  const literals = [];

  /** @param {import('typescript').Node} node @returns {void} */
  function visit(node) {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      literals.push({ line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

/**
 * Visible text of the document shell, with markup removed.
 *
 * @param {string} html
 * @returns {string}
 */
export function documentText(html) {
  return html
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

/** @returns {void} */
function main() {
  /** @type {Array<{code: string, label: string, location: string, phrase: string}>} */
  const findings = [];
  let scannedLiterals = 0;

  for (const path of shippedSourceFiles(SOURCE_ROOT)) {
    for (const literal of literalsIn(path)) {
      scannedLiterals += 1;
      for (const violation of copyViolations(literal.text)) {
        findings.push({
          ...violation,
          location: `${relative(REPOSITORY_ROOT, path)}:${String(literal.line)}`,
        });
      }
    }
  }

  const shellText = documentText(readFileSync(DOCUMENT_SHELL, 'utf8'));
  scannedLiterals += 1;
  for (const violation of copyViolations(shellText)) {
    findings.push({ ...violation, location: 'index.html' });
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `COPY_POLICY_VIOLATION ${finding.code} location=${finding.location} phrase="${finding.phrase}" rule="${finding.label}"`,
      );
    }
    console.error(`copy-check failed violations=${String(findings.length)}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `copy-check passed literals=${String(scannedLiterals)} rules=3 scope=src/**/*.ts,index.html`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
