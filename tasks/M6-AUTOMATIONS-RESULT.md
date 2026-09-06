# M6 шаг 1 — результат

Проверено на macOS arm64, Node 20.20.0, git 2.54.0.

## Что сделано

**Экран Automations** (пункт левого сайдбара репозитория). Вкладки
Pipelines / Run history. Карточка пайплайна: переключатель вкл/выкл, Run now,
Edit, Duplicate, Delete; группировка по событию с человеческим названием и
сырым именем хука рядом. «New pipeline» с нуля или из пяти шаблонов
(JS/TS, Conventional Commits, Protect main, Before push, Secret guard) —
шаблон открывается в редакторе, а не применяется вслепую.

**Редактор пайплайна** — имя, триггер (10 событий), поведение при ошибке
(block/warn для pre-*), блок условий и список действий с переупорядочиванием
(drag + Move up/down + Alt+стрелки, как `RebaseDialog`). Живой список ошибок
из `validatePipeline`, кнопка Save заблокирована при ошибках.

**Условия** (визуальные, без выражений): изменённые файлы по glob (any/none),
ветка по glob, remote назначения, подстрока в сообщении; у каждого «not».
Есть у пайплайна целиком и у отдельного действия.

**Действия**: Run command / Custom (только имя программы, argv, без shell),
Run script (путь внутри рабочего дерева), Validate commit message
(conventional / ticket-prefix / regex), Protect branches, Check changed files,
Scan for secrets. У каждого — имя, «keep going if this fails», свои условия.

**Оверлей выполнения** — при git-операции внутри Twig: шаги с иконкой+словом
(Check/X/Loader/Minus, не только цвет), тайминги, «N passed · M failed»,
«Commit/Push blocked», раскрытие stdout/stderr по шагу. Кнопки Fix and retry /
Run again / Bypass once. Проход (900 мс) и warn-only (1600 мс) закрываются
сами; block ждёт кнопку.

**Логи** — прошлые прогоны репозитория новыми сверху, раскрытие в тот же
компонент шагов. `automation-runs.json`, до 100, вывод ≤ 100 КБ/шаг, в
репозиторий не коммитится.

**Модель доверия** — `.twig/hooks.json` из репозитория показывается, но не
исполняется до `TrustPrompt` («This repository contains Twig automations.
N commands want permission to run. Review & Enable»), где каждая команда с
чекбоксом, ничего не отмечено заранее. Trust привязан к sha256 байтов файла;
правка → всё выключено. На clone/open ничего не запускается.

**Раннер** — `main/automation/exec.js`, `spawn(exe, argv, {shell:false})`,
журнал с `executable`, таймаут на шаг (120 с, настраивается), отмена по
`AbortController`. PATH логин-шелла резолвится один раз на старте фиксированной
командой (GUI-Electron на macOS наследует урезанный PATH), плюс extraPath.

**Точки перехвата**: commit (pre-commit → commit-msg → post-commit) в
`WorktreeScreen`; merge / rebase / reword / checkout в меню коммита и диалоге
rebase через `performGated`; push в `App` со своим оверлеем.

## Что выяснилось (проверено вживую)

1. `spawn` с несуществующим бинарём **не бросает** — эмитит `error`, а `close`
   приходит с кодом `-2` (libuv ENOENT). Раннер отдаёт ненулевой код и
   `Command not found on PATH.` в детали.
2. `git rev-parse --abbrev-ref HEAD` в detached-состоянии печатает `HEAD` —
   трактуется как «ветки нет», условие `branch` и `checkBranch` тогда не
   срабатывают, а не сравниваются со строкой `HEAD`.
3. Родительский процесс должен убиваться группой (`process.kill(-pid)`), иначе
   `npm` оставляет детей после таймаута — тот же приём, что в `main/ssh/exec.js`.

## Аудит безопасности

- `shell: true` не встречается нигде. `command-parse.js` отвергает
  `& | ; < > $ \`` и переносы строк, несбалансированные кавычки, лишний
  бэкслеш; парен оставлен (без shell это обычный символ). Цепочку выражают
  несколькими действиями.
- Первый токен `command`-действия обязан быть именем программы
  (`isBareExecutable`); путь — только через `script`, с `path.resolve` +
  `path.relative` внутри рабочего дерева.
- `.twig/hooks.json` парсится и показывается, но `selectPipelines` пускает его
  пайплайн только если `digest` совпал с сохранённым **и** каждая его команда
  в `approvedCommands`. `automation:trust` пересекает вход с тем, что реально
  в файле, — одобрить несуществующую команду нельзя.
- Все каналы проверяют sender/frame/число аргументов и резолвят репозиторий
  только по сохранённому списку; `TypeError`/`Error` из валидаторов
  **отклоняют** запрос. `automation:run` с `bypass:true` ничего не исполняет.
- В журнал команд идёт argv и `executable`; stdin у шага нет. Сетевых вызовов
  в коде подсистемы нет; `git` по-прежнему только через `main/git/exec.js`.

## Аудит производительности

Новых таймеров опроса и подписок нет (оверлей чистит свой `setTimeout`).
Движок читает git точечно: одна ветка + один `diff --name-only`, а
`diff --unified=0` — только если в отобранных пайплайнах есть `secretScan`.
Контекст собирается один раз на событие. История прогонов ограничена 100
записями, вывод — 1 МБ в памяти / 100 КБ на диске. Список пайплайнов и логов
малы, без виртуализации осознанно.

## Проверки

- `npm test` — зелёный, включая `checks/automation.mjs`,
  `checks/secret-rules.mjs`, `checks/automation-run.mjs` (последняя запускает
  настоящий `spawn` и настоящий `git`: коды/вывод/таймаут/отмена, guard пути
  скрипта, последовательность и остановка на первой ошибке, gating по условиям).
- `npm run build` — без предупреждений.
- `scripts/automations-smoke.mjs` — Electron: пайплайн из шаблона, ручной
  запуск с блокировкой на `main`, заблокированный коммит, Bypass once →
  коммит проходит, история прогонов, раскрытие записи, 4 отказа IPC
  (неизвестное событие, чужой repo id, `&&` в команде, `../` в пути скрипта),
  обе темы. Снимки `artifacts/m6-automations-{blocked,dark,light}.png`.
- `smoke.mjs`, `history-smoke.mjs`, `worktree-smoke.mjs`, `ops-smoke.mjs`,
  `browse-smoke.mjs`, `profile-smoke.mjs`, `repositories-smoke.mjs`,
  `ssh-undo-smoke.mjs` — зелёные.

## Не в этом шаге

- Диспетчеры в `.git/hooks` + headless `hook-runner` (git из внешнего
  терминала), оборачивание чужих хуков «до/после».
- Twig-native действия (AI-ревью, генерация сообщения, changelog, аудит
  зависимостей, проверка имени ветки) — диспетчер действий готов принять их
  новым `type`.
- `prepare-commit-msg` заведён в списке событий и редакторе, но осмысленной
  точки перехвата в UI пока нет (Twig не показывает шаг подготовки сообщения).

## Постороннее наблюдение

В рабочем дереве параллельно лежит незакоммиченная фича drag-and-drop
(`main/git/drop*.js`, `useGitDrag.js`, `DropDialog.jsx`, `scripts/*drop*`).
Она сменила `title` кнопки ветки в сайдбаре и тем сломала селекторы
`.real-branch[title="…"]` в `history-smoke.mjs` и `repositories-smoke.mjs` —
поправлено на `[title^="…"]` (правка только в тестах). `scripts/drop-smoke.mjs`
падает на своём же незавершённом коде — это к автору drag-and-drop, не к M6.
