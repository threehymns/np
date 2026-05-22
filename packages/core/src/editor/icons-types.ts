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

export interface ProductIconProvider {
  readonly id: string;
  readonly name: string;
  
  resolveProductIcon(iconName: string): ResolvedIcon | null;
  setAppearance?(appearance: 'light' | 'dark'): void;
}
