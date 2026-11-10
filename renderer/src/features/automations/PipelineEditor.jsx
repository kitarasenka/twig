import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { HOOK_EVENTS, eventPhase } from './event-labels.js';
import { ACTION_TYPES, CONDITION_TYPES, makeId, normalizePipeline, validatePipeline } from './schema.js';
import { matchesShortcut } from '../../app/shortcuts.js';
import { mark, t } from '../../i18n/i18n.js';

const ACTION_LABELS = {
  command: mark('Run command'), script: mark('Run script'), validateMessage: mark('Validate commit message'),
  checkBranch: mark('Protect branches'), checkChangedFiles: mark('Check changed files'), secretScan: mark('Scan for secrets'), bumpVersion: mark('Bump version'), custom: mark('Custom command')
};
const CONDITION_LABELS = {
  changedFiles: mark('Changed files match'), branch: mark('Branch matches'), remote: mark('Pushing to remote'), messageContains: mark('Message contains')
};

function move(list, from, to) {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function ConditionList({ conditions, onChange, phase }) {
  const set = (index, patch) => onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  return <div className="rule-list">
    {conditions.map((condition, index) => <div className="rule-row" key={index}>
      <select aria-label={t('Condition type')} value={condition.type} onChange={e => set(index, { type: e.target.value })}>
        {CONDITION_TYPES.filter(type => type !== 'remote' || phase === 'pre').map(type => <option key={type} value={type}>{t(CONDITION_LABELS[type])}</option>)}
      </select>
      <div className="rule-body">
        {condition.type === 'changedFiles' && <>
          <input type="text" aria-label={t('File glob')} placeholder="**/*.ts" value={condition.glob || ''} onChange={e => set(index, { glob: e.target.value })} />
          <select aria-label={t('Match mode')} value={condition.mode || 'any'} onChange={e => set(index, { mode: e.target.value })}>
            <option value="any">{t('at least one')}</option><option value="none">{t('none')}</option>
          </select>
        </>}
        {condition.type === 'branch' && <input type="text" aria-label={t('Branch pattern')} placeholder="feature/*" value={condition.pattern || ''} onChange={e => set(index, { pattern: e.target.value })} />}
        {condition.type === 'remote' && <input type="text" aria-label={t('Remote name')} placeholder="origin" value={condition.name || ''} onChange={e => set(index, { name: e.target.value })} />}
        {condition.type === 'messageContains' && <input type="text" aria-label={t('Text')} placeholder="[skip-checks]" value={condition.text || ''} onChange={e => set(index, { text: e.target.value })} />}
        <label className="switch"><input type="checkbox" checked={condition.negate === true} onChange={e => set(index, { negate: e.target.checked })} /><span className="track" />{t('not')}</label>
      </div>
      <Button icon={Trash2} className="danger quiet" aria-label={t('Remove condition')} onClick={() => onChange(conditions.filter((_, i) => i !== index))} />
    </div>)}
    <Button icon={Plus} onClick={() => onChange([...conditions, { type: 'branch', pattern: '*' }])}>{t('Add condition')}</Button>
  </div>;
}

function ActionRow({ action, index, count, phase, onChange, onRemove, onReorder }) {
  const set = patch => onChange({ ...action, ...patch });
  return <li className="rule-row" draggable
    onDragStart={e => { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.effectAllowed = 'move'; }}
    onDragOver={e => e.preventDefault()}
    onDrop={e => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); if (!Number.isNaN(from)) onReorder(from, index); }}
    onKeyDown={e => { const step = matchesShortcut(e, 'moveUp') ? -1 : matchesShortcut(e, 'moveDown') ? 1 : 0; if (step) { e.preventDefault(); onReorder(index, index + step); } }}>
    <GripVertical aria-hidden="true" className="grip" />
    <div className="rule-move">
      <Button icon={ChevronUp} aria-label={t('Move action up')} reason={index === 0 ? t('First') : undefined} onClick={() => onReorder(index, index - 1)} />
      <Button icon={ChevronDown} aria-label={t('Move action down')} reason={index === count - 1 ? t('Last') : undefined} onClick={() => onReorder(index, index + 1)} />
    </div>
    <div className="rule-body stacked">
      <div className="row">
        <label style={{ flex: 1 }}><span>{t('Name')}</span>
          <input type="text" value={action.name || ''} placeholder={t(ACTION_LABELS[action.type])} onChange={e => set({ name: e.target.value })} /></label>
        <label><span>{t('Type')}</span>
          <select value={action.type} onChange={e => set({ type: e.target.value })}>
            {ACTION_TYPES.map(type => <option key={type} value={type}>{t(ACTION_LABELS[type])}</option>)}
          </select></label>
      </div>
      {(action.type === 'command' || action.type === 'custom') &&
        <label><span>{t('Command')}</span><input className="rule-command" type="text" value={action.command || ''} placeholder="npm run lint" onChange={e => set({ command: e.target.value })} /></label>}
      {action.type === 'script' && <div className="row">
        <label style={{ flex: 1 }}><span>{t('Script path (in the repository)')}</span><input type="text" value={action.path || ''} placeholder="scripts/check.sh" onChange={e => set({ path: e.target.value })} /></label>
        <label style={{ flex: 1 }}><span>{t('Arguments')}</span><input type="text" value={action.args || ''} onChange={e => set({ args: e.target.value })} /></label>
      </div>}
      {action.type === 'validateMessage' && <div className="row">
        <label><span>{t('Rule')}</span>
          <select value={action.rule?.mode || 'conventional'} onChange={e => set({ rule: { ...action.rule, mode: e.target.value } })}>
            <option value="conventional">{t('Conventional Commits')}</option><option value="ticketPrefix">{t('Ticket prefix')}</option><option value="regex">{t('Custom regex')}</option>
          </select></label>
        {action.rule?.mode === 'ticketPrefix' && <label><span>{t('Prefix')}</span><input type="text" placeholder="PROJ" value={action.rule.prefix || ''} onChange={e => set({ rule: { ...action.rule, prefix: e.target.value } })} /></label>}
        {action.rule?.mode === 'regex' && <label style={{ flex: 1 }}><span>{t('Pattern')}</span><input type="text" placeholder="^(feat|fix): " value={action.rule.pattern || ''} onChange={e => set({ rule: { ...action.rule, pattern: e.target.value } })} /></label>}
      </div>}
      {action.type === 'checkBranch' && <label><span>{t('Protected branches (comma separated)')}</span>
        <input type="text" value={(action.block || []).join(', ')} placeholder="main, master, release/*" onChange={e => set({ block: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></label>}
      {action.type === 'checkChangedFiles' && <div className="row">
        <label style={{ flex: 1 }}><span>{t('Must change (glob, comma separated)')}</span><input type="text" value={(action.require || []).join(', ')} onChange={e => set({ require: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></label>
        <label style={{ flex: 1 }}><span>{t('Must not change')}</span><input type="text" value={(action.forbid || []).join(', ')} onChange={e => set({ forbid: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></label>
      </div>}
      {action.type === 'secretScan' && <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>{t('Scans the added lines of the staged changes for common credential formats. Nothing leaves your machine.')}</p>}
      {action.type === 'bumpVersion' && <>
        <div className="row">
          <label style={{ flex: 1 }}><span>{t('Which package.json')}</span>
            <select value={action.target || 'file'} onChange={e => set({ target: e.target.value })}>
              <option value="file">{t('One file')}</option><option value="modules">{t('Each changed module (modules/*/package.json)')}</option>
            </select></label>
          {(action.target || 'file') === 'file' && <label style={{ flex: 1 }}><span>{t('Path')}</span>
            <input type="text" value={action.path ?? 'package.json'} placeholder="package.json" onChange={e => set({ path: e.target.value })} /></label>}
          <label style={{ flex: 1 }}><span>{t('Default')}</span>
            <select value={action.default || 'patch'} onChange={e => set({ default: e.target.value })}>
              <option value="patch">{t('Patch')}</option><option value="minor">{t('Minor')}</option><option value="major">{t('Major')}</option><option value="none">{t('Don’t bump')}</option>
            </select></label>
        </div>
        <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>{t('The commit panel and an agent’s commit proposal show “current → new” and let you pick patch, minor, major or no bump. The version in package.json and the root entries of package-lock.json change with the commit, after every check passed; formatting is kept and npm does not run.')}</p>
      </>}
      <label className="switch"><input type="checkbox" checked={action.continueOnError === true} onChange={e => set({ continueOnError: e.target.checked })} /><span className="track" />{t('Keep going if this fails')}</label>
      <details><summary>{t('Only run this action when…')}</summary>
        <ConditionList conditions={action.conditions || []} phase={phase} onChange={conditions => set({ conditions })} /></details>
    </div>
    <Button icon={Trash2} className="danger quiet" aria-label={t('Remove action')} onClick={onRemove} />
  </li>;
}

/** Edits one pipeline. `validatePipeline` drives the live error list and the save gate. */
export default function PipelineEditor({ pipeline, onSave, onCancel, onDraft }) {
  const [draft, setDraft] = useState(() => normalizePipeline(pipeline));
  // Every change is handed up at once, so leaving the screen keeps it.
  useEffect(() => { onDraft?.(draft); }, [draft, onDraft]);
  const phase = eventPhase(draft.event);
  const { valid, errors } = useMemo(() => validatePipeline(draft), [draft]);
  const patch = p => setDraft(current => ({ ...current, ...p }));
  const setActions = actions => patch({ actions });

  return <div className="pipeline-editor">
    <fieldset><legend>{t('Pipeline')}</legend>
      <div className="row">
        <label style={{ flex: 1 }}><span>{t('Name')}</span>
          <input type="text" value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
        <label><span>{t('Trigger')}</span>
          <select value={draft.event} onChange={e => patch({ event: e.target.value })}>
            {HOOK_EVENTS.map(ev => <option key={ev.hook} value={ev.hook}>{t(ev.label)} ({ev.hook})</option>)}
          </select></label>
      </div>
      <p className="field-hint">{t(HOOK_EVENTS.find(ev => ev.hook === draft.event)?.hint)}</p>
      {phase === 'pre' && <label><span>{t('If a step fails')}</span>
        <select value={draft.onFailure} onChange={e => patch({ onFailure: e.target.value })}>
          <option value="block">{draft.event === 'pre-push' ? t('Block the push') : draft.event === 'commit-msg' ? t('Block the commit') : t('Block the operation')}</option>
          <option value="warn">{t('Warn only, let it continue')}</option>
        </select></label>}
    </fieldset>

    <fieldset><legend>{t('Run only when')}</legend>
      <ConditionList conditions={draft.conditions} phase={phase} onChange={conditions => patch({ conditions })} />
    </fieldset>

    <fieldset><legend>{t`Actions (${draft.actions.length})`}</legend>
      <ol className="rule-list">
        {draft.actions.map((action, index) => <ActionRow key={action.id} action={action} index={index} count={draft.actions.length} phase={phase}
          onChange={next => setActions(draft.actions.map((a, i) => (i === index ? next : a)))}
          onRemove={() => setActions(draft.actions.filter((_, i) => i !== index))}
          onReorder={(from, to) => setActions(move(draft.actions, from, to))} />)}
      </ol>
      <Button icon={Plus} onClick={() => setActions([...draft.actions, { id: makeId('action'), type: 'command', command: '', conditions: [] }])}>{t('Add action')}</Button>
    </fieldset>

    {errors.length > 0 && <ul className="field-error" aria-live="polite">{errors.map((error, i) => <li key={i}>{error}</li>)}</ul>}
    <div className="dialog-actions">
      <Button onClick={onCancel}>{t('Cancel')}</Button>
      <Button className="primary" reason={valid ? undefined : t('Fix the problems above first')} onClick={() => onSave(normalizePipeline(draft))}>{t('Save pipeline')}</Button>
    </div>
  </div>;
}
