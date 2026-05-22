export interface VCSStatus {
	isDirty: boolean;
	uncommittedFiles: string[];
}

export interface VCSAdapter {
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getStatus(): Promise<VCSStatus>;
	canCheckoutBranch(branchName: string): Promise<boolean>;
	switchBranch(branchName: string): Promise<boolean>;
}
