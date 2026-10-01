import { describe, it, expect } from 'bun:test';
import { describeScopeRestriction } from './scope-restriction';

describe('Settings scope restriction notice', () => {
	it('tells a user looking at workspace settings to edit the user settings instead', () => {
		const notice = describeScopeRestriction(['user'], 'workspace');

		expect(notice).not.toBeNull();
		expect(notice?.badge).toBe('User scope only');
		expect(notice?.guidance).toBe(
			'This setting cannot be overridden at workspace level. Edit in User settings.'
		);
	});

	it('tells a user looking at user settings to edit the workspace settings instead', () => {
		// The asymmetry this guards: the notice used to name User regardless of
		// which scope was open, so a workspace-only setting shown on the User tab
		// read "User scope only" and "Edit in User settings".
		const notice = describeScopeRestriction(['workspace'], 'user');

		expect(notice?.allowedScope).toBe('workspace');
		expect(notice?.badge).toBe('Workspace scope only');
		expect(notice?.guidance).toBe(
			'This setting cannot be overridden at user level. Edit in Workspace settings.'
		);
	});

	it('shows no notice when the setting allows the scope being viewed', () => {
		expect(describeScopeRestriction(['user'], 'user')).toBeNull();
		expect(describeScopeRestriction(['workspace'], 'workspace')).toBeNull();
		expect(describeScopeRestriction(['user', 'workspace'], 'workspace')).toBeNull();
	});

	it('shows no notice when the setting declares no scope restriction', () => {
		expect(describeScopeRestriction(undefined, 'user')).toBeNull();
		expect(describeScopeRestriction(undefined, 'workspace')).toBeNull();
	});
});
