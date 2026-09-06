import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { isTrustedPage } from './security.js';
import { isKnownEvent } from '../renderer/src/features/automations/event-labels.js';
import { commandsIn, validatePipeline } from '../renderer/src/features/automations/schema.js';
import { triggerPipeline } from './automation/engine.js';
import { discoverHooks, readRepoConfig } from './automation/discovery.js';

/**
 * The automation subsystem. It runs user-configured local processes, so every
 * channel validates its sender, resolves the repository only from the saved
 * list, and rejects a malformed request instead of answering with a soft
 * failure — the same contract as every other IPC module here.
 *
 * `.twig/hooks.json` is treated as untrusted data: it is read and described but
 * never executed until `automation:trust` records an explicit approval.
 */
export function registerAutomationsIpc(getWindow, entryUrl, { repositories, journal, automations, runs, loginPath = null }) {
  const running = new Map();

  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new TypeError('Invalid automation request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo || !repo.available) throw new TypeError('Repository is unavailable');
      return read({ repo, window }, ...args.slice(1));
    });
  }

  handler('automation:config', 1, async ({ repo }) => {
    const [discovery, repoConfig] = await Promise.all([
      discoverHooks({ cwd: repo.path, log: journal }),
      readRepoConfig(repo.path)
    ]);
    return {
      config: automations.config(repo.id),
      trust: automations.trust(repo.id),
      hooks: discovery.hooks,
      repo: {
        present: repoConfig.present, error: repoConfig.error, digest: repoConfig.digest,
        pipelines: repoConfig.config?.pipelines || [],
        commands: repoConfig.config ? commandsIn(repoConfig.config) : []
      }
    };
  });

  handler('automation:save', 2, ({ repo }, config) => {
    if (!config || typeof config !== 'object') throw new TypeError('Invalid automation config');
    for (const pipeline of config.pipelines || []) {
      const { valid, errors } = validatePipeline(pipeline);
      if (!valid) throw new TypeError(errors[0] || 'Invalid pipeline');
    }
    return automations.saveConfig(repo.id, config).then(saved => saved.config);
  });

  handler('automation:trust', 2, async ({ repo }, trust) => {
    if (!trust || typeof trust !== 'object') throw new TypeError('Invalid trust request');
    const repoConfig = await readRepoConfig(repo.path);
    if (!repoConfig.config) throw new TypeError('This repository has no automations to enable.');
    const commands = new Set(commandsIn(repoConfig.config));
    const approvedCommands = (Array.isArray(trust.approvedCommands) ? trust.approvedCommands : []).map(String).filter(command => commands.has(command));
    const ids = new Set(repoConfig.config.pipelines.map(pipeline => pipeline.id));
    const enabledRepoPipelineIds = (Array.isArray(trust.enabledRepoPipelineIds) ? trust.enabledRepoPipelineIds : []).map(String).filter(id => ids.has(id));
    return automations.setTrust(repo.id, { digest: repoConfig.digest, approvedCommands, enabledRepoPipelineIds }).then(saved => saved.trust);
  });

  handler('automation:runs', 1, ({ repo }) => runs.list(repo.id));
  handler('automation:run-detail', 2, ({ repo }, executionId) => {
    if (typeof executionId !== 'string') throw new TypeError('Invalid execution id');
    return runs.get(repo.id, executionId);
  });

  handler('automation:cancel', 1, ({ repo }) => { running.get(repo.id)?.abort(); return true; });

  /**
   * Runs the pipelines for one event. `options.bypass` records a bypassed run
   * without executing anything, so the log still shows that checks were skipped.
   */
  handler('automation:run', 3, async ({ repo, window }, eventName, options) => {
    if (!isKnownEvent(eventName)) throw new TypeError('Unknown hook event');
    if (options !== null && typeof options !== 'object') throw new TypeError('Invalid run options');
    const message = options?.message;
    const remote = options?.remote;
    if (message != null && (typeof message !== 'string' || message.length > 1_000_000)) throw new TypeError('Invalid commit message');
    if (remote != null && (typeof remote !== 'string' || remote.length > 255)) throw new TypeError('Invalid remote');

    if (options?.bypass === true) {
      const execution = {
        id: randomUUID(), event: eventName, operation: eventName,
        startedAt: new Date().toISOString(), ms: 0, result: 'bypassed', bypassed: true,
        steps: [{ name: 'Bypassed', type: 'bypass', status: 'skipped', detail: 'Checks were skipped for this operation.', command: null }]
      };
      await runs.append(repo.id, execution);
      return { ok: true, blocked: false, executionId: execution.id, steps: execution.steps, ran: false, bypassed: true };
    }

    running.get(repo.id)?.abort();
    const controller = new AbortController();
    running.set(repo.id, controller);
    try {
      return await triggerPipeline({
        event: eventName, repoId: repo.id, cwd: repo.path, log: journal, automations, runs, loginPath,
        message: message ?? null, remote: remote ?? null, operation: options?.operation || eventName,
        signal: controller.signal,
        onStep: step => { if (!window.isDestroyed()) window.webContents.send('automation:step', step); }
      });
    } finally {
      if (running.get(repo.id) === controller) running.delete(repo.id);
    }
  });
}
