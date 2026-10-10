/**
 * The refs whose commits make up the history 🌱 Twig draws: `--all`, minus
 * the namespaces that hold no history a person made. An `--exclude` applies to
 * the `--all` after it, so the order matters. No imports: argv builders on
 * both sides of the app load it.
 *
 * - refs/stash: a stash is drawn as a marker on its base commit.
 * - refs/twig/*: 🌱 Twig's own backups (discard, .gitignore edits).
 * - refs/notes/*: `git notes` keeps notes as commits ("Notes added by …").
 * - refs/prefetch/*: `git maintenance` fetches into these in the background;
 *   their commits are on no branch the sidebar shows.
 * - refs/original/*: the copy of rewritten history `git filter-branch` keeps.
 * - refs/replace/*, refs/rewritten/*: replacement objects, and the labels of a
 *   `rebase --rebase-merges` while it runs.
 * Without these, such commits appeared as rows with no branch and no name.
 */
export const HISTORY_REFS = Object.freeze([
  '--exclude=refs/stash', '--exclude=refs/twig/*', '--exclude=refs/notes/*', '--exclude=refs/prefetch/*',
  '--exclude=refs/original/*', '--exclude=refs/replace/*', '--exclude=refs/rewritten/*', '--all'
]);
