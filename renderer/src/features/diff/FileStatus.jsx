import { fileStatus } from './file-status.js';
import { t } from '../../i18n/i18n.js';

/** The coloured square with the status letter shown before a changed file's path. */
export default function FileStatus({ status }) {
  const meta = fileStatus(status);
  return <span className={`file-status ${meta.className}`} title={t(meta.label)} aria-label={t(meta.label)}>{meta.letter}</span>;
}
