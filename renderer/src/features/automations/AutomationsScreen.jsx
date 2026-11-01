import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Play, Copy, Trash2, Pencil, Plus, ShieldAlert, FileWarning } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import OperationNote from '../../ui/OperationNote.jsx';
import { HOOK_EVENTS, eventLabel } from './event-labels.js';
import { makeId, normalizeConfig } from './schema.js';
import { TEMPLATES, buildTemplate } from './templates.js';
import PipelineEditor from './PipelineEditor.jsx';
import ExecutionLog from './ExecutionLog.jsx';
import TrustPrompt from './TrustPrompt.jsx';
import { failureText, t, tn } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';

function PipelineCard({ pipeline, busy, onToggle, onEdit, onRun, onDuplicate, onDelete }) {
  return <div className={`pipeline-card ${pipeline.enabled ? '' : 'disabled'}`}>
    <div className="pipeline-head">
      <label className="switch" title={pipeline.enabled ? t('Enabled') : t('Disabled')}>
        <input type="checkbox" checked={pipeline.enabled} aria-label={t`Enable ${pipeline.name}`} onChange={onToggle} /><span className="track" />
      </label>
      <strong>{pipeline.name}</strong>
      {pipeline.source === 'repo' && <span className="pipeline-source">{t('from repository')}</span>}
    </div>
    <div className="pipeline-steps">
      {pipeline.actions.map(action => <code key={action.id}>{action.name || action.type}</code>)}
      {pipeline.onFailure === 'warn' && <span>· {t('warn only')}</span>}
    </div>
    <div className="pipeline-actions">
      <Button icon={Play} reason={busy ? t('A pipeline is running') : undefined} onClick={onRun}>{t('Run now')}</Button>
      <Button icon={Pencil} onClick={onEdit}>{t('Edit')}</Button>
      <Button icon={Copy} aria-label={t`Duplicate ${pipeline.name}`} onClick={onDuplicate} />
      <Button icon={Trash2} className="danger quiet" aria-label={t`Delete ${pipeline.name}`} onClick={onDelete} />
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
    catch { setError(t('Could not read the automation config.')); }
  }, [repository.id]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const save = useCallback(async nextConfig => {
    const clean = normalizeConfig(nextConfig);
    try {
      const saved = await window.twig.saveAutomationConfig(repository.id, clean);
      setData(current => ({ ...current, config: saved }));
      onChanged?.();
    } catch (failure) { setNotice({ text: failureText(failure, t('Could not save.')), failed: true }); }
  }, [repository.id, onChanged]);

  if (error) return <section className="automations-screen"><header className="panel-heading">
    <Button icon={ArrowLeft} onClick={onBack}>{t('Back to history')}</Button></header>
    <p className="empty-inline" role="alert">{error} <button onClick={onConsole}>{t('Show output')}</button></p></section>;
  if (!data) return <div className="loading-shell" aria-label={t('Loading automations')}><div className="skeleton" /></div>;

  const { config } = data;
  const pipelines = config.pipelines;
  const foreignHooks = (data.hooks || []).filter(hook => hook.kind === 'foreign').map(hook => hook.name);
  const untrustedRepo = data.repo?.present && data.repo.pipelines.length > 0
    && data.repo.digest !== data.trust?.digest;

  if (editing) return <section className="automations-screen">
    <header className="panel-heading"><strong>{editing.isNew ? t('New pipeline') : t`Edit ${editing.pipeline.name}`}</strong></header>
    <PipelineEditor pipeline={editing.pipeline}
      onCancel={() => setEditing(null)}
      onSave={next => {
        const exists = pipelines.some(p => p.id === next.id);
        void save({ ...config, pipelines: exists ? pipelines.map(p => (p.id === next.id ? next : p)) : [...pipelines, next] });
        setEditing(null);
      }} />
  </section>;

  const patchPipeline = (id, patch) => save({ ...config, pipelines: pipelines.map(p => (p.id === id ? { ...p, ...patch } : p)) });

  return <section className="automations-screen" aria-label={t('Automations')}>
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>{t('Back to history')}</Button>
      <div className="automations-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pipelines'} onClick={() => setTab('pipelines')}>{t('Pipelines')}</button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>{t('Run history')}</button>
      </div>
    </header>

    <OperationNote note={notice} onConsole={onConsole} onDismiss={() => setNotice('')} />

    {tab === 'history' ? <ExecutionLog repositoryId={repository.id} refreshKey={refreshKey} onConsole={onConsole} /> : <>
      <div className="automations-toolbar">
        <Button icon={Plus} onClick={() => setEditing({ isNew: true, pipeline: { id: makeId('pipeline'), event: 'pre-commit', name: t('New pipeline'), actions: [] } })}>{t('New pipeline')}</Button>
        <label className="switch"><span>{t('from template')}</span>
          <select aria-label={t('Add from template')} value="" onChange={e => { const built = buildTemplate(e.target.value); if (built) setEditing({ isNew: true, pipeline: built }); e.target.value = ''; }}>
            <option value="">{t('choose…')}</option>
            {TEMPLATES.map(template => <option key={template.id} value={template.id}>{t(template.title)}</option>)}
          </select></label>
        <span className="spacer" />
        <label className="switch" title={t('Turn every pipeline in this repository on or off')}>
          <input type="checkbox" checked={config.settings.enabled} onChange={e => save({ ...config, settings: { ...config.settings, enabled: e.target.checked } })} />
          <span className="track" />{config.settings.enabled ? t('Automations on') : t('Automations off')}
        </label>
      </div>

      <details className="automations-group">
        <summary className="runner-summary">{t('Runner settings')}</summary>
        <div className="pipeline-editor" style={{ padding: 'var(--space-2) 0' }}>
          <label><span>{tx('Extra PATH entries (one per line) — directories to find tools like {npm}', { npm: <code>npm</code> })}</span>
            <textarea rows={2} value={config.settings.extraPath.join('\n')}
              onChange={e => save({ ...config, settings: { ...config.settings, extraPath: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } })} /></label>
          <label style={{ maxWidth: 220 }}><span>{t('Step timeout (seconds)')}</span>
            <input type="number" min="1" value={Math.round(config.settings.timeoutMs / 1000)}
              onChange={e => save({ ...config, settings: { ...config.settings, timeoutMs: Math.max(1, Number(e.target.value) || 120) * 1000 } })} /></label>
        </div>
      </details>

      {foreignHooks.length > 0 && <p className="automations-notice">
        <FileWarning aria-hidden="true" />
        <span>{tn(foreignHooks.length,
          'Existing Git hook detected: {hooks}. 🌱 Twig runs its own pipelines alongside them and never edits or removes them.',
          'Existing Git hooks detected: {hooks}. 🌱 Twig runs its own pipelines alongside them and never edits or removes them.',
          { hooks: foreignHooks.map(eventLabel).join(', ') })}</span>
        <Button onClick={onConsole}>{t('Details in console')}</Button>
      </p>}

      {untrustedRepo && <p className="automations-notice trust">
        <ShieldAlert aria-hidden="true" />
        <span>{tn(data.repo.commands.length,
          'This repository contains 🌱 Twig automations. {n} command want permission to run.',
          'This repository contains 🌱 Twig automations. {n} commands want permission to run.')}</span>
        <Button className="primary" onClick={() => setTrustOpen(true)}>{t('Review & Enable')}</Button>
      </p>}

      {pipelines.length === 0 && <p className="automations-empty">{t('No pipelines yet. Start from a template or build one from scratch — 🌱 Twig will run it when the matching Git event happens inside the app.')}</p>}

      {HOOK_EVENTS.filter(ev => pipelines.some(p => p.event === ev.hook)).map(ev => <div className="automations-group" key={ev.hook}>
        <h3>{t(ev.label)} <code>{ev.hook}</code></h3>
        <p className="group-hint">{t(ev.hint)}</p>
        {pipelines.filter(p => p.event === ev.hook).map(pipeline => <PipelineCard key={pipeline.id} pipeline={pipeline} busy={busy}
          onToggle={() => patchPipeline(pipeline.id, { enabled: !pipeline.enabled })}
          onEdit={() => setEditing({ isNew: false, pipeline })}
          onRun={() => onRunEvent(pipeline.event, { operation: 'manual' })}
          onDuplicate={() => save({ ...config, pipelines: [...pipelines, { ...pipeline, id: makeId('pipeline'), name: t`${pipeline.name} copy`, source: 'local' }] })}
          onDelete={() => save({ ...config, pipelines: pipelines.filter(p => p.id !== pipeline.id) })} />)}
      </div>)}
    </>}

    {trustOpen && <TrustPrompt repo={data.repo} onClose={() => setTrustOpen(false)}
      onTrust={async trust => {
        try { const saved = await window.twig.trustAutomations(repository.id, trust); setData(current => ({ ...current, trust: saved })); await load(); }
        catch (failure) { setNotice({ text: failureText(failure, t('Could not enable.')), failed: true }); }
      }} />}
  </section>;
}
