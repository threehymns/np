import { describe, expect, it, beforeEach } from 'bun:test';
import { WatcherOwnership, type WatcherOwnerEvents } from './watcher-ownership';

class FakeWebContents implements WatcherOwnerEvents {
	readonly id: number;
	destroyed = false;
	private listeners = new Map<string, Set<() => void>>();
	removedDidStartNavigation = 0;

	constructor(id: number) {
		this.id = id;
	}

	once(event: string, listener: () => void): void {
		this.on(event, listener);
	}

	on(event: string, listener: () => void): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
	}

	removeListener(event: string, listener: () => void): void {
		if (event === 'did-start-navigation') this.removedDidStartNavigation++;
		this.listeners.get(event)?.delete(listener);
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	listenerCount(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}

	emit(event: string): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
	}
}

describe('WatcherOwnership', () => {
	let gone: number[];
	let owners: Map<number, FakeWebContents>;
	let ownership: WatcherOwnership;

	beforeEach(() => {
		gone = [];
		owners = new Map();
		ownership = new WatcherOwnership({
			onOwnerGone: (senderId) => {
				gone.push(senderId);
			},
			getOwner: (senderId) => owners.get(senderId),
		});
	});

	function contents(id: number): FakeWebContents {
		const wc = new FakeWebContents(id);
		owners.set(id, wc);
		return wc;
	}

	it('keeps exactly one did-start-navigation listener per owner across watch/unwatch cycles', () => {
		const wc = contents(1);
		ownership.track('a', wc);
		ownership.release('a');
		ownership.track('b', wc);
		expect(wc.listenerCount('did-start-navigation')).toBe(1);
		expect(wc.removedDidStartNavigation).toBe(1);
	});

	it('keeps the navigation listener while the owner still has watchers', () => {
		const wc = contents(1);
		ownership.track('a', wc);
		ownership.track('b', wc);
		ownership.release('a');
		expect(wc.listenerCount('did-start-navigation')).toBe(1);
		expect(wc.removedDidStartNavigation).toBe(0);
		expect(ownership.idsFor(1)).toEqual(['b']);
	});

	it('notifies when the owner navigates', () => {
		const wc = contents(7);
		ownership.track('a', wc);
		wc.emit('did-start-navigation');
		expect(gone).toEqual([7]);
	});

	it('notifies when the owner is destroyed', () => {
		const wc = contents(7);
		ownership.track('a', wc);
		wc.emit('destroyed');
		expect(gone).toEqual([7]);
	});

	it('skips removeListener when the owner is already destroyed', () => {
		const wc = contents(1);
		ownership.track('a', wc);
		wc.destroyed = true;
		ownership.release('a');
		expect(wc.removedDidStartNavigation).toBe(0);
	});

	it('finishStart returns false on the normal path', () => {
		const wc = contents(1);
		const token = ownership.beginStart('a', wc);
		expect(ownership.finishStart('a', token)).toBe(false);
	});

	it('finishStart reports cancelled after cancelStartsFor', () => {
		const wc = contents(1);
		const token = ownership.beginStart('a', wc);
		ownership.cancelStartsFor(1);
		expect(ownership.finishStart('a', token)).toBe(true);
	});

	it('cancelStart targets a single watchId', () => {
		const wc = contents(1);
		const tokenA = ownership.beginStart('a', wc);
		const tokenB = ownership.beginStart('b', wc);
		ownership.cancelStart('a');
		expect(ownership.finishStart('a', tokenA)).toBe(true);
		expect(ownership.finishStart('b', tokenB)).toBe(false);
	});

	it('a superseded start reports cancelled', () => {
		const wc = contents(1);
		const first = ownership.beginStart('a', wc);
		const second = ownership.beginStart('a', wc);
		expect(ownership.finishStart('a', first)).toBe(true);
		expect(ownership.finishStart('a', second)).toBe(false);
	});

	it('cancelStartsFor only affects that sender', () => {
		const wc1 = contents(1);
		const wc2 = contents(2);
		const token1 = ownership.beginStart('a', wc1);
		const token2 = ownership.beginStart('b', wc2);
		ownership.cancelStartsFor(1);
		expect(ownership.finishStart('a', token1)).toBe(true);
		expect(ownership.finishStart('b', token2)).toBe(false);
	});
});
