export { default as AppShell } from './AppShell.svelte';
export { default as MainLayout } from './components/MainLayout.svelte';
export { default as Editor } from './components/Editor.svelte';
export { default as FileExplorer } from './components/FileExplorer.svelte';
export { default as FileTreeItem } from './components/FileTreeItem.svelte';
export { default as BranchSafetyModal } from './components/BranchSafetyModal.svelte';
export { default as SettingsModal } from './components/SettingsModal.svelte';
export { default as CommandPalette } from './components/CommandPalette.svelte';
export { default as Icon } from './components/Icon.svelte';
export * from './editor/index';
export { IconRegistry, iconRegistry, PhosphorIconProvider } from './editor/icons.svelte';
export * as Tabs from './components/ui/tabs/index';
export * as ScrollArea from './components/ui/scroll-area/index';

// Generic bundled-plugin UI bridge (no feature names here)
export { registerBundledPlugins, registerPluginUiLoader } from './plugins/index';

// Settings UI
export { default as GeneratedSettingControl } from './components/settings/GeneratedSettingControl.svelte';
export { default as GeneratedSettingsSection } from './components/settings/GeneratedSettingsSection.svelte';
