// The pipeline being edited and not saved yet, per repository.
//
// The editor is a state of the Automations screen, and any click in the
// sidebar unmounts that screen. A pipeline of six steps typed by hand must not
// go with it, so the draft is kept here, outside any component, until it is
// saved or cancelled. Like the conflict drafts it lives in memory: a restart
// loses it. No imports: Vite and the Node check both load this module directly.

const drafts = new Map();

/** @returns {?{ isNew: boolean, pipeline: object }} */
export const readPipelineDraft = repositoryId => drafts.get(repositoryId) || null;

export function writePipelineDraft(repositoryId, editing) {
  drafts.set(repositoryId, editing);
}

export function dropPipelineDraft(repositoryId) {
  drafts.delete(repositoryId);
}
