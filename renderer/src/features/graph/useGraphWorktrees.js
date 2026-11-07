import { useEffect, useRef, useState } from 'react';
import { createBoardRefresh } from '../tools/board-refresh.js';
import { otherWorktrees } from './worktree-lanes.js';

const NONE = { base: null, worktrees: [] };

/**
 * The other worktrees of this repository, for the rows above the graph. Read
 * when the graph comes into view, when a branch moves, on Refresh, when an
 * agent connects or proposes a commit, and on coming back to the window: an
 * agent's edits touch no ref, so nothing else would tell. Never on a timer, and
 * through the same gate as the Worktrees screen, so agents committing at once
 * cost one read at a time. A read that fails leaves the rows as they were: this
 * is an extra on the graph, and the Worktrees screen says what went wrong.
 * @param {{ repositoryId: string, enabled: boolean, tips: string, refresh: unknown }} options
 */
export function useGraphWorktrees({ repositoryId, enabled, tips, refresh }) {
  const [board, setBoard] = useState(NONE);
  const gate = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const read = async fresh => {
      try {
        const next = await window.twig.getGraphWorktrees(repositoryId, fresh);
        if (!alive) return;
        const worktrees = otherWorktrees(next.worktrees);
        // Same answer, same object: the graph draws nothing again.
        setBoard(current => {
          if (!worktrees.length) return NONE;
          return JSON.stringify(current.worktrees) === JSON.stringify(worktrees) && current.base === next.base ? current : { base: next.base, worktrees };
        });
      } catch { /* see above */ }
    };
    const refreshGate = createBoardRefresh({ read });
    gate.current = refreshGate;
    refreshGate.request({ fresh: true, urgent: true });
    let blurredAt = 0;
    const onBlur = () => { blurredAt = Date.now(); };
    const onFocus = () => { if (blurredAt && Date.now() - blurredAt > 1500) refreshGate.request({ fresh: true }); blurredAt = 0; };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    const offAgents = window.twig.onMcpAgents(() => refreshGate.request());
    const offProposal = window.twig.onCommitProposal(() => refreshGate.request());
    return () => {
      alive = false;
      refreshGate.stop(); gate.current = null;
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      offAgents(); offProposal();
    };
  }, [repositoryId, enabled]);

  // Skips the first value: the read above has already asked.
  const seen = useRef({ tips, refresh });
  useEffect(() => { if (seen.current.tips !== tips) { seen.current.tips = tips; gate.current?.request(); } }, [tips]);
  useEffect(() => { if (seen.current.refresh !== refresh) { seen.current.refresh = refresh; gate.current?.request({ fresh: true, urgent: true }); } }, [refresh]);
  return board;
}
