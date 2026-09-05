# M2: история и refs — независимая задача для Claude Code

Работаем в одном checkout над 🌱Twig. Codex берёт IPC, виртуализованный React-список,
SVG-раскладку дорожек и подключение данных к окну. Твоя часть — безопасный Git-слой
для настоящей истории и левого сайдбара. Не начинай, пока Codex не сообщит о готовом
коммите M1: вехи идут по одному отдельному коммиту.

## Перед правкой

Прочитай полностью `/CLAUDE.md`, `/AGENTS.md`, `modules/git_desk/PROMPT.md`,
`modules/git_desk/CLAUDE.md`, а также `design/TOKENS.md` и этот файл. Для M2
обязателен `ui-ux-pro-max`: прогони `--design-system` для React и отдельный
поиск рекомендаций для плотных списков/графа; палитру и шрифты не меняй — их
уже выбрал пользователь по логотипу Twig. Сохрани короткие применимые выводы
в отчёте, а не в компонентах.

Рабочее дерево может содержать правки Codex. Не переключай ветку, не выполняй
`reset`, `stash`, `clean`, не меняй существующие файлы и не коммить/пуш.

## Твоя область записи

Только новые файлы внутри `modules/git_desk/`:

- `main/git/history.js`
- `main/git/history-parser.js`
- `main/git/refs.js`
- `scripts/checks/history.mjs`
- `scripts/checks/refs.mjs`
- `scripts/checks/fixtures/history/` — если нужны файлы фикстур
- `tasks/M2-HISTORY-RESULT.md`

Не меняй `exec.js`, `repository.js`, `status-parser.js`, IPC, preload, React,
CSS, package.json, общий test runner, README, CLAUDE.md или PROMPT.md. Codex
подключит API, проверки и документацию после интеграции.

## Контракты

JavaScript ESM, Node 20, без зависимостей. Любой запуск Git — только через
уже существующий `runGit()` из `main/git/exec.js`; прямой `spawn`, shell и
человекочитаемый вывод запрещены.

`history-parser.js` экспортирует чистую функцию:

```js
export function parseHistoryV1(output) {
  // => Commit[]
}
```

```js
{
  oid: '40-or-64-char-hex',
  parents: ['oid'],
  author: { name: 'Name', email: 'mail@example.com', date: 'ISO-8601' },
  committedAt: 'ISO-8601',
  subject: 'first line',
  body: 'full body'
}
```

Формат должен быть NUL-разделённым и фиксированно сгруппированным: путь/имя/
тема/тело могут содержать пробелы, табы, переводы строк, кириллицу и emoji.
Коммитные сообщения в Git не содержат NUL — это единственный допустимый
разделитель. SHA-1 и SHA-256 поддержать. Пустой список — `[]`. Оборванный
output, неверное число полей, невалидные hash/date и нестроковый ввод —
отвергать статической понятной ошибкой без включения входных данных.

`history.js` экспортирует:

```js
export async function loadHistoryPage({ cwd, log, limit = 250, skip = 0 })
// => { commits: Commit[], nextSkip: number | null }
```

Используй только машинный `git log --all --topo-order` с `--max-count` и
`--skip`, ISO-датами и форматом парсера. Валидируй `limit` (1–500) и `skip`
(целое ≥0) до запуска. `nextSkip` равен `null`, когда результат короче limit.
Не добавляй decorate и не парси текст refs из `git log`: refs загружаются
отдельно.

`refs.js` экспортирует:

```js
export function parseRefsV1(output)
export async function loadRefs({ cwd, log })
```

`parseRefsV1` возвращает массив:

```js
{
  name: 'main',                 // без refs/heads/ или refs/remotes/ префикса
  fullName: 'refs/heads/main',
  target: '40-or-64-char-hex',
  type: 'local' | 'remote' | 'tag',
  upstream: 'origin/main' | null,
  ahead: 0,
  behind: 0
}
```

Для refs нужен только `git for-each-ref` с NUL-форматом; не использовать
`git branch`, `git tag` или decorate. Получай refs/heads, refs/remotes и
refs/tags. Отсортируй локальные, затем remote, затем tags; внутри —
`localeCompare` с `en`, чтобы UI был стабилен независимо от файловой системы.
Символическая remote HEAD не должна стать обычной веткой. Upstream/divergence
бери только из машинных atom'ов `for-each-ref`, отсутствие — null/0.

Не делай stash, diff, file list, blame, поиск, checkout или UI: это задачи
других частей M2/M3.

## Самопроверки

Каждый новый parser имеет самостоятельный Node `assert/strict` check без
запуска Git. Покрой:

- merge с несколькими родителями, root commit, SHA-1/SHA-256;
- пустые subject/body, многострочный body, Unicode, tab/newline и похожие на
  поля строки; повреждённый NUL/группу/хэш/дату;
- local/remote/tag, upstream, ahead/behind, отсутствие upstream, remote HEAD,
  сортировку и повреждённые записи refs;
- `loadHistoryPage` через подставной `runGit` невозможно без изменения exec,
  поэтому проверь его аргументы выделением чистого builder-а, если он нужен.
  Не monkey-patch и не исполняй Git напрямую.

Из каталога модуля выполни:

```sh
node scripts/checks/history.mjs
node scripts/checks/refs.mjs
./node_modules/.bin/eslint main/git/history.js main/git/history-parser.js main/git/refs.js scripts/checks/history.mjs scripts/checks/refs.mjs
```

В `tasks/M2-HISTORY-RESULT.md` запиши точные команды, формат, тесты, результаты
прогона `ui-ux-pro-max`, аудит безопасности/производительности и ограничения.
M2 целиком завершённой не объявляй. В финале передай Codex краткий отчёт.
