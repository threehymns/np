export type Predicate =
	| { type: 'identifier'; name: string }
	| { type: 'equal'; left: string; right: string }
	| { type: 'not_equal'; left: string; right: string }
	| { type: 'not'; pred: Predicate }
	| { type: 'and'; left: Predicate; right: Predicate }
	| { type: 'or'; left: Predicate; right: Predicate };

const PRECEDENCE_OR = 1;
const PRECEDENCE_AND = 2;
const PRECEDENCE_EQ = 3;
const PRECEDENCE_NOT = 4;

function isIdentifierChar(c: string): boolean {
	return /^[a-zA-Z0-9_-]$/.test(c);
}

export class ContextPredicate {
	static parse(source: string): Predicate {
		source = source.trim();
		if (!source) {
			return { type: 'identifier', name: 'true' }; // Empty context is always true
		}
		const [pred, rest] = this.parseExpr(source, 0);
		if (rest.trim().length > 0) {
			throw new Error(`Unexpected character in context predicate: ${rest}`);
		}
		return pred;
	}

	private static parseExpr(source: string, minPrecedence: number): [Predicate, string] {
		let [pred, rest] = this.parsePrimary(source);
		source = rest.trim();

		while (true) {
			let matched = false;
			const operators = [
				{ op: '&&', precedence: PRECEDENCE_AND, type: 'and' as const },
				{ op: '||', precedence: PRECEDENCE_OR, type: 'or' as const },
				{ op: '==', precedence: PRECEDENCE_EQ, type: 'equal' as const },
				{ op: '!=', precedence: PRECEDENCE_EQ, type: 'not_equal' as const }
			];

			for (const { op, precedence, type } of operators) {
				if (source.startsWith(op) && precedence >= minPrecedence) {
					source = source.slice(op.length).trim();
					const [right, nextRest] = this.parseExpr(source, precedence + 1);
					if (type === 'equal' || type === 'not_equal') {
						if (pred.type !== 'identifier' || right.type !== 'identifier') {
							throw new Error(`Operands of ${op} must be identifiers`);
						}
						pred = { type, left: pred.name, right: right.name };
					} else {
						pred = { type, left: pred, right: right };
					}
					source = nextRest.trim();
					matched = true;
					break;
				}
			}

			if (!matched) break;
		}

		return [pred, source];
	}

	private static parsePrimary(source: string): [Predicate, string] {
		source = source.trim();
		if (source.startsWith('(')) {
			source = source.slice(1).trim();
			const [pred, rest] = this.parseExpr(source, 0);
			if (!rest.startsWith(')')) {
				throw new Error("Expected a ')'");
			}
			return [pred, rest.slice(1).trim()];
		}

		if (source.startsWith('!')) {
			const sub = source.slice(1).trim();
			const [pred, rest] = this.parseExpr(sub, PRECEDENCE_NOT);
			return [{ type: 'not', pred }, rest];
		}

		const match = /^[a-zA-Z0-9_-]+/.exec(source);
		if (match) {
			const name = match[0];
			return [{ type: 'identifier', name }, source.slice(name.length).trim()];
		}

		throw new Error(`Unexpected character at start of expression: ${source}`);
	}

	static eval(pred: Predicate, context: Record<string, string | boolean>): boolean {
		if (pred.type === 'identifier' && pred.name === 'true') {
			return true;
		}
		switch (pred.type) {
			case 'identifier':
				return !!context[pred.name];
			case 'equal':
				return String(context[pred.left]) === pred.right;
			case 'not_equal':
				return String(context[pred.left]) !== pred.right;
			case 'not':
				return !this.eval(pred.pred, context);
			case 'and':
				return this.eval(pred.left, context) && this.eval(pred.right, context);
			case 'or':
				return this.eval(pred.left, context) || this.eval(pred.right, context);
		}
	}
}
