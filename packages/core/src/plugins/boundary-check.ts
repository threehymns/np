import ts from 'typescript';
import { readFileSync } from 'node:fs';

export interface ManifestBoundaryViolation {
	file?: string;
	line?: number;
	moduleSpecifier: string;
	reason: string;
}

export interface ManifestBoundaryResult {
	valid: boolean;
	violations: ManifestBoundaryViolation[];
}

const HEAVY_PACKAGES = [
	'@codemirror',
	'svelte',
	'@np/ui',
	['phosphor', 'svelte'].join('-'),
	'isomorphic-git',
	'marked',
	'electron',
	'node:fs',
	'node:child_process',
	'node:crypto',
	'node:net',
	'node:http',
	'fs',
	'child_process'
];

/**
 * Checks whether a module specifier matches a known heavy package or runtime implementation.
 */
function isHeavyOrImplementationModule(specifier: string): { isViolation: boolean; reason: string } {
	for (const pkg of HEAVY_PACKAGES) {
		if (specifier === pkg || specifier.startsWith(pkg + '/')) {
			return {
				isViolation: true,
				reason: `Manifest modules must not import heavy package "${specifier}". Manifests must remain dependency-free to allow inspection without loading runtime dependencies.`
			};
		}
	}

	// Implementation files: ./index, ./setup, or other relative implementation code
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		// If it imports index, setup, svelte components, or other non-type files
		if (
			specifier.includes('index') ||
			specifier.includes('setup') ||
			specifier.endsWith('.svelte') ||
			specifier.includes('side-effect')
		) {
			return {
				isViolation: true,
				reason: `Manifest modules must not import plugin implementation module "${specifier}". Keep manifests decoupled from implementation logic.`
			};
		}
		// Any other relative runtime import is disallowed in manifests
		return {
			isViolation: true,
			reason: `Manifest modules must not import local runtime module "${specifier}". Only type imports are allowed.`
		};
	}

	// Any other external non-type import is also flagged as violation to ensure manifests stay dependency-free
	return {
		isViolation: true,
		reason: `Manifest modules must stay dependency-free. Found runtime import "${specifier}". Use "import type" instead.`
	};
}

/**
 * Validates the AST of a manifest module source string.
 */
export function checkManifestSource(source: string, filename = 'manifest.ts'): ManifestBoundaryResult {
	const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
	const violations: ManifestBoundaryViolation[] = [];

	function getLineNumber(pos: number): number {
		return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
	}

	function visit(node: ts.Node) {
		// Check static import declarations
		if (ts.isImportDeclaration(node)) {
			const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';

			// Side-effect import: e.g. import './side-effect';
			if (!node.importClause) {
				violations.push({
					file: filename,
					line: getLineNumber(node.getStart()),
					moduleSpecifier: specifier,
					reason: `Side-effect import "${specifier}" is forbidden in manifest modules. Manifests must be pure metadata.`
				});
				return;
			}

			// Clause is explicitly type-only: import type { ... } from '...';
			if (node.importClause.isTypeOnly) {
				return;
			}

			// Check individual named imports: import { type Foo, Bar } from '...';
			if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
				const elements = node.importClause.namedBindings.elements;
				const nonTypeElements = elements.filter((el) => !el.isTypeOnly);
				if (nonTypeElements.length === 0) {
					// All specifiers are type-only
					return;
				}
			}

			// If it's a value import, check if it's heavy or implementation
			const check = isHeavyOrImplementationModule(specifier);
			if (check.isViolation) {
				violations.push({
					file: filename,
					line: getLineNumber(node.getStart()),
					moduleSpecifier: specifier,
					reason: check.reason
				});
			}
		}

		// Check export declarations with re-exports: export { Foo } from './foo';
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text;
			if (!node.isTypeOnly) {
				const check = isHeavyOrImplementationModule(specifier);
				if (check.isViolation) {
					violations.push({
						file: filename,
						line: getLineNumber(node.getStart()),
						moduleSpecifier: specifier,
						reason: `Re-exporting runtime values from "${specifier}" is forbidden in manifest modules. Manifests must be pure metadata.`
					});
				}
			}
		}

		// Check dynamic import() expressions: import('./foo')
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0
		) {
			const firstArg = node.arguments[0];
			const specifier = ts.isStringLiteral(firstArg) ? firstArg.text : '<dynamic>';
			violations.push({
				file: filename,
				line: getLineNumber(node.getStart()),
				moduleSpecifier: specifier,
				reason: `Dynamic import("${specifier}") is forbidden in manifest modules. Manifests must be static metadata.`
			});
		}

		// Check require() calls: require('foo')
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'require' &&
			node.arguments.length > 0
		) {
			const firstArg = node.arguments[0];
			const specifier = ts.isStringLiteral(firstArg) ? firstArg.text : '<dynamic>';
			violations.push({
				file: filename,
				line: getLineNumber(node.getStart()),
				moduleSpecifier: specifier,
				reason: `require("${specifier}") is forbidden in manifest modules. Manifests must be static metadata.`
			});
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);

	return {
		valid: violations.length === 0,
		violations
	};
}

/**
 * Validates a manifest file from the filesystem.
 */
export function checkManifestFile(filePath: string): ManifestBoundaryResult {
	const source = readFileSync(filePath, 'utf-8');
	return checkManifestSource(source, filePath);
}

/**
 * Asserts that a manifest file or source complies with the import boundary.
 * Throws an actionable error if any violations exist.
 */
export function assertManifestBoundary(filePathOrSource: string, isFilePath = true): void {
	const result = isFilePath ? checkManifestFile(filePathOrSource) : checkManifestSource(filePathOrSource);
	if (!result.valid) {
		const formattedViolations = result.violations
			.map((v) => `  - Line ${v.line ?? '?'}: [${v.moduleSpecifier}] ${v.reason}`)
			.join('\n');
		throw new Error(
			`Manifest module boundary violation in ${result.violations[0]?.file ?? 'manifest'}:\n` +
				`${formattedViolations}\n` +
				`Action: Remove runtime imports from the manifest module. Use "import type" for type definitions, and move implementation imports into the plugin setup module.`
		);
	}
}
