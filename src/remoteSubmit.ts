export interface RemoteSubmitDocumentInfo {
    scheme: string;
    path: string;
    fileName?: string;
}

export interface RemoteSubmitPromptOptions {
    title: string;
    prompt: string;
    placeHolder: string;
    initialValue?: string;
}

export function getRemoteSubmitPromptOptions(document?: RemoteSubmitDocumentInfo): RemoteSubmitPromptOptions {
    if (document?.scheme === 'slurm-remote' && document.path.startsWith('/')) {
        return {
            title: 'Submit Remote SLURM Script',
            prompt: 'Submit this existing remote SLURM script path.',
            placeHolder: document.path,
            initialValue: document.path,
        };
    }

    const scriptName = document?.fileName || 'train.sbatch';
    return {
        title: 'Submit Remote SLURM Script',
        prompt: 'Enter the absolute remote path to a SLURM submit script that already exists on the cluster. The current local editor file is not uploaded or path-mapped.',
        placeHolder: `/home/user/project/${scriptName}`,
    };
}
