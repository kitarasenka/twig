import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Play, Copy, Trash2, Pencil, Plus, ShieldAlert, FileWarning } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { HOOK_EVENTS, eventLabel } from './event-labels.js';
import { makeId, normalizeConfig } from './schema.js';
import { TEMPLATES, buildTemplate } from './templates.js';
import PipelineEditor from './PipelineEditor.jsx';
import ExecutionLog from './ExecutionLog.jsx';
import TrustPrompt from './TrustPrompt.jsx';

function PipelineCard({ pipeline, busy, onToggle, onEdit, onRun, onDuplicate, onDelete }) {
  return <div className={`pipeline-card ${pipeline.enabled ? '' : 'disabled'}`}>
    <div className="pipeline-head">
      <label className="switch" title={pipeline.enabled ? 'Enabled' : 'Disabled'}>
        <input type="checkbox" checked={pipeline.enabled} aria-label={`Enable ${pipeline.name}`} onChange={onToggle} /><span className="track" />
      </label>
      <strong>{pipeline.name}</strong>
      {pipeline.source === 'repo' && <span className="pipeline-source">from repository</span>}
    </div>
    <div className="pipeline-steps">
      {pipeline.actions.map(action => <code key={action.id}>{action.name || action.type}</code>)}
      {pipeline.onFailure === 'warn' && <span>· warn only</span>}
    </div>
    <div className="pipeline-actions">
      <Button icon={Play} reason={busy ? 'A pipeline is running' : undefined} onClick={onRun}>Run now</Button>
      <Button icon={Pencil} onClick={onEdit}>Edit</Button>
      <Button icon={Copy} aria-label={`Duplicate ${pipeline.name}`} onClick={onDuplicate} />
      <Button icon={Trash2} className="danger" aria-label={`Delete ${pipeline.name}`} onClick={onDelete} />
    </div>
  </div>;
}

/**
 * The repository's automation pipelines: a list grouped by Git event, an inline
 * editor, the run history, and the notices that keep an existing hook or an
 * untrusted repository config from being a surprise.
 */
export default function AutomationsScreen({ repository, refreshKey, busy, onBack, onConsole, onRunEvent, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('pipelines');
  const [editing, setEditing] = useState(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try { setData(await window.twig.getAutomationConfig(repository.id)); setError(''); }
    catch { setError('Could not read the automation config.'); }
  }, [repository.id]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const save = useCallback(async nextConfig => {
    const clean = normalizeConfig(nextConfig);
    try {
      const saved = await window.twig.saveAutomationConfig(repository.id, clean);
      setData(current => ({ ...current, config: saved }));
      onChanged?.();
    } catch (failure) { setNotice(failure.message || 'Could not save.'); onConsole(); }
  }, [repository.id, onChanged, onConsole]);

  if (error) return <section className="automations-screen"><header className="panel-heading">
    <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button></header>
    <p className="empty-inline" role="alert">{error} <button onClick={onConsole}>Show output</button></p></section>;
  if (!data) return <div className="loading-shell" aria-label="Loading automations"><div className="skeleton" /></div>;

  const { config } = data;
  const pipelines = config.pipelines;
  const foreignHooks = (data.hooks || []).filter(hook => hook.kind === 'foreign').map(hook => hook.name);
  const untrustedRepo = data.repo?.present && data.repo.pipelines.length > 0
    && data.repo.digest !== data.trust?.digest;

  if (editing) return <section className="automations-screen">
    <header className="panel-heading"><strong>{editing.isNew ? 'New pipeline' : `Edit ${editing.pipeline.name}`}</strong></header>
    <PipelineEditor pipeline={editing.pipeline}
      onCancel={() => setEditing(null)}
      onSave={next => {
        const exists = pipelines.some(p => p.id === next.id);
        void save({ ...config, pipelines: exists ? pipelines.map(p => (p.id === next.id ? next : p)) : [...pipelines, next] });
        setEditing(null);
      }} />
  </section>;

  const patchPipeline = (id, patch) => save({ ...config, pipelines: pipelines.map(p => (p.id === id ? { ...p, ...patch } : p)) });

  return <section className="automations-screen" aria-label="Automations">
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button>
      <div className="automations-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pipelines'} onClick={() => setTab('pipelines')}>Pipelines</button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>Run history</button>
      </div>
    </header>

    {notice && <p className="operation-note" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss">×</button></p>}

    {tab === 'history' ? <ExecutionLog repositoryId={repository.id} refreshKey={refreshKey} onConsole={onConsole} /> : <>
      <div className="automations-toolbar">
        <Button icon={Plus} onClick={() => setEditing({ isNew: true, pipeline: { id: makeId('pipeline'), event: 'pre-commit', name: 'New pipeline', actions: [] } })}>New pipeline</Button>
        <label className="switch"><span>from template</span>
          <select aria-label="Add from template" value="" onChange={e => { const built = buildTemplate(e.target.value); if (built) setEditing({ isNew: true, pipeline: built }); e.target.value = ''; }}>
            <option value="">choose…</option>
            {TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.title}</option>)}
          </select></label>
        <span className="spacer" />
        <label className="switch" title="Turn every pipeline in this repository on or off">
          <input type="checkbox" checked={config.settings.enabled} onChange={e => save({ ...config, settings: { ...config.settings, enabled: e.target.checked } })} />
          <span className="track" />Automations {config.settings.enabled ? 'on' : 'off'}
        </label>
      </div>

      <details className="automations-group">
        <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>Runner settings</summary>
        <div className="pipeline-editor" style={{ padding: 'var(--space-2) 0' }}>
          <label><span>Extra PATH entries (one per line) — directories to find tools like <code>npm</code></span>
            <textarea rows={2} value={config.settings.extraPath.join('\n')}
              onChange={e => save({ ...config, settings: { ...config.settings, extraPath: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } })} /></label>
          <label style={{ maxWidth: 220 }}><span>Step timeout (seconds)</span>
            <input type="number" min="1" value={Math.round(config.settings.timeoutMs / 1000)}
              onChange={e => save({ ...config, settings: { ...config.settings, timeoutMs: Math.max(1, Number(e.target.value) || 120) * 1000 } })} /></label>
        </div>
      </details>

      {foreignHooks.length > 0 && <p className="automations-notice">
        <FileWarning aria-hidden="true" />
        <span>Existing Git {foreignHooks.length === 1 ? 'hook' : 'hooks'} detected: {foreignHooks.map(eventLabel).join(', ')}. 🌱 Twig runs its own pipelines alongside them and never edits or removes them.</span>
        <Button onClick={onConsole}>Details in console</Button>
      </p>}

      {untrustedRepo && <p className="automations-notice trust">
        <ShieldAlert aria-hidden="true" />
        <span>This repository contains 🌱 Twig automations. {data.repo.commands.length} command{data.repo.commands.length === 1 ? '' : 's'} want permission to run.</span>
        <Button className="primary" onClick={() => setTrustOpen(true)}>Review &amp; Enable</Button>
      </p>}

      {pipelines.length === 0 && <p className="automations-empty">No pipelines yet. Start from a template or build one from scratch — 🌱 Twig will run it when the matching Git event happens inside the app.</p>}

      {HOOK_EVENTS.filter(ev => pipelines.some(p => p.event === ev.hook)).map(ev => <div className="automations-group" key={ev.hook}>
        <h3>{ev.label} <code>{ev.hook}</code></h3>
        <p className="group-hint">{ev.hint}</p>
        {pipelines.filter(p => p.event === ev.hook).map(pipeline => <PipelineCard key={pipeline.id} pipeline={pipeline} busy={busy}
          onToggle={() => patchPipeline(pipeline.id, { enabled: !pipeline.enabled })}
          onEdit={() => setEditing({ isNew: false, pipeline })}
          onRun={() => onRunEvent(pipeline.event, { operation: 'manual' })}
          onDuplicate={() => save({ ...config, pipelines: [...pipelines, { ...pipeline, id: makeId('pipeline'), name: `${pipeline.name} copy`, source: 'local' }] })}
          onDelete={() => save({ ...config, pipelines: pipelines.filter(p => p.id !== pipeline.id) })} />)}
      </div>)}
    </>}

    {trustOpen && <TrustPrompt repo={data.repo} onClose={() => setTrustOpen(false)}
      onTrust={async trust => {
        try { const saved = await window.twig.trustAutomations(repository.id, trust); setData(current => ({ ...current, trust: saved })); await load(); }
        catch (failure) { setNotice(failure.message || 'Could not enable.'); onConsole(); }
      }} />}
  </section>;
}
