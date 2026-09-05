# M4 — операции над историей

Веха по `PROMPT.md` §10: контекстное меню коммита (§8.2), merge, cherry-pick,
revert, reset, интерактивный rebase (§8.3), редактор конфликтов (§8.5), баннер
прерванной операции. Разрушающее — только через диалог по §6.5.

Задание не приходило извне: план составлен по брифу перед началом работы.

## Границы

Единственный запуск Git — `main/git/exec.js`. Рендерер не получает ни fs, ни
произвольных каналов. Никаких новых зависимостей. Цвета только из
`design/TOKENS.md`.

## Git-слой (main/git/)

| Файл | Содержимое |
| --- | --- |
| `refs-ops.js` | `validateRefName` по git-check-ref-format, создание ветки/тега, checkout, удаление ветки |
| `history-ops.js` | merge (`--no-ff`), cherry-pick, revert (`--mainline`), reset (soft/mixed/hard), continue/skip/abort |
| `rebase.js` | todo-план, карта сообщений, окружение редакторов, старт rebase |
| `sequence-editor.cjs` | `GIT_SEQUENCE_EDITOR`: подставляет утверждённый план |
| `message-editor.cjs` | `GIT_EDITOR`: сообщение по oid текущего шага |
| `operation-state.js` | что за операция идёт: маркеры под git-каталогом + список конфликтов |
| `conflicts.js` | три стадии индекса, запись решения, `--ours/--theirs`, `git add` |

`exec.js` получает необязательный `env` — без него интерактивный rebase
невозможен, а глобально выставлять `GIT_SEQUENCE_EDITOR` нельзя.

## Рендерер

`ui/Menu.jsx` (роли menu/menuitem, стрелки, Escape, Shift+F10),
`features/ops/` (меню как данные, диалоги подтверждения и имени, баннер),
`features/rebase/RebaseDialog.jsx` (перетаскивание **и** кнопки/Alt+стрелки),
`features/conflicts/` (парсер маркеров + трёхсторонний редактор со своим
undo/redo), `ui/ops.css`.

## Проверки

- `checks/history-ops.mjs` — argv, валидация имён, план rebase, применимость
  пунктов меню. Без запуска Git.
- `checks/conflict-parser.mjs` — разбор маркеров обоих стилей, замена региона.
- `checks/history-ops-live.mjs` — **настоящий Git**: конфликтующий merge,
  разрешение, continue, abort, cherry-pick, revert, `reset --hard`,
  интерактивный rebase с перестановкой/reword/squash/drop, конфликт в rebase,
  бинарный файл.
- `scripts/ops-smoke.mjs` — настоящий Electron: меню мышью и с клавиатуры,
  конфликт, редактор, баннер, подтверждение, интерактивный rebase.

## Порядок

1. `exec.js` + Git-слой. 2. IPC и мост. 3. Экраны. 4. Проверки. 5. Документация
и версия.
