# M3: разбивка вехи между Claude Code и Codex

Веха по брифу (§10): **рабочее дерево и синхронизация** — staging по файлам и
hunk'ам, Commit, Stash, Pop, Pull, Push с бейджами расхождения. Как в M1 и M2,
работаем в одном checkout, каждая веха — один общий коммит после интеграции.

Разбивку составил Claude Code после коммита M2 (`ef65092`). Правило прежнее:
**мутации, IPC, preload, React, CSS, общий test runner и документация — за
Codex**; чистая логика Git-слоя и её самопроверки — за Claude Code.

## Часть Claude Code (эта задача)

Только новые файлы внутри `modules/git_desk/`:

- `main/git/diff-parser.js`
- `main/git/patch-builder.js`
- `main/git/worktree.js`
- `scripts/checks/diff-parser.mjs`
- `scripts/checks/patch-builder.mjs`
- `tasks/M3-STAGING-RESULT.md`

Не менять `exec.js`, `commit.js`, `history*.js`, `refs.js`, `status-parser.js`,
IPC, preload, React, CSS, `package.json`, `eslint.config.js`, README, CLAUDE.md,
PROMPT.md. Ни одной мутирующей команды Git: staging, commit, stash, pull и push
выполняет Codex.

### Контракты

JavaScript ESM, Node 20, без зависимостей. Любой запуск Git — только через
существующий `runGit()` из `main/git/exec.js`.

`diff-parser.js` — чистая функция, Git не запускает:

```js
export function parseFilePatchV1(output)
// => { binary: boolean, added: boolean, deleted: boolean, hunks: Hunk[] }
```

```js
Hunk = {
  oldStart: number, oldLines: number,
  newStart: number, newLines: number,
  heading: string,            // текст после второго @@, часто имя функции
  lines: HunkLine[]
}
HunkLine = {
  kind: 'context' | 'add' | 'delete',
  text: string,               // без ведущего +/-/пробела
  noNewline: boolean          // за строкой шёл "\ No newline at end of file"
}
```

Патч разбирается **однофайловый**: вызывающий код уже знает путь, потому что
запускает `git diff … -- :(literal)<path>`. Пути из заголовков патча **не
парсить**: строка `diff --git a/sp ace.txt b/sp ace.txt` принципиально
неоднозначна при пробелах в имени. Больше одного заголовка `diff --git` во
входе — ошибка (значит pathspec вызывающего кода зацепил несколько файлов).
Поддержать: обычное изменение, добавление (`--- /dev/null`), удаление
(`+++ /dev/null`), бинарный файл (`Binary files … differ`, без hunk'ов),
пропущенные счётчики в заголовке (`@@ -1 +1 @@` означает 1),
`\ No newline at end of file`, CRLF, Unicode. Пустой вход — ноль hunk'ов.
Оборванный вход, счётчик, не сходящийся с числом строк, неизвестный префикс
строки — отвергать статической ошибкой без включения содержимого файла.

`patch-builder.js` — чистая функция, Git не запускает:

```js
export function buildPatch({ path, hunks, selection, reverse = false })
// => string | null
```

`selection` — `Array<{ index: number, lines: number[] | 'all' }>`: индекс
hunk'а в массиве `hunks` и либо `'all'`, либо индексы выбранных строк внутри
`hunk.lines`. Простые сериализуемые данные, потому что выбор приходит из
renderer через IPC. Ничего не выбрано — вернуть `null`, вызывающий код не
должен запускать Git.

Семантика частичного выбора (как в `git add -p`, это самое тонкое место вехи):
при staging невыбранная строка `add` **выбрасывается**, невыбранная `delete`
**становится контекстом**; при `reverse: true` (unstaging из индекса) зеркально
— невыбранная `delete` выбрасывается, невыбранная `add` становится контекстом.
Счётчики в `@@` пересчитываются под получившийся набор строк, иначе
`git apply` отвергнет патч. Hunk, в котором после фильтрации не осталось
изменений, в патч не попадает.

Заголовок собирать самому из известного `path`, а не из разобранного патча.
После пути в строках `---`/`+++` ставить TAB: проверено, что `git apply`
принимает его и с пробелами в имени, и без них, и это снимает неоднозначность.
`\ No newline at end of file` переносить ровно за той строкой, к которой он
относится, — иначе патч будет молча портить конец файла.

`worktree.js` — только чтение, мутаций нет:

```js
export async function loadWorktree({ cwd, log })
// => { staged: FileChange[], unstaged: FileChange[], untracked: FileChange[] }
export async function loadWorktreeDiff({ cwd, log, path, staged = false })
// => { binary, added, deleted, hunks }
```

Список файлов брать из `git status --porcelain=v2 --branch -z` через уже
существующий `parseStatusV2` (не изобретать второй разбор статуса). Патч —
`git diff [--cached] --no-ext-diff --no-textconv --no-color -- :(literal)<path>`.
Argv-билдеры вынести отдельными экспортами, чтобы самопроверка сверяла
аргументы без запуска Git.

### Самопроверки

`scripts/checks/diff-parser.mjs` — без запуска Git, фикстуры литералами.
Покрыть все перечисленные форматы плюс повреждённый ввод.

`scripts/checks/patch-builder.mjs` — **с настоящим временным репозиторием**
через `runGit`. Это осознанное отступление от правила M1/M2 «в самопроверках
Git не запускать»: единственное настоящее доказательство корректности патча —
что его принимает `git apply --cached`, а не что он «выглядит правильно».
Прецедент в модуле уже есть (`git-exec.mjs`, `commit.mjs`). Проверить, что
после применения частичного патча в индексе оказываются ровно выбранные
строки, и что unstaging возвращает индекс обратно.

## Часть Codex

Мутации, UI и интеграция:

- Мутирующий Git-слой: staging файла (`git add -- :(literal)<path>`),
  unstaging (`git restore --staged -- :(literal)<path>`), применение патча
  hunk'а (`git apply --cached [--reverse]`), `commit`, `stash push/pop/list`,
  `pull`, `push`, `fetch`.
- IPC/preload для рабочего дерева и синхронизации, React-экран изменений
  (staged/unstaged/untracked, чекбоксы по файлу и по строке), окно коммита с
  проверкой сообщения, бейджи расхождения на Pull/Push, отмена сетевых
  операций (§6.6 брифа), подтверждения разрушающего (§6.5).
- Подключение новых проверок в `npm test`, обновление README/CLAUDE.md/
  PROMPT.md, общий коммит вехи и бамп версии.

### Что важно знать Codex до начала

1. **У `runGit()` нет stdin.** `git apply --cached` читает патч со stdin или из
   файла. Значит либо расширить `runGit` необязательным `stdin` (рекомендую:
   патч не попадает на диск), либо писать временный файл патча **вне
   репозитория** (`app.getPath('userData')`/tmpdir, не в рабочее дерево) и
   удалять его в `finally`. Решение за Codex — это его файл.
2. **На unborn-ветке `git restore --staged` падает**: HEAD не существует.
   Для первого коммита unstaging — `git rm --cached -- :(literal)<path>`.
   `parseStatusV2` уже отдаёт `branch.unborn`, признак есть.
3. **Untracked-файл нельзя стейджить по hunk'ам**, пока он не станет
   отслеживаемым: сначала `git add -N -- :(literal)<path>` (это мутация, то
   есть сторона Codex), после чего он появляется в обычном diff как
   добавление. Целиком — обычный `git add`.
4. **`git apply` уважает `core.autocrlf`.** Патчи строятся из вывода того же
   `git diff`, так что содержимое согласовано, но не подменять переводы строк
   при сборке патча и не «нормализовать» их в UI.

### Выводы дизайн-скилла для экрана изменений

Прогон `ui-ux-pro-max` по плотным спискам диффов конкретных рекомендаций не
дал (0 результатов в `ux-guidelines.csv`), применимы общие правила оттуда же:

- **Confirmation Dialogs (severity HIGH)** — подтверждение перед
  разрушающим/необратимым. В M3 это discard изменений и `stash drop`;
  подтверждение должно называть точную команду и что именно потеряется (§6.5).
- **Submit Feedback / Success Feedback** — commit, pull и push не должны
  завершаться молча: состояние «идёт» на кнопке и явный результат.
- `data/react-performance.csv` (строка 26): `content-visibility: auto` с
  `contain-intrinsic-size` для длинных списков — применимо к длинным диффам
  так же, как к списку коммитов в M2.

Палитру и шрифты не менять: они зафиксированы в `design/TOKENS.md` по логотипу.
