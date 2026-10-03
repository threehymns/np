/**
 * One line about a failure, for a log entry or a status reason.
 *
 * A rejected value is `unknown`, and both places that report one want the same
 * answer: the message when there is an `Error`, and whatever the value stringifies
 * to when there is not. Two copies of that is two places to keep in step, and the
 * plugin's failures are exactly the thing a user is asked to read out of a log
 * tab.
 */
export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
