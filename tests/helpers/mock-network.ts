import type { Page } from '@playwright/test';

const MOCK_THEMES = {
	material: {
		name: "Material Icons",
		themes: [
			{
				name: "Material Icons",
				appearance: "dark",
				directory_icons: {
					collapsed: "icons/folder-base.svg",
					expanded: "icons/folder-open.svg"
				},
				named_directory_icons: {
					node_modules: { collapsed: "icons/folder-node.svg", expanded: "icons/folder-node-open.svg" },
					src: { collapsed: "icons/folder-src.svg", expanded: "icons/folder-src-open.svg" },
					dist: { collapsed: "icons/folder-dist.svg", expanded: "icons/folder-dist-open.svg" },
					".git": { collapsed: "icons/folder-git.svg", expanded: "icons/folder-git-open.svg" },
					public: { collapsed: "icons/folder-public.svg", expanded: "icons/folder-public-open.svg" },
					lib: { collapsed: "icons/folder-lib.svg", expanded: "icons/folder-lib-open.svg" },
					static: { collapsed: "icons/folder-resource.svg", expanded: "icons/folder-resource-open.svg" }
				},
				file_stems: {
					"readme.md": "readme",
					"package.json": "npm",
					"tsconfig.json": "tsconfig"
				},
				file_suffixes: {
					md: "readme",
					ts: "typescript"
				},
				file_icons: {
					default: { path: "icons/file.svg" },
					readme: { path: "icons/readme.svg" },
					npm: { path: "icons/npm.svg" },
					tsconfig: { path: "icons/tsconfig.svg" },
					typescript: { path: "icons/typescript.svg" }
				}
			}
		]
	},
	catppuccin: {
		name: "Catppuccin Icons",
		themes: [
			{
				name: "Catppuccin Icons",
				appearance: "dark",
				directory_icons: {
					collapsed: "icons/folder.svg",
					expanded: "icons/folder_open.svg"
				},
				named_directory_icons: {
					node_modules: { collapsed: "icons/folder_node.svg", expanded: "icons/folder_node_open.svg" },
					src: { collapsed: "icons/folder_src.svg", expanded: "icons/folder_src_open.svg" },
					dist: { collapsed: "icons/folder_dist.svg", expanded: "icons/folder_dist_open.svg" },
					".git": { collapsed: "icons/folder_git.svg", expanded: "icons/folder_git_open.svg" },
					public: { collapsed: "icons/folder_public.svg", expanded: "icons/folder_public_open.svg" },
					lib: { collapsed: "icons/folder_lib.svg", expanded: "icons/folder_lib_open.svg" },
					static: { collapsed: "icons/folder_assets.svg", expanded: "icons/folder_assets_open.svg" }
				},
				file_stems: {
					"package.json": "package",
					"tsconfig.json": "tsconfig"
				},
				file_suffixes: {
					json: "json",
					ts: "typescript"
				},
				file_icons: {
					default: { path: "icons/file.svg" },
					package: { path: "icons/npm.svg" },
					json: { path: "icons/json.svg" },
					tsconfig: { path: "icons/tsconfig.svg" },
					typescript: { path: "icons/typescript.svg" }
				}
			}
		]
	},
	vscode: {
		name: "VS Code Icons",
		themes: [
			{
				name: "VS Code Icons",
				appearance: "dark",
				directory_icons: {
					collapsed: "icons/folder.svg",
					expanded: "icons/folder_opened.svg"
				},
				named_directory_icons: {
					node_modules: { collapsed: "icons/folder_type_node.svg", expanded: "icons/folder_type_node_opened.svg" },
					src: { collapsed: "icons/folder_type_src.svg", expanded: "icons/folder_type_src_opened.svg" },
					dist: { collapsed: "icons/folder_type_dist.svg", expanded: "icons/folder_type_dist_opened.svg" },
					".git": { collapsed: "icons/folder_type_git.svg", expanded: "icons/folder_type_git_opened.svg" },
					public: { collapsed: "icons/folder_type_public.svg", expanded: "icons/folder_type_public_opened.svg" },
					lib: { collapsed: "icons/folder_type_library.svg", expanded: "icons/folder_type_library_opened.svg" },
					static: { collapsed: "icons/folder_type_asset.svg", expanded: "icons/folder_type_asset_opened.svg" }
				},
				file_icons: {
					default: { path: "icons/file.svg" },
					typescript: { path: "icons/typescript.svg" },
					javascript: { path: "icons/js.svg" },
					html: { path: "icons/html.svg" },
					svelte: { path: "icons/svelte.svg" }
				}
			}
		]
	}
};

export async function mockIconThemes(page: Page) {
	await page.route('https://cdn.jsdelivr.net/**', async (route) => {
		const url = route.request().url();
		if (url.includes('material-icon-theme.json')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: {
					'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
					'pragma': 'no-cache',
					'expires': '0'
				},
				body: JSON.stringify(MOCK_THEMES.material)
			});
		} else if (url.includes('catppuccin-icons.json')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: {
					'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
					'pragma': 'no-cache',
					'expires': '0'
				},
				body: JSON.stringify(MOCK_THEMES.catppuccin)
			});
		} else if (url.includes('vsicons-icon-theme-zed.json')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				headers: {
					'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
					'pragma': 'no-cache',
					'expires': '0'
				},
				body: JSON.stringify(MOCK_THEMES.vscode)
			});
		} else {
			if (url.endsWith('.svg')) {
				await route.fulfill({
					status: 200,
					contentType: 'image/svg+xml',
					headers: {
						'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
						'pragma': 'no-cache',
						'expires': '0'
					},
					body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="gray"/></svg>`
				});
			} else {
				await route.continue();
			}
		}
	});
}
