import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
	if (!window.Buffer) {
		(window as any).Buffer = Buffer;
	}
	if (!(window as any).process) {
		(window as any).process = {
			env: {},
			nextTick: (cb: Function) => setTimeout(cb, 0),
			browser: true
		};
	}
}
