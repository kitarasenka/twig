import { useState } from 'react';
import Dialog from '../../ui/Dialog.jsx';
import Button from '../../ui/Button.jsx';
import { buildDropPlan, endpointLabel } from '../../../../main/git/drop-plan.js';
import { t, tr } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';

export default function DropDialog({ request, title, remoteNames, parents, onRun, onClose }) {
  const needsParent = ['cherry-pick', 'revert'].includes(request.action) && parents.length > 1;
  const [mainline, setMainline] = useState(needsParent ? 1 : null);
  const plan = buildDropPlan({ ...request, mainline, remoteNames });
  return <Dialog title={tr(title)} onClose={onClose}>
    <div className="drop-dialog">
      <p className="drop-pair"><span>{tx('Source {name}', { name: <strong>{endpointLabel(request.source)}</strong> })}</span><span aria-hidden="true">→</span><span>{tx('Target {name}', { name: <strong>{endpointLabel(request.target)}</strong> })}</span></p>
      <p>{plan.consequences ? plan.consequences.map(tr).join(' ') : tr(plan.consequence)}</p>
      {needsParent && <label>{t('Mainline parent')}<select value={mainline} onChange={event => setMainline(Number(event.target.value))}>
        {parents.slice(0, 16).map((oid, index) => <option value={index + 1} key={oid}>{t`Parent ${index + 1}`} · {oid.slice(0, 7)}</option>)}
      </select></label>}
      <p className="muted">{t('Commands to run, in order:')}</p>
      {plan.commands.map((argv, index) => <code className="confirm-command" key={index}>$ git {argv.map(arg => /^[\w./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')}</code>)}
      <div className="dialog-actions"><Button onClick={onClose}>{t('Cancel')}</Button>
        <Button className="primary" onClick={() => onRun({ ...request, mainline })}>{t`Run ${request.action}`}</Button></div>
    </div>
  </Dialog>;
}
