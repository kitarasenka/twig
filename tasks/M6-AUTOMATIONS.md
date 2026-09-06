# M6 — Git Hooks Automation Pipeline (шаг 1)

Новая веха вне исходного брифа (`PROMPT.md` кончается на M5). Превращает
клиентские git-хуки в визуальную систему автоматизаций: **триггер → условия →
действия → результат**, без ручных исполняемых файлов в `.git/hooks`.

## Решения, согласованные с пользователем

1. **Шаг 1 = движок + весь UI.** Редактор пайплайнов, условия, действия,
   оверлей выполнения, логи, шаблоны, модель доверия `.twig/hooks.json` — на все
   10 клиентских событий. Пайплайны срабатывают на git-операции **внутри Twig**.
   Существующие `.git/hooks` только показываются (read-only).
   Шаг 2 (позже): диспетчеры в `.git/hooks` + headless-раннер для git из
   внешнего терминала + оборачивание чужих хуков.
2. **Исполнение — токенизация, никогда shell.** `spawn(cmd, args, {shell:false})`.
   `& | ; < > $ \`` и переносы строк отклоняются на разборе. «Custom» = свободный
   argv, всё равно без shell.
3. **UI — экран в сайдбаре репозитория** (Automations рядом с Branches/Stashes)
   плюс оверлей выполнения и trust-запрос. Настройки раннера (PATH, таймаут) —
   на том же экране, per-repo.
4. **Версия — 0.4.0 (minor)** в общем коммите с drag-and-drop и аватарами графа.

## Архитектура (семь разделённых частей)

- Хранилище конфига — `main/automations-store.js` (+ `automation-runs-store.js`).
- Раннер команд — `main/automation/exec.js` (`spawn`, без shell, журнал, таймаут).
- Движок — `main/automation/engine.js`: `triggerPipeline(event, ...)`.
- Условия — `renderer/src/features/automations/condition-eval.js` (чистый).
- Действия — `main/automation/actions.js` + чистые правила сообщений/секретов.
- Логи — `automation-runs.json`, до 100 записей, вывод ≤ 100 КБ/шаг.
- IPC + UI-состояние — `main/automations-ipc.js`, `preload`, экраны в
  `renderer/src/features/automations/`.

Чистые модули без импортов (кроме соседних) грузят и Vite, и Node-проверки;
`main/automation/*` импортирует их относительным путём — как это уже делают
`scripts/checks/*` и `HistoryWorkspace` с `main/git/drop-plan.js`.

## Безопасность (несущая, не украшение)

Приложение расширяет модель угроз: раньше единственный процесс — `git`. Теперь
запускаются команды пользователя.

- Никакого shell. `command-parse.js` — весь контракт: разбор с учётом кавычек,
  без раскрытия, с отказом на метасимволах.
- Исполняемое — только имя из PATH; «скрипт» — путь строго внутри рабочего
  дерева (`path.relative`), Twig не делает `chmod`.
- `.twig/hooks.json` — недоверенные данные. Не исполняется до явного
  «Review & Enable». Trust = `{ digest, approvedCommands, enabledRepoPipelineIds }`.
  Правка файла → digest не совпал → всё выключено + повторный запрос. На
  clone/open не запускается ничего.
- Точная команда видна везде: редактор, оверлей, консоль (журнал с `executable`),
  trust-запрос. Ярлык — добавка, не замена.
- Bypass разовый, не сохраняется, помечает прогон и заметку «checks skipped».
- Таймаут на шаг + отмена по `AbortController`. Сеть — только команды
  пользователя; сам код автоматизаций наружу не ходит.

## Точки перехвата (шаг 1, всё внутри Twig)

| события | место |
|---|---|
| pre-commit → commit-msg → post-commit | `WorktreeScreen.commit()` |
| pre-merge-commit / post-merge | меню коммита, `merge` |
| pre-rebase / post-rewrite | `rebase`, интерактивный rebase, reword |
| pre-push | `App.runSync('push')` |
| post-checkout | меню коммита, `checkout` |

## Проверка

`npm test` (+ `automation.mjs`, `secret-rules.mjs`, `automation-run.mjs`),
`npm run build`, `scripts/automations-smoke.mjs`, ручной прогон по сценариям
из плана, `git diff --check`.
