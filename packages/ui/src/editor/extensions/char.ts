/**
 * Returns true if character code `c` is an ASCII word character (0-9, A-Z, a-z, _, -).
 */
export function isWord(c: number): boolean {
	return (
		(c >= 48 && c <= 57) || // 0-9
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		c === 95 || // _
		c === 45 // -
	);
}
