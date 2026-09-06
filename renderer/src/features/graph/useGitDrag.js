import { useCallback, useEffect, useRef, useState } from 'react';
import { sameEndpoint } from '../../../../main/git/drop-plan.js';

export const refEndpoint = ref => ref.type === 'tag' ? { kind: 'commit', oid: ref.target, ref: null }
  : { kind: ref.type, oid: ref.target, ref: ref.fullName };

export function rowEndpoint(commit, refs = [], headBranch) {
  const branches = refs.filter(ref => ref.type !== 'tag');
  const current = branches.find(ref => ref.type === 'local' && ref.name === headBranch);
  return current ? refEndpoint(current) : branches.length === 1 ? refEndpoint(branches[0])
    : { kind: 'commit', oid: commit.oid, ref: null };
}

export default function useGitDrag({ active, revision, onDrop, onStart }) {
  const [state, setState] = useState(null);
  const current = useRef(null);
  const update = useCallback(value => { current.current = value; setState(value); }, []);
  const cancel = useCallback(() => update(null), [update]);
  useEffect(() => { if (!active) cancel(); }, [active, cancel]);
  useEffect(() => { cancel(); }, [revision, cancel]);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && current.current?.phase === 'drag') cancel(); };
    const end = () => { if (current.current?.phase === 'drag') cancel(); };
    addEventListener('keydown', escape);
    addEventListener('blur', cancel);
    addEventListener('dragend', end);
    return () => { removeEventListener('keydown', escape); removeEventListener('blur', cancel); removeEventListener('dragend', end); };
  }, [cancel]);

  function start(source, event, keyboard = false) {
    if (!active) return;
    event.stopPropagation();
    if (!keyboard) {
      event.dataTransfer.effectAllowed = 'link';
      event.dataTransfer.setData('application/x-twig-git', 'internal');
    }
    update({ source, target: null, phase: 'drag', keyboard });
    onStart?.();
  }
  function hover(target, event) {
    if (current.current?.phase !== 'drag') return;
    event.stopPropagation();
    const valid = !sameEndpoint(current.current.source, target);
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = valid ? 'link' : 'none';
    if (!sameEndpoint(current.current.target, target)) update({ ...current.current, target });
  }
  function drop(target, event) {
    if (current.current?.phase !== 'drag') return;
    event.preventDefault(); event.stopPropagation();
    const source = current.current.source;
    if (sameEndpoint(source, target)) { cancel(); return; }
    update({ source, target, phase: 'menu' });
    const rect = event.currentTarget.getBoundingClientRect();
    onDrop(source, target, event.clientX || rect.left + 24, event.clientY || rect.bottom);
  }
  function keydown(item, event) {
    if (event.altKey && event.code === 'KeyD') { event.preventDefault(); start(item, event, true); }
    else if (event.altKey && event.key === 'Enter') drop(item, event);
  }
  const className = item => [sameEndpoint(state?.source, item) ? 'drag-source' : '', sameEndpoint(state?.target, item) ? 'drag-target' : ''].join(' ');
  return {
    state, cancel, className, keydown,
    bind: item => ({
      draggable: active, 'data-drag-ref': item.ref || undefined,
      onDragStart: event => start(item, event),
      onFocus: event => { if (current.current?.keyboard) hover(item, event); },
      onDragOver: event => hover(item, event),
      onDragLeave: event => {
        if (!event.currentTarget.contains(event.relatedTarget) && sameEndpoint(current.current?.target, item) && current.current?.phase === 'drag') update({ ...current.current, target: null });
      },
      onDrop: event => drop(item, event),
      onDragEnd: () => { if (current.current?.phase === 'drag') cancel(); },
      onKeyDown: event => keydown(item, event)
    })
  };
}
