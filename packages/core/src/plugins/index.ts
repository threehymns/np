export * from './editor';
export * from './types';
export * from './errors';
export * from './commands';
export * from './events';
export * from './hooks';
export * from './services';
export * from './settings';
export * from './ui-contributions';
export * from './host.svelte';
// NOTE: boundary-check is intentionally NOT re-exported here. It imports
// typescript + node:fs (dev/test tooling) which Vite externalizes for browser
// compatibility, crashing client code. Import it directly ('./boundary-check')
// from node runtimes (tests, scripts) instead.
export { manifest as gitManifest } from './git/manifest';
export { gitRegistration } from './git/registration';
