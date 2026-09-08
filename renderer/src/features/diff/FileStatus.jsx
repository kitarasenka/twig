import { fileStatus } from './file-status.js';

/** The coloured square with the status letter shown before a changed file's path. */
export default function FileStatus({ status }) {
  const meta = fileStatus(status);
  return <span className={`file-status ${meta.className}`} title={meta.label} aria-label={meta.label}>{meta.letter}</span>;
}
