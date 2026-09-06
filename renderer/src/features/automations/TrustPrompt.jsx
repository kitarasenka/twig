import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { eventLabel } from './event-labels.js';
import { commandsIn } from './schema.js';

/**
 * Repository-provided automations (`.twig/hooks.json`) never run until the user
 * reviews the exact commands and enables them here. Nothing is pre-checked.
 */
export default function TrustPrompt({ repo, onTrust, onClose }) {
  const pipelines = repo.pipelines || [];
  const [enabledIds, setEnabledIds] = useState(() => new Set());

  const enabledPipelines = pipelines.filter(p => enabledIds.has(p.id));
  const approvedCommands = commandsIn({ pipelines: enabledPipelines });

  const toggle = id => setEnabledIds(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return <Dialog title="Repository automations" wide onClose={onClose}>
    <div className="pipeline-editor" style={{ padding: 0, gap: 'var(--space-3)' }}>
      <p className="confirm-consequence"><ShieldAlert aria-hidden="true" />
        This repository ships {pipelines.length} automation pipeline{pipelines.length === 1 ? '' : 's'}. They can run local
        commands on your machine. Nothing runs until you enable it here, and any edit to the file turns them all off again.</p>
      {repo.error && <p className="field-error">{repo.error}</p>}
      <div className="rule-list">
        {pipelines.map(pipeline => <div key={pipeline.id} className="rule-row" style={{ alignItems: 'flex-start' }}>
          <label className="switch">
            <input type="checkbox" checked={enabledIds.has(pipeline.id)} onChange={() => toggle(pipeline.id)} />
            <span className="track" />
          </label>
          <div className="rule-body" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-1)' }}>
            <strong>{pipeline.name} <code>{eventLabel(pipeline.event)}</code></strong>
            {pipeline.actions.map(action => <div key={action.id} style={{ fontSize: 'var(--text-xs)' }}>
              <span className="muted">{action.name || action.type}: </span>
              <code>{action.type === 'command' || action.type === 'custom' ? action.command
                : action.type === 'script' ? `${action.path} ${action.args}`.trim()
                  : action.type === 'validateMessage' ? `message rule (${action.rule?.mode})`
                    : action.type === 'checkBranch' ? `block ${action.block?.join(', ')}`
                      : action.type}</code>
            </div>)}
          </div>
        </div>)}
      </div>
      <div className="dialog-actions">
        <span className="muted" role="status">{approvedCommands.length} command{approvedCommands.length === 1 ? '' : 's'} will be permitted</span>
        <Button onClick={onClose}>Not now</Button>
        <Button className="primary" reason={enabledIds.size === 0 ? 'Enable at least one pipeline first' : undefined}
          onClick={() => { onClose(); onTrust({ enabledRepoPipelineIds: [...enabledIds], approvedCommands }); }}>
          Enable {enabledIds.size || ''} pipeline{enabledIds.size === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  </Dialog>;
}
