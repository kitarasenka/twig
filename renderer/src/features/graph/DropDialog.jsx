import { useState } from 'react';
import Dialog from '../../ui/Dialog.jsx';
import Button from '../../ui/Button.jsx';
import { buildDropPlan, endpointLabel } from '../../../../main/git/drop-plan.js';

export default function DropDialog({ request, title, remoteNames, parents, onRun, onClose }) {
  const needsParent = ['cherry-pick', 'revert'].includes(request.action) && parents.length > 1;
  const [mainline, setMainline] = useState(needsParent ? 1 : null);
  const plan = buildDropPlan({ ...request, mainline, remoteNames });
  return <Dialog title={title} onClose={onClose}>
    <div className="drop-dialog">
      <p className="drop-pair"><span>Source <strong>{endpointLabel(request.source)}</strong></span><span aria-hidden="true">→</span><span>Target <strong>{endpointLabel(request.target)}</strong></span></p>
      <p>{plan.consequence}</p>
      {needsParent && <label>Mainline parent<select value={mainline} onChange={event => setMainline(Number(event.target.value))}>
        {parents.slice(0, 16).map((oid, index) => <option value={index + 1} key={oid}>Parent {index + 1} · {oid.slice(0, 7)}</option>)}
      </select></label>}
      <p className="muted">Commands to run, in order:</p>
      {plan.commands.map((argv, index) => <code className="confirm-command" key={index}>$ git {argv.map(arg => /^[\w./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')}</code>)}
      <div className="dialog-actions"><Button onClick={onClose}>Cancel</Button>
        <Button className="primary" onClick={() => onRun({ ...request, mainline })}>Run {request.action}</Button></div>
    </div>
  </Dialog>;
}
