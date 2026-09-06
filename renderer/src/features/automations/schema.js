/**
 * The shape of an automation config and the rules for a valid pipeline. Pure and
 * import-free (loaded by Vite and by Node in `scripts/checks/automation.mjs`);
 * the cryptographic digest of a repository config lives in main, where Node's
 * `crypto` is available.
 */
import { HOOK_EVENTS } from './event-labels.js';
import { parseCommand } from './command-parse.js';

const KNOWN_EVENTS = new Set(HOOK_EVENTS.map(event => event.hook));
export const ACTION_TYPES = ['command', 'script', 'validateMessage', 'checkBranch', 'checkChangedFiles', 'secretScan', 'custom'];
export const CONDITION_TYPES = ['changedFiles', 'branch', 'remote', 'messageContains'];
export const CONFIG_VERSION = 1;
export const DEFAULT_SETTINGS = { enabled: true, extraPath: [], timeoutMs: 120000 };

let counter = 0;
export function makeId(prefix = 'id') {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
const asArray = value => (Array.isArray(value) ? value : []);

function normalizeCondition(raw) {
  const type = CONDITION_TYPES.includes(raw?.type) ? raw.type : 'branch';
  const base = { type, negate: raw?.negate === true };
  if (type === 'changedFiles') return { ...base, glob: asString(raw.glob, '**/*'), mode: raw.mode === 'none' ? 'none' : 'any' };
  if (type === 'branch') return { ...base, pattern: asString(raw.pattern, '*') };
  if (type === 'remote') return { ...base, name: asString(raw.name, 'origin') };
  return { ...base, text: asString(raw.text) };
}

function normalizeAction(raw) {
  const type = ACTION_TYPES.includes(raw?.type) ? raw.type : 'command';
  const action = {
    id: asString(raw?.id) || makeId('action'),
    type,
    name: asString(raw?.name),
    continueOnError: raw?.continueOnError === true,
    conditions: asArray(raw?.conditions).map(normalizeCondition)
  };
  if (type === 'command' || type === 'custom') action.command = asString(raw.command);
  if (type === 'script') { action.path = asString(raw.path); action.args = asString(raw.args); }
  if (type === 'validateMessage') action.rule = raw?.rule && typeof raw.rule === 'object' ? { ...raw.rule } : { mode: 'conventional' };
  if (type === 'checkBranch') action.block = asArray(raw?.block).map(String);
  if (type === 'checkChangedFiles') { action.require = asArray(raw?.require).map(String); action.forbid = asArray(raw?.forbid).map(String); }
  return action;
}

export function normalizePipeline(raw, source = 'local') {
  return {
    id: asString(raw?.id) || makeId('pipeline'),
    event: KNOWN_EVENTS.has(raw?.event) ? raw.event : 'pre-commit',
    name: asString(raw?.name) || 'Untitled pipeline',
    enabled: raw?.enabled !== false,
    source: raw?.source === 'repo' ? 'repo' : source,
    onFailure: raw?.onFailure === 'warn' ? 'warn' : 'block',
    conditions: asArray(raw?.conditions).map(normalizeCondition),
    actions: asArray(raw?.actions).map(normalizeAction)
  };
}

export function normalizeConfig(raw, source = 'local') {
  const settings = raw?.settings && typeof raw.settings === 'object' ? raw.settings : {};
  return {
    version: CONFIG_VERSION,
    pipelines: asArray(raw?.pipelines).map(pipeline => normalizePipeline(pipeline, source)),
    settings: {
      enabled: settings.enabled !== false,
      extraPath: asArray(settings.extraPath).map(String).filter(Boolean).slice(0, 32),
      timeoutMs: Number.isInteger(settings.timeoutMs) ? Math.min(Math.max(settings.timeoutMs, 1000), 3_600_000) : DEFAULT_SETTINGS.timeoutMs
    }
  };
}

/** One line per problem; an empty array means the pipeline is runnable. */
export function validatePipeline(pipeline) {
  const errors = [];
  const p = normalizePipeline(pipeline, pipeline?.source);
  if (!KNOWN_EVENTS.has(p.event)) errors.push(`Unknown event "${p.event}".`);
  if (typeof pipeline?.name !== 'string' || !pipeline.name.trim()) errors.push('The pipeline needs a name.');
  if (p.actions.length === 0) errors.push('Add at least one action.');
  p.actions.forEach((action, index) => {
    const where = `Action ${index + 1}`;
    if (action.type === 'command' || action.type === 'custom') {
      if (!action.command.trim()) errors.push(`${where}: enter a command.`);
      else try { parseCommand(action.command); } catch (error) { errors.push(`${where}: ${error.message}`); }
    }
    if (action.type === 'script') {
      if (!action.path.trim()) errors.push(`${where}: choose a script path.`);
      else if (action.path.includes('..') || action.path.startsWith('/') || action.path.startsWith('~') || /\0/.test(action.path)) {
        errors.push(`${where}: the script path must be inside the repository.`);
      }
      if (action.args) try { parseCommand(`x ${action.args}`); } catch (error) { errors.push(`${where}: ${error.message}`); }
    }
    if (action.type === 'checkBranch' && action.block.length === 0) errors.push(`${where}: list at least one protected branch.`);
    if (action.type === 'validateMessage' && !['conventional', 'regex', 'ticketPrefix'].includes(action.rule.mode)) {
      errors.push(`${where}: choose a message rule.`);
    }
  });
  return { valid: errors.length === 0, errors };
}

/** Every distinct command string a config would run, for the trust prompt. */
export function commandsIn(config) {
  const commands = [];
  for (const pipeline of normalizeConfig(config).pipelines) {
    for (const action of pipeline.actions) {
      if (action.type === 'command' || action.type === 'custom') commands.push(action.command.trim());
      if (action.type === 'script') commands.push(`${action.path} ${action.args}`.trim());
    }
  }
  return [...new Set(commands.filter(Boolean))];
}
