import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { DOMAIN_AREAS, boundaryViolation, sourceOwnershipViolation } from './boundary-policy.mjs';

const domainAreas = new Set(DOMAIN_AREAS);
const TYPESCRIPT_EXTENSIONS = Object.freeze(['.cts', '.mts', '.ts', '.tsx']);

/** @param {string} path @returns {boolean} */
function isTypeScriptSource(path) {
  return TYPESCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** @param {string} path @returns {boolean} */
function isTestSource(path) {
  return /\.test\.(?:cts|mts|ts|tsx)$/u.test(path);
}

/** @param {string} directory @param {string[]} violations @returns {string[]} */
function sourceFiles(directory, violations) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = resolve(directory, entry);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        violations.push(`source symlink refused path=${path}`);
        return [];
      }
      return metadata.isDirectory() ? sourceFiles(path, violations) : [path];
    })
    .filter(isTypeScriptSource);
}

/** @param {string} sourceRoot @param {string} path @returns {string} */
function areaFor(sourceRoot, path) {
  return relative(sourceRoot, path).split(sep)[0] ?? '';
}

/** @param {ts.SourceFile} source @returns {(string | null)[]} */
function importSpecifiers(source) {
  /** @type {(string | null)[]} */
  const specifiers = [];

  /** @param {ts.Node} node @returns {void} */
  function inspect(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) {
        specifiers.push(node.argument.literal.text);
      }
    } else if (ts.isCallExpression(node)) {
      const isModuleLoad =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      if (isModuleLoad) {
        const argument = node.arguments[0];
        specifiers.push(
          node.arguments.length === 1 && argument !== undefined && ts.isStringLiteral(argument)
            ? argument.text
            : null,
        );
      }
    }
    ts.forEachChild(node, inspect);
  }

  inspect(source);
  return specifiers;
}

/** @param {string} importingFile @param {string} specifier @param {Set<string>} files @returns {string | null} */
function resolveLocalImport(importingFile, specifier, files) {
  const target = resolve(dirname(importingFile), specifier);
  const candidates = [
    target,
    ...TYPESCRIPT_EXTENSIONS.map((extension) => `${target}${extension}`),
    ...TYPESCRIPT_EXTENSIONS.map((extension) => resolve(target, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (files.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** @param {Map<string, Set<string>>} graph @returns {string[]} */
function cycleViolations(graph) {
  /** @type {string[]} */
  const violations = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @type {string[]} */
  const stack = [];

  /** @param {string} path @returns {void} */
  function visit(path) {
    if (visiting.has(path)) {
      const cycleStart = stack.indexOf(path);
      violations.push(`circular dependency ${[...stack.slice(cycleStart), path].join(' -> ')}`);
      return;
    }
    if (visited.has(path)) {
      return;
    }
    visiting.add(path);
    stack.push(path);
    for (const target of graph.get(path) ?? []) {
      visit(target);
    }
    stack.pop();
    visiting.delete(path);
    visited.add(path);
  }

  for (const path of graph.keys()) {
    visit(path);
  }
  return violations;
}

/**
 * @param {string} sourceRoot
 * @param {string} repositoryRoot
 * @returns {{existingDomainAreas: number, filesChecked: number, violations: string[]}}
 */
export function checkSourceBoundaries(sourceRoot, repositoryRoot) {
  /** @type {string[]} */
  const violations = [];
  const files = sourceFiles(sourceRoot, violations);
  const productionFiles = files.filter((path) => !isTestSource(path));
  const fileSet = new Set(files);
  /** @type {Map<string, Set<string>>} */
  const graph = new Map(productionFiles.map((path) => [path, new Set()]));

  for (const path of files) {
    const sourceRelativePath = relative(sourceRoot, path);
    const ownershipViolation = sourceOwnershipViolation(sourceRelativePath);
    if (ownershipViolation !== null) {
      violations.push(`${relative(repositoryRoot, path)} ${ownershipViolation}`);
    }
    if (isTestSource(path)) {
      continue;
    }

    const sourceArea = areaFor(sourceRoot, path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    for (const specifier of importSpecifiers(source)) {
      if (specifier === null) {
        violations.push(`${relative(repositoryRoot, path)} non-literal module load refused`);
        continue;
      }
      let targetArea;
      if (specifier.startsWith('.')) {
        const target = resolveLocalImport(path, specifier, fileSet);
        if (target !== null) {
          targetArea = areaFor(sourceRoot, target);
          if (isTestSource(target)) {
            violations.push(
              `${relative(repositoryRoot, path)} production import reaches test-only module ${specifier}`,
            );
          } else {
            graph.get(path)?.add(target);
          }
        } else if (domainAreas.has(sourceArea)) {
          violations.push(`${relative(repositoryRoot, path)} unresolved local import ${specifier}`);
        }
      }
      const violation = boundaryViolation({
        sourceArea,
        specifier,
        ...(targetArea === undefined ? {} : { targetArea }),
      });
      if (violation !== null) {
        violations.push(`${relative(repositoryRoot, path)} ${violation}`);
      }
    }
  }

  violations.push(
    ...cycleViolations(graph).map((violation) =>
      violation.replaceAll(`${repositoryRoot}${sep}`, ''),
    ),
  );
  return {
    existingDomainAreas: DOMAIN_AREAS.filter((area) => existsSync(resolve(sourceRoot, area)))
      .length,
    filesChecked: files.length,
    violations,
  };
}
