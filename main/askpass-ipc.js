import { app, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { createAskpassBroker, createPromptQueue, validAnswer } from './askpass.js';
import { setAskpassBroker } from './git/exec.js';

/**
 * The window side of `main/askpass.js`: main pushes the question on screen
 * (`askpass:prompt`, null takes it away), the window answers with what the
 * person typed or null for Cancel (`askpass:answer`). Nothing is kept.
 * When the broker cannot listen, actions keep the old empty answer.
 */
export async function registerAskpassIpc(getWindow, entryUrl) {
  const queue = createPromptQueue({
    present: view => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      if (view) {
        if (window.isMinimized()) window.restore();
        window.show();
      }
      window.webContents.send('askpass:prompt', view);
    }
  });
  const valid = (event, args, count) => {
    const window = getWindow();
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
  };
  ipcMain.handle('askpass:current', (event, ...args) => {
    if (!valid(event, args, 0)) throw new TypeError('Invalid askpass request');
    return queue.current();
  });
  ipcMain.handle('askpass:answer', (event, ...args) => {
    const [id, answer] = args;
    if (!valid(event, args, 2) || typeof id !== 'string' || id.length > 64 || !(answer === null || validAnswer(answer))) {
      throw new TypeError('Invalid askpass request');
    }
    return queue.answer(id, answer);
  });
  let broker = null;
  try {
    broker = await createAskpassBroker({
      // No window, no one to ask: Git gets no answer, as before.
      ask: request => {
        const window = getWindow();
        if (!window || window.isDestroyed()) return null;
        return queue.ask(request);
      }
    });
    setAskpassBroker(broker);
  } catch (error) {
    console.error('🌱 Twig could not start asking for Git credentials:', error.message);
  }
  app.on('will-quit', () => { queue.cancelAll(); void broker?.stop(); });
  return { cancelAll: () => queue.cancelAll() };
}
