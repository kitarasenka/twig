import { Component, useState } from 'react';
import { AlertTriangle, Copy, RotateCw } from 'lucide-react';
import Button from './Button.jsx';
import Dialog from './Dialog.jsx';
import { t } from '../i18n/i18n.js';
import { errorDetails } from './error-details.js';

function Failure({ error, stack, whole, onRetry, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void window.twig?.copyText?.(errorDetails(error, stack)).then(() => setCopied(true)).catch(() => {});
  return <div className={`error-boundary${whole ? ' whole' : ''}`} role="alert">
    <AlertTriangle aria-hidden="true" />
    <strong>{whole ? t('🌱 Twig could not draw this window.') : t('This part of the window could not be drawn.')}</strong>
    <p>{t('Nothing in your repository changed. Reloading brings back the commit message you were writing.')}</p>
    <div className="error-boundary-actions">
      {onRetry && <Button className="primary" onClick={onRetry}>{t('Try again')}</Button>}
      {onClose && <Button onClick={onClose}>{t('Close')}</Button>}
      <Button className={onRetry ? '' : 'primary'} icon={RotateCw} onClick={() => window.location.reload()}>{t('Reload')}</Button>
      <Button icon={Copy} onClick={copy}>{copied ? t('Copied') : t('Copy details')}</Button>
    </div>
  </div>;
}

/**
 * Keeps one failed render from emptying the whole window. `whole` is the
 * outermost one, which has nothing left to retry; an inner one offers Try
 * again. One that stands for a dialog (it has `onClose`) stays a dialog, over
 * the window instead of in its layout.
 */
export default class ErrorBoundary extends Component {
  state = { error: null, stack: '' };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    console.error(error);
    this.setState({ stack: info?.componentStack || '' });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const { whole = false, onRetry = null, onClose = null } = this.props;
    const retry = () => { this.setState({ error: null, stack: '' }); onRetry?.(); };
    const failure = <Failure error={error} stack={stack} whole={whole} onRetry={whole ? null : retry} onClose={onClose} />;
    return onClose ? <Dialog title={t('Something went wrong')} onClose={onClose}>{failure}</Dialog> : failure;
  }
}
