import type { Component } from 'svelte';

export type ResolvedIcon =
  | { type: 'component'; value: Component<any> }
  | { type: 'url'; value: string }
  | { type: 'svg'; value: string }
  | { type: 'empty' };

export interface IconQuery {
  resource: string;
  type: 'file' | 'folder' | 'product';
  language?: string;
  expanded?: boolean;
}

export interface FileIconProvider {
  readonly id: string;
  readonly name: string;
  
  resolveFileIcon(filename: string, context?: { language?: string }): ResolvedIcon | null;
  resolveFolderIcon(folderName: string, options?: { expanded?: boolean }): ResolvedIcon | null;
  getDefaultFileIcon(): ResolvedIcon | null;
  getDefaultFolderIcon(options?: { expanded?: boolean }): ResolvedIcon | null;
  setAppearance?(appearance: 'light' | 'dark'): void;
}

export const CORE_ICONS_OWNER = 'core';

export interface ProductIconProvider {
  readonly id: string;
  readonly name: string;
  
  resolveProductIcon(iconName: string): ResolvedIcon | null;
  setAppearance?(appearance: 'light' | 'dark'): void;
}

export type FileIconTransform = (
  previous: ReadonlyMap<string, FileIconProvider>
) => ReadonlyMap<string, FileIconProvider>;

export interface FileIconTransformEntry {
  readonly pluginId: string;
  readonly transform: FileIconTransform;
}

export type ProductIconTransform = (
  previous: ReadonlyMap<string, ProductIconProvider>
) => ReadonlyMap<string, ProductIconProvider>;

export interface ProductIconTransformEntry {
  readonly pluginId: string;
  readonly transform: ProductIconTransform;
}

export interface ThemeInfo {
  id: string;
  name: string;
  source: 'builtin' | 'installed';
}

export interface IconRegistryInterface {
  activeFileThemeId: string;
  activeProductThemeId: string;
  currentAppearance: 'light' | 'dark';
  registerFileTheme(id: string, provider: FileIconProvider): void;
  registerProductTheme(id: string, provider: ProductIconProvider): void;
  registerFileIconTransform(pluginId: string, transform: FileIconTransform): void;
  registerProductIconTransform(pluginId: string, transform: ProductIconTransform): void;
  removePluginIcons(pluginId: string): void;
  rebuild(): void;
  refresh(): void;
  getFileThemes(): ThemeInfo[];
  getProductThemes(): ThemeInfo[];
  setAppearance(appearance: 'light' | 'dark'): void;
  resolveFileIconChain(filename: string, context?: { language?: string }): ResolvedIcon[];
  resolveFolderIconChain(foldername: string, options?: { expanded?: boolean }): ResolvedIcon[];
  resolveProductIconChain(iconName: string): ResolvedIcon[];
  resolveFileIcon(filename: string, languageModeName?: string): any;
  getLanguageIcon(name: string): any;
  getFileIcon(filename: string): any;
  getFolderIcon(name: string): any;
  getThemeDefaultFileIcon(): any;
  getThemeDefaultFolderIcon(): any;
  getThemeDefaultFolderExpandedIcon(): any;
  initialize?(): Promise<void>;
}

