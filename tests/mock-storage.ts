import { mock } from "bun:test";
import type { Storage, FileOrigin } from "../../packages/core/src/storage";

export interface MockStorageOptions {
	pickDirectory?: () => Promise<FileOrigin | null>;
	queryPermission?: () => Promise<"granted" | "prompt" | "denied">;
	verifyPermission?: () => Promise<boolean>;
}

export function createMockStorage(overrides: MockStorageOptions = {}): Storage {
	return {
		pickFile: mock(async () => null),
		pickDirectory: mock(overrides.pickDirectory ?? (async () => null)),
		saveFile: mock(async () => null),
		readFile: mock(async () => ""),
		readDirectory: mock(async () => []),
		verifyPermission: mock(overrides.verifyPermission ?? (async () => false)),
		queryPermission: mock(overrides.queryPermission ?? (async () => "prompt" as const)),
		createFile: mock(async (_parent: FileOrigin, name: string) => ({ scheme: "file", path: `/${name}`, name })),
		createDirectory: mock(async (_parent: FileOrigin, name: string) => ({ scheme: "file", path: `/${name}`, name })),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (_origin: FileOrigin, newName: string) => ({ scheme: "file", path: `/${newName}`, name: newName }))
	};
}
