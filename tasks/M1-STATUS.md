# M1: независимая задача для Claude Code

Работаем над 🌱Twig в общем checkout с Codex. После завершения ренейма возьми
этот кусок M1: чистый парсер `git status --porcelain=v2 --branch -z` и самопроверки.
Codex берёт исполнитель Git, журнал, IPC/preload, открытие репозитория и консоль.

## Перед правкой

Прочитай корневые `CLAUDE.md`, `AGENTS.md`, модульные `PROMPT.md` и `CLAUDE.md`
целиком. Проверь текущий diff: незакоммиченные ренейм, палитра и иконки — работа
другого участника, сохраняй их. Не переключай ветку, не делай reset/stash/clean.

## Твоя область записи

Только новые файлы:

- `main/git/status-parser.js`
- `scripts/checks/status-parser.mjs`
- `scripts/checks/fixtures/status/` — если нужны отдельные фикстуры.
- `tasks/M1-STATUS-RESULT.md` — отчёт для интеграции.

Все пути относительно `modules/git_desk/`. Не меняй `exec.js`, package.json,
lock-файл, общий test runner, IPC, preload, renderer, темы, README, CLAUDE.md
или PROMPT.md. Codex подключит проверки к npm test и обновит общую документацию.
Самостоятельный коммит/бамп/пуш не делай: это часть единого коммита M1 после
интеграции и выбора пользователем уровня версии.

## Контракт

JavaScript ESM, Node 20, без зависимостей, Electron, fs, spawn и запуска Git.
Единственный публичный экспорт:

```js
export function parseStatusV2(output) { /* ... */ }
```

`output` — строка UTF-8 с NUL-разделителями (не строки с экранированными путями).
Возвращаемое значение:

```js
{
  branch: {
    oid: null,       // sha или null для (initial)/отсутствующего заголовка
    name: null,      // имя или null для (detached)/отсутствующего заголовка
    detached: false,
    unborn: false,
    upstream: null,
    ahead: 0,
    behind: 0
  },
  entries: [{
    kind: 'ordinary', // ordinary | renamed | unmerged | untracked | ignored
    path: 'file.txt', // путь назначения для record type 2
    originalPath: null, // исходный путь для type 2, иначе null
    indexStatus: 'M', // X, '.' для untracked/ignored
    worktreeStatus: '.', // Y, '.' для untracked/ignored
    submodule: null, // null для N..., иначе объект ниже
    score: null // null или { kind: 'rename' | 'copy', value: 0..100 }
  }]
}
```

Для submodule: `{ commitChanged: boolean, trackedChanges: boolean,
untrackedChanges: boolean }`. Не своди submodule к обычному изменённому файлу.
Счётчики файлов/staged/unstaged — ответственность вызывающего кода, их здесь нет.

## Требования

- Поддержать заголовки branch.oid/head/upstream/ab и записи 1, 2, u, ?, !.
- Для type 2 после первого NUL отдельно идёт originalPath: не путать его с новой
  записью. Для путей сохранять пробелы, табы, переводы строк, обратные слэши,
  кириллицу, emoji и ведущий дефис без trim/нормализации/разбиения по whitespace.
- Поддержать SHA-1 и SHA-256; detached HEAD, unborn branch, отсутствие upstream,
  пустой вывод, конфликты всех XY-вариантов и dirty submodules.
- Неизвестные заголовки пропускать для совместимости Git. Неизвестный тип записи,
  некорректный известный заголовок/record, оборванную запись или отсутствие
  originalPath у type 2 отвергать понятной ошибкой. Сообщение ошибки не должно
  содержать исходный вывод, имена файлов или другую приватную информацию.
- Линейный проход по входу; никаких shell-команд, парсинга human-readable status,
  новых зависимостей и UI. JSDoc для формы результата и неочевидного разбора.
- Сверить формат с официальной документацией Git, особенно порядок rename-путей
  при -z и заголовки. Ссылку и принятые решения записать в отчёт.

## Проверки и сдача

`scripts/checks/status-parser.mjs` — самостоятельный скрипт с node:assert/strict,
без Jest. Фикстуры должны покрывать перечисленные случаи, в том числе имена,
похожие на заголовки/записи, и повреждённый ввод. В тестах не запускай Git:
интеграционные проверки с настоящим Git сделает Codex через единый исполнитель.

Из каталога модуля выполни:

```sh
node scripts/checks/status-parser.mjs
./node_modules/.bin/eslint main/git/status-parser.js scripts/checks/status-parser.mjs
```

В `tasks/M1-STATUS-RESULT.md` укажи файлы, итоговый контракт, результаты проверок,
ограничения, аудит безопасности и производительности. Если контракт оказался
недостаточен, опиши предложение в отчёте; не меняй его молча. M1 целиком завершённой
не объявляй. В финале дай короткий текст для передачи Codex.
