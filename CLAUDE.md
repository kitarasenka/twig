# twig

🌱 Twig — автономный десктопный Git-клиент на Electron + React 18 + Vite,
JavaScript ESM / Node 20. Бриф-источник правды: `PROMPT.md`, прочитать целиком.

Отдельный публичный репозиторий (`github.com/kitarasenka/twig`), выделен из
приватного монорепозитория `nodes-managers` (каталог `modules/git_desk`) через
`git subtree split` — история M0…M6 сохранена, пути в старых коммитах остались с
префиксом `modules/git_desk/`. Это **не** сервис nodex: `nodex.json`, PM2-запись
и упоминания монорепо в новом коде не нужны. В `nodes-managers/modules/git_desk`
пока лежит незакоммиченная копия того же состояния — трогать её отдельно.

Название во всех пользовательских текстах — **🌱 Twig**, с росточком и пробелом:
сайт, кнопки, заголовки, метаданные страницы, сообщения приложения и документация.
Технические идентификаторы `twig`, пути и имена файлов установщиков — отдельные
машинные имена; написание бренда ими не определяется.

## Состояние

Обновление из приложения (2026-09-25, вне вех): раньше «Check for updates»
только давал ссылку — новую версию надо было скачать, установить и на macOS
ещё разрешить в Privacy & Security. Теперь: Settings → Updates → **Check for
updates** (и опционально «Check automatically: At launch and daily», по
умолчанию «Only when I ask», `updates.json` в userData, `main/update-store.js`)
→ в шапке у шестерёнки кнопка **Update to X.Y.Z** → «Downloading N%» (в
Settings — полоса, байты, **Cancel download**, «What's new» из тела релиза) →
**Restart to update**. Squirrel/electron-updater не подходит: на macOS он
требует ту же Developer ID-подпись у нового бандла, а у нас ad-hoc. Поэтому
берётся тот же установщик, что на сайте, а целостность — по `digest`
(`sha256:…`), который GitHub считает при загрузке ассета (`pickAsset` в
`main/update-check.js`: имя строго `artifactName` этой установки, URL строго
`…/releases/download/twig-v<версия>/<имя>`, без digest — не качается).
`main/update-target.js` (чистый) определяет установку: **mac** (бандл из
`execPath`; AppTranslocation — отказ с «перенеси в Applications»), **win**
(NSIS x64), **appimage** (`$APPIMAGE`), **deb** (`/opt/…`), иначе/из исходников
— unsupported с причиной. `main/updater.js` (без electron): `downloadAsset` —
редиректы вручную (≤5, только github.com/`*.githubusercontent.com`), поток в
файл с sha256 на лету, лишний/недостающий байт или чужой хэш — файл удаляется,
простой 60 с и Cancel рвут чтение даже если тело игнорирует abort. Подготовка:
mac — `hdiutil attach -readonly` → `ditto` в `.twig-update.app` рядом с
текущим → bundle id `app.nodex.twig`, версия = релиз, `codesign --verify
--deep --strict`, снятие `com.apple.quarantine` (файлы пишет наш процесс,
флага и так нет — поэтому Gatekeeper больше не спрашивает); win — `MZ`;
AppImage — ELF + `AI\x02`, копия `.twig-update.AppImage` рядом; deb —
`!<arch>`, в Downloads. Установка: mac — rename текущего в
`.twig-previous.app`, staged на его место (откат при ошибке; EPERM → подсказка
про App Management), затем `/bin/sh` ждёт выхода pid и делает `open <app>`;
AppImage — rename поверх файла, перезапуск тем же helper'ом без APPDIR/
FONTCONFIG_* старого mount'а; win — `installer --updated /S --force-run`; deb —
`shell.openPath`. Следующий запуск удаляет `.twig-previous.app`/staged и
`userData/updates`. Каналы `update:state|check|download|cancel|install|auto`
(`main/update-ipc.js`, `app:check-update` удалён), событие `update:state`;
мост `checkForUpdate`, `getUpdateState`, `downloadUpdate`, `cancelUpdate`,
`installUpdate`, `setAutoUpdateCheck`, `onUpdateState`. Слова —
`renderer/src/app/update-view.js`. Restart выключен, пока идёт sync/Undo.
**Работает начиная с версии, в которую это войдёт**: с 0.13.0 и раньше
обновиться придётся вручную последний раз.
Проверки: `scripts/checks/updater.mjs` (в `npm test`, без сети): выбор ассета и
враждебные поля релиза, все цели установки, хосты/размер/checksum/отмена
скачивания, helper перезапуска реально ждёт процесс, потоки AppImage/Windows/
deb, а на macOS — **настоящий DMG** (`hdiutil create`), mount, чужой bundle id и
чужая версия отклоняются, подмена бандла и уборка. `smoke.mjs` — мост, Off по
умолчанию, кнопки в шапке нет, отказ IPC. **Живьём на macOS arm64:** упакованный
`--mac dir` с `extraMetadata.version=0.12.0` через UI скачал настоящий
`Twig-0.13.0-macos-arm64.dmg`, Cancel вернул «доступно», повторно из шапки —
до Restart, перезапуск открыл 0.13.0 из того же пути, подпись валидна, xattr
пуст. Windows и Linux живьём не проверялись. Версия не менялась.

Соавторы, .gitignore из меню, пометки bisect, теги, обслуживание (2026-09-24,
вне вех). Пять возможностей одним заходом.

- **Соавторы** (`main/git/co-author-trailer.js` — общий для main и renderer,
  `main/git/co-authors.js`, `worktree/CoAuthors.jsx`): под сообщением коммита
  кнопка «Add co-authors» (по умолчанию форма не выше прежней — иначе на
  маленьком окне она перекрывала дифф staging, поймал `worktree-smoke`);
  выбор — только из авторов истории: `log --exclude=refs/twig/* --exclude=refs/stash
  --all -z --format=%aN%x00%aE --max-count=5000` (mailmap, счёт коммитов, себя по
  `config --default '' --get user.email` и бэкапы 🌱 Twig не предлагает).
  Каждый человек — слово argv `--trailer=Co-authored-by: Имя <email>` (Git сам
  ставит блок трейлеров); превью строки под полем строит тот же модуль.
  `missingCoAuthors` отбрасывает тех, чья строка уже есть в сообщении: при amend
  Git (`addIfDifferentNeighbor`) иначе повторил бы трейлер. `worktree:commit`
  теперь 5 аргументов, кривой соавтор отклоняет запрос до Undo; канал
  `worktree:co-authors`, мост `getCoAuthors`.
- **.gitignore** (`main/git/ignore-plan.js` чистый, `main/git/ignore.js`): у
  untracked-файла в меню панели незакоммиченного и (новое) правым кликом /
  Shift+F10 на экране staging — «Ignore this file» (`/путь`), «Ignore all .ext
  files» (`*.ext`), «Ignore folder dir/» (`/dir/`); подсказка пункта — точная
  строка. Renderer шлёт путь и вид, шаблон считает main (спецсимволы
  экранируются, `#`/`!` в начале тоже), путь обязан быть untracked в свежем
  status. Пишется корневой `.gitignore` (сохраняются окончания строк, дубликат
  не добавляется, симлинк/не-файл/>1 МБ — отказ), в журнал как
  `🌱 Twig append .gitignore <шаблон>`. Undo — kind `worktree:ignore`: до и после
  записи снимок `.gitignore` коммитом в `refs/twig/discard` (экспортирован
  `snapshot` из `discard.js`), Undo = `restore --source=<до>` или `clean -f -x`,
  если файл создан этим действием; Redo = `restore --source=<после>`.
- **Пометки bisect в графе** (`graph/bisect-marks.js`): у коммитов чип с иконкой и
  словом терминов репозитория — bad / good / skipped / testing (ревизия на
  проверке) / first bad (результат). Все ответы берутся из `BISECT_LOG`
  (`parseBisectLog`: строки `git bisect <term> <oid>` и комментарии
  `# <term>: [<oid>]` — только в них записаны концы `bisect start <bad> <good>`);
  `refs/bisect/*` держит лишь последний bad. Состояние bisect получило `marked`.
- **Теги** (`refs.js`: `loadTagDetails`, канал `refs:tags`, мост `getTagDetails`;
  `refs/tag-sort.js`): на вкладке Tags экрана «Branches and tags» — annotated /
  lightweight / signed, автор тега, дата, тема сообщения и «Full message»;
  лёгкий тег честно говорит, что сообщения у него нет (не подставляет
  сообщение коммита). Сортировка Version (по умолчанию: числа числами,
  пре-релиз раньше релиза, теги без цифр в конце) / Date / Name, выбор в
  `localStorage` `twig:tag-sort`; поиск идёт и по сообщениям. Разбор
  многострочного `for-each-ref`: каждое поле кончается NUL, `\n` Git'а —
  в начале следующей записи.
- **Обслуживание** (`main/git/maintenance-plan.js` чистый, `maintenance.js`,
  `tools/MaintenanceScreen.jsx`, пункт «Maintenance» в сайдбаре): размер из
  `count-objects -v` (на диске, объекты, паки, рыхлые, мусор) и подсказка по
  порогам авто-gc. **Optimize** — `maintenance run --task=commit-graph
  --task=loose-objects --task=incremental-repack`, затем `prune-packed`
  (задача loose-objects удаляет рыхлые копии упакованного только при
  *следующем* запуске — один клик ничего не уменьшал, поймала проверка);
  ничего нужного не удаляет, без диалога. **Clean up** — `git gc` через §6.5 с
  предупреждением про истечение reflog и удаление недостижимого старше двух
  недель. Каналы `maintenance:stats|run` (задача из allowlist, не argv), отмена —
  общая `tools:cancel`, через `undo.perform` (цепочку Undo не рвёт — проверено).

Проверки: новые `tags.mjs`, `co-authors.mjs`, `ignore.mjs`, `maintenance.mjs`
(в `npm test`, на настоящем Git, Undo — через настоящий `UndoService`),
дополнен `bisect.mjs`; новый смоук `scripts/everyday-smoke.mjs` (в `test:smoke`):
все пять сценариев, Undo правила, 8 отказов IPC, снимки `artifacts/everyday-*.png`.
Все 15 смоуков и `npm test` (кроме заранее сломанного `foundation.mjs`) зелёные.
Версия не менялась.

UI/UX-проход по свежим снимкам (2026-09-24, вне вех): решения — в
`design/TOKENS.md` («UI/UX pass over the app»). Кнопки получили уровни:
`primary` / новый `secondary` / обычная / `danger` (рамка только у
подтверждающей кнопки опасного диалога) / `danger quiet` (корзины в списках,
Abort в баннере операции, Bypass once — красным, но не громче всех); выключенная
`primary`/`danger` выглядит обычной. `.text-button` — Fira Sans (id родителей —
моно). Панель коммита: тема первой, марка — одной строкой под деталями
(`.mark-remove`, заметка в поле с `secondary` Save note), «1 changed file»,
сортировка «Sort by path/status». Выделение в графе — рамка, тинт марок слабее.
Незакоммиченное: без повторного заголовка (шапка `UNCOMMITTED CHANGES` +
сводка), плюс/минус — акцентный квадрат 26 px (`button.move`; заодно починены
селекторы `.bulk`, которые ничего не выбирали: `className` у `Button` ложится на
сам `<button>`), «Uncommitted changes, 1 file». Тулбар: бейдж на углу иконки,
BugHunter — иконка `Bug` + слово (полное имя в подсказке). Сайдбар: поиск
«Search» + `kbd` сочетания, подвал — ветка, её upstream и «N to push/pull» /
«in sync» / «Not published». Все `<summary>` — нарисованный шеврон вместо
треугольника. Консоль: строка статуса показывает последнее действие из «My»
по имени операции (полный argv — в `title`), провал — словом. Дифф: посимвольное
уточнение только при ≥ 50 % общего и ≤ 2 правках на сторону, числа целиком
(`rememberTabs`→`keyboardNav` больше не конфетти, `250`→`500` — замена числа).
Конфликт: «Take all ours/theirs» в шапке, «Take …» в блоке; колонка BASE без
записанной базы сжимается до «Not in the markers ⓘ». История файла и blame
открывают правую панель на 560 px. Редактор автоматизаций: один уровень рамок,
у `ol.rule-list` снят отступ списка, переключатель «Keep going» не центрируется.
В шапке графа хвостовой разделитель виден только при наведении.
Проверки: `intraline.mjs` и `syntax.mjs` закрепляют новое уточнение (замена
идентификатора целиком, числа целиком, опечатка по-прежнему посимвольно);
смоук-локаторы обновлены под «1 file». `foundation.mjs` падает до этой правки и
независимо от неё: копирует `../../tools/install-modules.js` из монорепозитория,
которого в выделенном репозитории нет. Все 14 смоуков зелёные; снимки сайта
пересняты (`shots:site`). Попутно: `.new-day` перебивал `box-shadow` выделения —
добавлено `.real-commit-row.new-day.selected`. Версия не менялась.

README и сайт догнали 0.8.8–0.10.0, скриншоты сняты заново (2026-09-24, вне вех).
Снимки больше не берутся из смоук-артефактов с фикстурами: `scripts/site-shots.mjs`
(`npm run shots:site`) сеет демо-песочницу во временном профиле под `/tmp`
(консоль печатает cwd), окно 1440×880 → 2880×1760, и проводит UI по сценариям:
марки через `setMark` + Refresh, набранная команда в консоли, полоса и панель
незакоммиченного (README переносится в индекс плюсом, затем правится ещё раз на
диске), история файла, blame, шаблоны автоматизаций и блокировка, BugHunter
(правки сначала уходят во внешний `stash -u` — ему нужно чистое дерево) и
конфликт: коммит в `feature/command-log` делается через временный
`GIT_INDEX_FILE` без трогания дерева, merge — внешним git. Скрипт ничего не
проверяет (это делают смоуки), только снимает; перед кадром закрывает
`.operation-note`. PNG → `artifacts/site-shots/`, WebP (`cwebp -q 88`) →
`site/assets/shots/` — их используют и README (`<picture>` с тёмной/светлой
версией + таблица-галерея), и сайт. `site/assets/workspace.png` удалён;
`site/build.mjs` копирует все `assets/shots/*.webp`, `preview.mjs` знает MIME
`.webp`. На сайте новая секция `#screens` (шесть кадров, ссылка «Экраны» в
навигации) и правки текстов (журнал My/Full History, закрываемая демо, номера
строк). README: полоса незакоммиченного, номера строк, перенос плашек, консоль
My/Full History и ужатие журнала, Undo/Redo, SSH, Check for updates, AppImage и
Linux-лаунчер; M5 описана честно — осталась только живая проверка Windows/Linux.
Проверки: `site/check.mjs` на 375/768/1024/1440, `version.mjs`, `eslint .`.

Worktrees, сабмодули, подписи, патчи, диапазоны, LFS (2026-09-24, вне вех).
Шесть возможностей одним заходом; Git-слой каждой — отдельный модуль в
`main/git/`, каналы — новый `main/repo-tools-ipc.js` (кроме применения патча и
cherry-pick/revert диапазона — они в `history-ops-ipc.js`, потому что отвечают
состоянием операции и идут через `undo.perform`).

- **Worktrees** (`worktrees.js`): экран «Worktrees» в сайдбаре (`git worktree
  list --porcelain -z`: Main / This tab / Locked / Folder missing), «Open as tab»,
  «Remove…» (§6.5; грязный — второй диалог с `--force`; main и текущий
  отказываются; вкладка удалённого закрывается вместе с ним, ветка остаётся),
  «Prune missing». Пункт меню ветки **Open <b> in a new worktree…** и кнопка
  «New worktree…» открывают `WorktreeDialog`: существующая свободная ветка или
  новая от HEAD, папка — `<repo>-<ветка>` рядом с основной (номер, если занято)
  или выбранная нативным диалогом. Папку планирует main и держит **токеном**
  (`main/token-registry.js`, 15 мин, одноразовый, привязан к репозиторию):
  renderer путь не присылает, показанная команда = исполняемая. После `worktree
  add` main делает `repositories.add` — новая вкладка открывается сразу
  (`onOpenWorkspace` → `openWorkspaceTab` в App).
- **Сабмодули** (`submodules.js`): закреплённый коммит — gitlink из `ls-files
  --stage -z`, имя/URL/ветка — `config --file .gitmodules -z` (имя может
  содержать точки), что выкачано — HEAD внутри; человеческий `git submodule
  status` не парсится. Состояния pinned / moved / uninitialized словами, URL без
  credentials. «Initialize» / «Check out pinned commit» / «Update all…» —
  `git submodule update --init -- <пути>` через §6.5 (без danger), отмена,
  обрывает Undo честно. «Open as tab» — инициализированный сабмодуль вкладкой.
- **Подписи** (`signature.js`, `features/commit/signature-view.js`): есть ли
  подпись — по заголовку `gpgsig` самого коммита, потому что без
  `gpg.ssh.allowedSignersFile` Git отвечает `N` и для подписанного SSH-коммита;
  `%G?` — только результат проверки. В панели коммита строка с иконкой и словом
  (Verified / Signed, signer not trusted / Bad signature / …, для неподтверждаемой
  SSH — что настроить), в деталях строка Signature. Канал `history:signature`,
  читается после самого коммита. Профиль: Sign new commits (`commit.gpgSign`),
  Signature format, Signing key, Sign annotated tags, Allowed signers file —
  значения-выборы через `PROFILE_CHOICES` в main. `exec.js` теперь всегда
  добавляет `-c log.showSignature=false`: включённый у человека
  `log.showSignature` печатал бы вывод gpg в NUL-записи всех `log`/`show`
  (явный `--show-signature` в консоли его перебивает).
- **Патчи** (`patches.js`): «Export … as a patch…» в меню коммита и мультивыделения
  — каждый коммит `format-patch` во временную папку, склейка **байтами** в один
  mbox (кодировки не портятся), путь — нативный диалог сохранения; merge
  отказывается заранее (этот Git делает для него патч по первому родителю).
  «Apply patch…» в шапке истории: `patch:choose` (диалог, разбор: mbox или diff,
  коммиты, файлы, `apply --check`) → токен → `PatchDialog` с командой →
  `patch:am` (`am --3way --`, Undo — reset как у cherry-pick) или `patch:apply`
  (`apply [--index] --`, всё или ничего, обрывает Undo). Попутно исправлено:
  идущий `git am` раньше читался как rebase (`rebase-apply` общий) — теперь вид
  операции `am` (файл `applying`, шаги `next`/`last`), баннер зовёт
  `am --continue/--skip/--abort`.
- **Cherry-pick и revert диапазона**: в меню мультивыделения «Cherry-pick N
  commits onto <ветка>…» (старые первыми; отказ, если какие-то уже на ветке) и
  «Revert N commits…» (новые первыми; только коммиты ветки); merge-коммит в
  выделении отказывает с причиной. Один запуск sequencer'а (`ops:cherry-pick-many`,
  `ops:revert-many`, 2–100 oid, main перепроверяет merge через `rev-list
  --min-parents=2`), диалог с точной командой, один Undo откатывает всю серию.
- **Git LFS** (`lfs.js`, `features/diff/lfs-pointer.js`): LFS узнаётся по
  `filter=lfs` в закоммиченных `.gitattributes` — без git-lfs вообще, так что
  «не установлен» тоже честно сказано. Все пробы выходят с кодом 0 (`ls-files` +
  `cat-file --batch`, git-lfs ищется в exec path и PATH, а не запуском `git lfs`):
  проба с «ненайдено = код 1» выглядела бы в журнале провалом, и «Show output»
  показал бы на неё вместо настоящей ошибки — это поймал `browse-smoke`. С git-lfs плашка над графом считает
  файлы-указатели (`lfs ls-files --long`) и даёт **Download (git lfs pull)** с
  отменой. Дифф указателя показывается карточкой «Replaced in Git LFS: 1000 B →
  2.4 MB» с размерами и oid, «Show pointer text» — исходный текст.

Проверки: `signature.mjs`, `patches.mjs`, `lfs.mjs`, `submodules.mjs`,
`worktrees.mjs` (в `npm test`, **на настоящем Git**; SSH-подпись — настоящим
ssh-keygen, git-lfs — подставной скрипт на PATH, сабмодули — с
`protocol.file.allow=always` через `GIT_CONFIG_*`), `history-ops(-live).mjs` —
диапазоны. Смоук `scripts/tools-smoke.mjs` (в `test:smoke`): плашка LFS и pull,
карточка указателя, Verified signature, cherry-pick выделения + Undo (нативное
подтверждение подменяется), экспорт и `am`, worktree из меню ветки открывается
вкладкой и удаляется вместе с ней, сабмодуль вкладкой, 8 отказов IPC; снимки
`artifacts/tools-*.png`. Версия 0.10.0 → **0.11.0** (minor, по поручению
пользователя): тегом `twig-v0.11.0` уезжает всё, что сделано 2026-09-24 —
контекстные меню, rename, подсветка, discard, поиск, reflog, фоновый fetch и
эти шесть возможностей.

Reflog и восстановление потерянного (2026-09-24, вне вех): в сайдбаре пункт
**Reflog** (иконка History, рядом со Stashes) — экран «где был HEAD / каждая
ветка»: селектор «HEAD has been / <ветка> has been», новые сверху, у каждой
записи `HEAD@{n}`, действие словом (Reset, Checkout, Amend, Rebase, …), детали
reflog-сообщения (полные SHA сокращены до 7, полный текст в `title`), время
**перемещения** (не коммита), короткий SHA и тема коммита. Коммит, который не
держит ни ветка, ни тег, ни remote, ни HEAD, помечен плашкой **«On no branch»**
(иконка + слово, не только цвет); фильтр «Only commits on no branch». Справа —
детали выбранной записи: сообщение, автор, файлы и дифф (граф такой коммит
показать не может), предупреждение, что Git удалит его по истечении reflog.
Действия: **Create branch here…** (имя предлагается: ветка, на которой коммит
был сделан, — из ближайшего `checkout: moving from X` — если имя свободно, иначе
`recovered-<sha>`; `NameDialog` получил `suggested`, чтобы предложенное имя можно
было принять как есть), **Move <ветка> here…** (в reflog HEAD — текущая ветка,
в reflog ветки — она сама; выключено с причиной: detached, ветки нет, уже здесь,
идёт операция), **Show in history** (выключено для потерянных), **Copy SHA**.
Клавиатура: стрелки/Home/End по списку. Постранично по 200 («Load older entries»).

Git-слой — `main/git/reflog.js`: `git log --walk-reflogs --date=unix -z` в своём
NUL-формате (`%gd` с `--date=unix` даёт время перемещения, индекс `@{n}` — позиция
записи; человеческий вывод `git reflog` и файлы `.git/logs` не читаются — у
reftable их нет), `--no-show-signature`, ветка полным `refs/heads/…` перед `--`,
`--max-count=limit+1` говорит, есть ли ещё страница. «Потерянность» — один
`rev-list --ignore-missing --stdin --not --branches --tags --remotes HEAD` на
страницу (id через stdin). Перенос ветки (`moveBranch`) сверяет, что ветка всё
ещё там, где её видел экран (`expected`), и что коммит существует. Команду строит
чистый `main/git/reflog-plan.js` (его же печатает диалог §6.5): текущая ветка —
`reset --keep <oid>` (файлы следуют за веткой, незакоммиченное остаётся, а при
конфликте с ним Git отказывает и ничего не двигается), другая —
`update-ref -m "🌱 Twig: move … from the reflog" refs/heads/<b> <new> <old>`
(compare-and-swap: сдвинувшаяся ветка не перезаписывается). Undo — kind
`reflog:move-branch`, аргументы `[ветка, откуда, куда, checked-out]` из результата
действия, инверсия — та же команда с переставленными концами. Каналы
`reflog:read` (history-ipc; `null` = HEAD) и `reflog:move-branch` (history-ops-ipc,
отказ во время merge/rebase), мост `getReflog`/`moveBranchTo`. `ConfirmDialog`
теперь берёт в кавычки аргументы с пробелами/кавычками (как `DropDialog`), иначе
`-m` сообщение читалось бы как несколько слов.

Фоновый fetch по расписанию (2026-09-24, вне вех; **по согласию**): Settings →
«Background fetch»: Off (по умолчанию) / Every 5 / 15 / 30 minutes / Every hour.
Текст под выбором прямо говорит, что это единственный сетевой доступ, который
🌱 Twig делает сам, и показывает статус открытого репозитория («Last fetched …» /
«Fetching now…» / причина ошибки). Подсказка кнопки Pull говорит, насколько свежи
бейджи. Согласие хранится в **main** (`main/fetch-store.js`,
`background-fetch.json` в userData; нет файла или он битый — Off), потому что
fetch запускает main. `main/background-fetch.js` (без импортов Electron):
`BACKGROUND_FETCH_ARGV` = `fetch --all --no-tags --no-recurse-submodules` (двигаются
только remote-tracking ветки; теги приходят только ручным fetch; без prune);
`createFetchScheduler` — **ни одного таймера, пока Off или репозиторий не открыт**,
иначе один `setTimeout` на ближайший срок: только репозиторий активной вкладки
(идёт за `repo:watch`, при закрытии окна останавливается), новый репозиторий —
через 10 с, дальше — через интервал; ошибка ждёт следующего интервала (без
повторов в цикле); пока идёт действие человека на этом репозитории
(`undo.isBusy`) — не стартует (повтор через минуту), а начатое действие отменяет
идущий фоновый fetch (`undo.onChange` → `cancel`), чтобы не спорить за lock'и
ref'ов. `backgroundFetch` в `sync.js` журналируется как
`Background: fetch all remotes` (в консоли — только Full History), причина ошибки
для Settings очищается от credentials в URL. Каналы `fetch:get|set|status`
(`main/fetch-ipc.js`, интервал строго из allowlist), событие `fetch:update`;
после него App перечитывает бейджи, граф перечитывает watcher. Мост:
`getBackgroundFetch`, `setBackgroundFetch`, `getBackgroundFetchStatus`,
`onBackgroundFetch`. Слова — чистый `renderer/src/app/background-fetch-view.js`;
общий `renderer/src/ui/relative-time.js`.

Чтобы fetch не рвал Undo: отпечаток состояния (`undo-snapshot.js`) больше не
включает `refs/remotes/*` и строку `# branch.ab` (ahead/behind считается от
remote-tracking ветки) — ни одна инверсия их не читает и не двигает. Ручной
`fetch`/`fetch-prune` тоже больше не обрывает цепочку, если сдвинул только
remote-ветки (обрывает, только если принёс теги). Watcher перестал реагировать
на `FETCH_HEAD`: его переписывает каждый fetch, даже пустой, а fetch, который
что-то принёс, двигает refs.

Проверки: `scripts/checks/reflog.mjs` и `scripts/checks/background-fetch.mjs`
(в `npm test`, **на настоящем Git**): argv и разбор, страницы, reflog ветки,
ветка без reflog, потерянные после `branch -D` и `reset --hard`, предложенное
имя, перенос текущей ветки (`reset --keep` сохраняет незакоммиченное, отказ при
конфликте) и чужой (`update-ref`, отказ на устаревшем tip), Undo/Redo через
настоящий `UndoService`; планировщик на фиктивных часах (Off — ноль таймеров,
только активный репозиторий, уступает действиям, отмена, пауза после ошибки),
хранилище, настоящий fetch против локального bare (двигается только
`origin/main`, тегов нет, HEAD и файлы на месте, **цепочка Undo жива**),
credentials не попадают в текст. Новый смоук `scripts/reflog-smoke.mjs` (в
`test:smoke`): Off 12 с — ни одного fetch; включение — бейдж Pull «1» без клика,
запись в журнале, выключение; reflog, «On no branch», восстановление удалённой
ветки под её именем, Move main here с точной командой, Cancel, Undo, reflog
ветки, Show in history, 5+3 отказа IPC; снимки
`artifacts/reflog-{dark,light}.png`, `artifacts/background-fetch-settings.png`.
Версия не менялась.

Отмена изменений (Discard) с настоящим Undo (2026-09-24, вне вех): файл,
выбранные строки, вся секция Changes; удаление untracked-файла, папки или всей
секции Untracked. Где: иконки ↶ / корзина на каждом файле и в заголовках секций
панели незакоммиченного и экрана staging, «Discard N selected» рядом со «Stage N
selected» в построчном диффе, пункт «Discard changes…» / «Delete file…» в меню
файла. Всё — через диалог §6.5 (`ConfirmDialog`) с точной командой из общего
чистого модуля `main/git/discard-plan.js` (его же исполняет main — показанное не
может разойтись с запущенным). Staged не сбрасывается: сначала unstage.
Отказы (и в main, и выключенной кнопкой с причиной): конфликт, сабмодуль,
файл после `git add -N`, путь, которого уже нет в секции, устаревший digest
диффа, построчный discard нового/удалённого файла.

Как работает Undo (`main/git/discard.js`): **до** сброса файлы кладутся в
объекты Git — `hash-object -w --stdin-paths`, дерево через временный
`GIT_INDEX_FILE` (настоящий индекс не трогается), `commit-tree` (свой
identity, `--no-gpg-sign`, сообщение через stdin) под скрытым ref
`refs/twig/discard`; бэкапы цепочкой (до 200, дальше цепочка начинается заново).
**После** сброса — второй снимок тех же путей. Undo = `git restore
--source=<before> --worktree` по всем путям (no-overlay: восстановленный
удалённый файл снова удаляется), Redo = `restore --source=<after>` + `clean -f`
для untracked. Пути идут через `--pathspec-from-file=-` (команды Undo теперь могут
быть `{ argv, stdin }`). `undo.perform` для kind `worktree:discard` сохраняет
аргументы из результата действия (id двух коммитов и пути — не содержимое).
Бэкапы скрыты: `--exclude=refs/twig/*` **перед** `--all` в истории и поиске
(после `--all` Git его молча игнорирует — проверено), `for-each-ref` читает
только heads/remotes/tags. Даже после обрыва цепочки Undo содержимое лежит в
`git log refs/twig/discard`. Каналы `worktree:discard|discard-all|discard-lines`,
мост `discardFile/discardAll/discardSelection`.

Попутно исправлены два бага раскладки, найденные смоуком: тулбар диффа в
колонке сжимался до нуля и перекрывал первые строки (`flex: none`), а у
`.worktree-body` не было высоты строки грида — длинный дифф на экране staging
вылезал под форму коммита вместо прокрутки (`grid-template-rows: minmax(0, 1fr)`).

Поиск по автору, файлу и содержимому (2026-09-24, вне вех): в строке
результатов поиска — селектор «Search in»: Messages and hashes (как было) /
Author name or email (`--author`, литерально, без регистра) / Changed file path
(pathspec `:(glob,icase)**/*текст*` + `/**`, glob-символы экранированы) /
Code added or removed (`-S`, pickaxe: где строка появилась или исчезла; точный
регистр, счёт по файлу) / Code matching a regex (`-G`). Сломанный regex — не
ошибка, а ответ `{ invalid }` с причиной Git. Новый поиск отменяет прежний
(`AbortController` на репозиторий в `history:search`, теперь 3 аргумента, режим
из allowlist). Сайдбар фильтрует ветки по имени только в режиме сообщений.
Подписи — чистый `renderer/src/features/graph/search-modes.js` (паритет списка
режимов с `SEARCH_MODES` в main проверяется).

Проверки: `scripts/checks/discard.mjs` и `scripts/checks/search.mjs` (в
`npm test`, **на настоящем Git**): все виды discard, сохранение staged-части,
исполняемый бит, симлинк, папка, бэкапы вне истории, Undo/Redo побайтно через
настоящий `UndoService`, отказы; все режимы поиска, `-S` появление/исчезновение,
`-G`, сломанный regex, экранирование glob, скрытые бэкапы, отмена.
`worktree-smoke.mjs` — Cancel ничего не делает, удаление untracked и Undo,
построчный discard и Undo, Discard all/Delete all, 4 новых отказа IPC;
`history-smoke.mjs` — поиск по пути, автору (200+), `-S`, сломанный regex,
сайдбар не фильтруется, отказ IPC на неизвестный режим. Версия не менялась.

Подсветка синтаксиса и дифф «слово в слово» (2026-09-24, вне вех; §8.6 брифа):
дифф в панели коммита, стешах, blame-детали и на экране staging красится по
типу файла, blame — тоже. Над каждым диффом тулбар: язык («JavaScript» /
«Plain text») и переключатель **Lines / Words**. Words складывает пару
«удалённая + добавленная» строка, которую `annotatePatch` счёл правкой, в одну
строку `diff-changed` с маркером `~` и обоими номерами: общее один раз,
удалённые слова зачёркнуты, добавленные подчёркнуты — **целыми словами**
(`segmentPair` теперь отдаёт ещё `merged` из пословного LCS, без посимвольного
уточнения: `250`→`500` читается как замена слова, а не «2500»). Переписанные
строки остаются раздельными. Staging — только подсветка (там выбирают строки).
Настройка Settings → «Syntax highlighting» On/Off; режим и флаг —
`localStorage` (`twig:diff-mode`, `twig:syntax`), одно window-событие
переключает все открытые диффы разом (`useDiffPrefs`).

Токенайзер — **Prism 1.30.0** (MIT, без своих зависимостей; бриф запрещает
только графовые библиотеки и обёртки над git), 45 грамматик. Он отдаёт токены
как данные, HTML не генерируется — React экранирует текст как обычно. Prism и
грамматики — **отдельный чанк** (106 КБ / 35 КБ gzip), грузится при первом
диффе с цветом (`useHighlighter`), основной бандл +10 КБ, сборка без
предупреждений. `prism-setup.js` выключает автоподсветку страницы и worker.
Модули: `diff/languages.js` (имя файла → грамматика, без импортов),
`diff/syntax.js` (`highlightLines`: блок строк → диапазоны по строкам; роли
Prism сведены к семи: keyword/string/number/comment/function/type/property;
лимиты 2000 символов на строку и 300 КБ на блок — дальше обычный текст),
`diff/diff-view.js` (без импортов: `sideSyntax` — старая и новая сторона
каждого ханка подсвечиваются целиком, чтобы многострочные комментарии и
строки красились верно; `lineSpans`/`splitByRanges` — слияние синтаксиса с
сегментами изменений; `displayRows` — режимы Lines/Words).

Палитра: семь токенов `--syntax-*` и `--danger-bg` (фон удалённой строки —
раньше удалённая строка отличалась только красным текстом) в обеих темах.
Цвета подобраны расчётом: каждый держит ≥4.5:1 на всех 16 фонах, где может
оказаться код (панели, hover, добавленная/удалённая строка, тинты изменений
поверх каждого из них); тинты `.diff-seg-add/-del` снижены с 26/34 % до 20/22 %
— подчёркивание и зачёркивание по-прежнему несут смысл без цвета. Комментарии
ещё и курсивом: в тёмной теме их серый близок к тексту. С подсветкой строки
добавления/удаления пишутся цветом текста, их отличают тинт фона и маркер +/-
(маркер не выделяется при копировании).

Заодно исправлена гонка, которую вскрыл `browse-smoke`: `jump()` (кнопка
BugHunter «Show test commit», клик по ветке в сайдбаре, «Show in history»)
молча ничего не делал, если попадал в идущий `reload()` — `loadMore` отказывал
по `busy`. Теперь `reload` хранит свой промис (`reloading`), и `jump` его
дожидается. До правки тест падал ~1 из 2 прогонов, после — 4 из 4 зелёные.

Проверки: `scripts/checks/syntax.mjs` (в `npm test`) — карта языков, каждая
грамматика загружена и импортирована, диапазоны (многострочные шаблоны,
комментарии, тройные кавычки), лимиты, 4000 строк JS (235 КБ) за ~80 мс,
стороны ханка, слияние с сегментами, Words (одна строка на пару, переписанные
раздельно, синтаксис каждой стороны, целые слова), настройки с падающим
storage, контраст всех `--syntax-*` и `--text` на 16 фонах, считанных из
`tokens.css` и процентов тинтов в `history.css`; `smoke.mjs` — JS-дифф в
песочнице с `.syn-keyword`, тулбар «JavaScript», Settings Off/On;
`history-smoke.mjs` — Words на hello.txt и возврат в Lines. Версия не менялась.

Контекстные меню файлов и левой панели (2026-09-24, вне вех): меню файла (панель
коммита и панель незакоммиченного) получило **Open in <редактор>**, **Reveal in
Finder** / Show in Explorer / Show in file manager, **Copy path** / **Copy full
path**; у незакоммиченных ещё Stage/Unstage, у untracked нет File history/Blame.
Редактор выбирается в Settings → «Open files with»: System default, VS Code,
Cursor, Zed, Sublime Text или «Other application…» (нативный диалог в main).
Настройка живёт в **main** (`main/editor-store.js`, `editor.json` в userData):
renderer называет только preset из allowlist и никогда не передаёт путь к
программе. Чистый `main/editor.js`: `planOpen` — macOS всегда через `open -t` /
`open -a <App>` (System default = текстовый редактор, файл не «запускается»);
Windows/Linux System default = `shell.openPath`, но исполняемые типы (`.exe`,
`.bat`, `.desktop`, `.sh`, …) и файлы с exec-битом **отказываются**; preset на
Win/Linux ищет CLI на login-PATH, у Windows одинокий `.cmd` не запускается —
берётся `.exe` рядом. `resolveRepositoryFile` — путь только внутри рабочего
дерева. `main/files-ipc.js`: `editor:get|set`, `file:open`, `file:reveal`
(sender/frame/число аргументов, репозиторий по сохранённому списку); запуск —
один `spawn` с `shell:false`, журналируется как «Open in editor». Отсутствующий
в дереве файл → причина `missing`; reveal такого файла выделяет ближайшую
существующую папку (`showItemInFolder`, не `openPath` — папка `x.app` бы
запустилась). Левая панель: у каждой ветки/remote-ветки/тега — меню
(`renderer/src/features/refs/ref-menu.js`: Show in history, Check out, Merge,
Rebase onto, Compare with HEAD, Create branch/tag from, Copy name/SHA, плюс
общие с меню коммита Rename/Upstream/Publish/Delete — вынесены в
`refActionItems` в `commit-menu.js`), у заголовков LOCAL/REMOTE/TAGS — Create
branch/tag at HEAD, Fetch (`fetch --prune`), Open Branches and tags; у имени
текущей ветки в подвале — меню этой ветки. Всё и с клавиатуры (Shift+F10/Menu).
Rename у локальной ветки в меню сайдбара стоит третьим, сразу под Check out, с
подсказкой **F2**; F2 на ветке в сайдбаре сразу открывает диалог. `NameDialog`
получил `initialValue`: диалог переименования (сайдбар, меню коммита, экран
Branches and tags) начинается с текущего имени, выделенного целиком, а
неизменённое имя отклоняется («That is the current name»). У remote-веток
Rename нет: Git не переименовывает ref на сервере.
Проверки: `scripts/checks/context-menus.mjs` (в `npm test`), `history-smoke.mjs`
(редактор-скрипт через заглушку диалога, reveal, оба копирования, отказы IPC,
меню ветки/тега/секций), мост в `smoke.mjs`. Версия не менялась.

Незакоммиченное видно и разбирается в правой панели (2026-09-22, вне вех):
строка `Uncommitted changes` над графом была обычной строкой текста с иконкой —
теперь это **полоса** во всю ширину: тинт `--accent-bg`, акцентная планка слева
(`inset 3px 0`), иконка в залитом квадратике и **разбивка справа чипами**
`N staged` / `N changed` / `N untracked` (цвет не единственный носитель — каждый
чип называет свой список словом; пустой список не печатается нулём). Счётчик
в подписи по-прежнему считает **пути**, а не строки списков: путь с правкой и в
индексе, и в дереве попадает в оба списка, как его моделирует Git.

Клик по полосе больше **не** уводит со страницы: это теперь **выбор**, а не
экран. Граф остаётся на месте, а правый блок — тот же слот, что у коммита, —
показывает `WorktreePanel`: Staged / Changed / Untracked с бейджами статуса,
фильтром по пути, строкой-сводкой (`1 staged · 2 changed · 1 untracked on main`),
пометкой про конфликты и кнопкой **Open staging** — прежний экран рабочего
дерева (staging по строкам и коммит) в одном клике. Клик по файлу открывает его
дифф **только на чтение** в центре (тот же `DiffLines`, что у коммита) с плашкой
`Staged` / `Not staged`; untracked-файл дифф не получает вовсе и честно говорит
почему — `git add -N` за спиной не выполняется, это решение принимают на экране
staging.

Файлы **двигаются прямо из панели**: у каждого в Changed и Untracked — плюс
справа (в индекс), у каждого в Staged — минус (обратно); в заголовке каждого
списка — **Stage all** / **Unstage all**. Направление задано одной таблицей
`MOVES` в `WorktreePanel.jsx`, чтобы два экрана не учили противоположным
жестам. Новых каналов нет: панель сама `window.twig.*` не зовёт вовсе —
`HistoryWorkspace` отдаёт ей готовые действия, а те идут через те же
`stageFile`/`unstageFile`/`stageAll`/`unstageAll`, что и экран staging, и через
тот же `undo.perform`. Отказы тоже те же: массовые действия выключены, пока есть
конфликт (`git add` пометил бы его разрешённым не глядя), а `Unstage all` — ещё
и во время merge/rebase/cherry-pick/revert (это mixed reset, он снёс бы маркер
операции и молча её отменил); пофайловые кнопки при этом работают. Unstage до
первого коммита получает `unborn`, как на экране. После действия **история не
перечитывается**: индекс не двигает ни коммит, ни ref, поэтому зовётся только
`onRepositoryChanged()` (свежий `git status`, из которого и режутся списки) и
перечитывается открытый дифф — staging как раз и переносит файл между его двумя
сторонами. Открытый дифф берётся из `diffRef`, а не из замыкания: обработчик
асинхронный. Ошибку панель показывает у себя, со «Show output».

Git ради этого не запускается: списки режет чистый модуль без импортов
`renderer/src/features/worktree/worktree-summary.js` (грузят Vite и
Node-проверка) — `summarizeStatus` из `repository.status.entries`, которые и так
читаются на каждом обновлении, плюс `summaryChips`/`summaryLabel`/`SECTIONS`/
`conflictCount`. Правило деления — то же, что у `loadWorktree` в
`main/git/worktree.js`, и проверка держит их друг против друга. Единственная
правка в main: `loadWorktreeDiff` возвращает ещё и `text` — тот самый патч, из
которого уже разобраны ханки (второго `git diff` нет, канал `worktree:diff` не
менялся); построчный staging по-прежнему работает по `hunks`.

`selected` получил четвёртое небазовое значение `UNCOMMITTED` (`'uncommitted'`,
экспорт `CommitGraph.jsx`). Оно **не** в `SCREENS`: экраны заменяют граф, а это
его не трогает. `isCommitSelection()` в `HistoryWorkspace` — одно место, где
решается «это oid или нет». Обычный `reload()` его сохраняет (staging из панели
перечитывает историю), а когда дерево становится чистым, выбор сам уходит на
вершину: строки, которую панель описывает, в графе больше нет.

Проверки: `scripts/checks/worktree-summary.mjs` (в `npm test`) — деление на три
списка, оба списка у одного пути, `paths` считает пути, игнор не в счёт,
сортировка, мусор на входе, чипы и подпись, **паритет с `loadWorktree` на живом
`porcelain=v2`** плюс сверка пяти строк его кода (правило не может разъехаться
молча), паритет имён классов с `history.css`, то, что `uncommitted` не попал в
`SCREENS`, что панель не зовёт ни одного канала сама, что направление плюса и
минуса совпадает с экраном staging, что оба массовых отказа на месте, что
`unborn` передаётся, и что после staging история не перечитывается;
`worktree-smoke.mjs` — граф остаётся на экране, чипы `1 changed`/`1 untracked`,
дифф файла в панели с плашкой `Not staged`, **плюс и минус на файле и все три
массовые кнопки с проверкой индекса настоящим `git diff --cached`** (включая то,
что `Unstage all` возвращает новый файл в untracked, а не удаляет его), затем
`Open staging` и прежний сценарий; `history-smoke.mjs` — панель, untracked без
диффа и **без трекинга** (`git status` после просмотра всё ещё
`?? untracked.txt`), `Open staging`; `automations-smoke.mjs` — тот же лишний
клик до staging. Снимки — `artifacts/uncommitted-{dark,light,diff}.png`.
Версия 0.9.1 → **0.10.0** (minor, по поручению пользователя): новая
функциональность, тегом `twig-v0.10.0` уезжает эта правка.

Демо-вкладку можно закрыть (2026-09-21, вне вех): у `workspace-demo` теперь такой
же крестик, как у остальных вкладок, и `Cmd/Ctrl+W` на ней тоже закрывает.
Закрытие **запоминается между запусками** и **ничего не удаляет**: песочница
остаётся на диске, «Show demo workspace» открывает ту же самую, с её историей,
стешем и марками. Раньше вкладка была вечной (`remove` для неё отказывал, а
крестик не рисовался вовсе).

Хранится один флаг `sandboxHidden` в `repositories.json` (`main/store.js`:
`save(repositories, activeId, sandboxHidden = <текущее>)` — обычные записи его
не переворачивают, отсутствие поля в старом файле значит «открыта»). Песочница
по-прежнему **производная** запись, а не строка списка репозиториев:
`decorate()` в `main/git/repository.js` просто не подставляет её, пока флаг
поднят. Заодно закрытая демо **ничего не стоит на старте**: `load()` не зовёт
`ensureSandbox` (то есть не сеет и не проверяет 12 коммитов) и `refreshSandbox`
не запускает `status` — ни одного git-процесса. `setSandboxVisible(true)`
вызывает `ensureSandbox` уже в момент показа. `resetSandbox()` при закрытой
демо отказывает («The demo workspace is closed»), а `remove()` по-прежнему
отказывает всегда: «убрать из списка подключённых» и «закрыть вкладку» — разные
вещи. Канал `sandbox:visible` (1 аргумент, строго boolean, иначе запрос
**отклоняется**), мост `setDemoWorkspaceVisible`.

В `App.jsx`: крестик у демо-вкладки зовёт `setDemoVisible(false)` (через
`demoVisibleRef` — обработчик `Cmd+W` живёт в подписке, её нельзя пересоздавать
на каждый рендер), после закрытия фокус уходит на соседнюю вкладку или на экран
«New repository», и показывается заметка «Demo workspace closed. Settings brings
it back.». Раздел Settings → «Demo workspace» переключается: пока демо открыта —
прежний «Reset demo workspace», когда закрыта — «Show demo workspace» с
пояснением, что песочница цела. Та же кнопка есть на экране «New repository».
Отдельно исправлено следствие: теперь возможно состояние «ни одного
репозитория» (демо закрыта, ничего не подключено) — на старте приложение
открывает вкладку «New repository», а не пустое окно.

Проверки: `scripts/checks/repositories.mjs` (в `npm test`) — демо первой
вкладкой, закрытие прячет её и **не трогает `.git`**, флаг переживает новый
экземпляр сервиса, при закрытой демо `load()` не добавляет ни одной записи в
журнал, `resetSandbox` отказывает, показ возвращает **тот же** oid HEAD, а не
свежий сев; `sandbox-smoke.mjs` — закрытие крестиком в живом Electron, падение
на экран «New repository», заметка, файлы на месте, **перезапуск** приложения с
закрытой демо (журнал не вырос → git на старте не запускался), отсутствие
кнопки Reset, «Show demo workspace» возвращает ту же песочницу с её стешем
(снимок `artifacts/sandbox-closed.png`); `smoke.mjs` — у демо-вкладки есть
крестик и в списке моста появился `setDemoWorkspaceVisible`.
Версия 0.9.0 → **0.9.1** (patch, по поручению пользователя): тегом
`twig-v0.9.1` уезжает эта правка, закоммиченная без бампа.

Консоль открывается на «My» и живёт только внизу (2026-09-21, вне вех): кнопка
`Terminal` из тулбара убрана — консоль и так всегда на виду своей статус-строкой
внизу окна, а `Cmd/Ctrl+J` никуда не делся; второй выключатель наверху только
занимал место. Фильтр журнала переименован: `All` → **Full History**,
`My actions` → **My**, и по умолчанию теперь выбран **My**. Правило «чьё это»
переехало из инлайнового `!operation.startsWith('Background')` в чистый модуль
без импортов `renderer/src/app/command-source.js` (грузят Vite и Node-проверка):
`isUserCommand(operation)` отбрасывает `Background: …`, `Read …`, `Resolve …`,
`Verify …` и поимённо `Check file at start`, `Check reverse-blame range`,
`Search commit history`, `Seed demo workspace`. Префикса `Check ` быть не может —
`Check out branch` это настоящее действие; пустая подпись остаётся в «My»
(команда всё-таки выполнялась). В «My» остаются commit/amend, checkout, merge,
rebase, cherry-pick, revert, reset, staging, stash, ветки и теги, pull/push,
clone, blame, автоматизации, Undo/Redo и всё, что набрано в строке консоли; все
чтения, которыми 🌱 Twig сам рисует граф, refs и рабочее дерево, видны только в
Full History. Пустой экран под «My» так и говорит: «Nothing you ran yet. Full
History also shows what 🌱 Twig runs on its own.» «Show output» по-прежнему
переключает фильтр на Full History — иначе нужная запись могла бы быть отфильтрована.
Git не вызывается, новых IPC/таймеров/сети нет: изменился только рендер уже
полученного журнала. Проверки: `scripts/checks/console-focus.mjs` (в `npm test`)
— классификация ~50 подписей, паритет с подписями из `main/git/*.js` (новое
автоматическое чтение обязано быть названо явно), старт на `mine`, имена кнопок
и отсутствие `Terminal` в тулбаре; `smoke.mjs` — в тулбаре кнопки нет, консоль
открывается на My, стартовая проверка Git не показана и появляется по Full
History; `history-smoke.mjs` — набранная команда видна в «My», чтение графа
(`--topo-order`) — только в Full History. Смоук-скрипты жмут консоль за её
статус-строку (`.console-status`), а не за кнопку тулбара. Заодно починены два
устаревших локатора в `blame-smoke.mjs` (`M code.txt` → `Modified code.txt`):
бейдж статуса файла получил `aria-label` ещё в 2026-09-08, а тест остался
со старым именем и падал независимо от этой правки.
Версия 0.8.9 → **0.9.0** (minor, по поручению пользователя): тем же тегом
`twig-v0.9.0` уезжает и эта правка.

Журнал больше не растёт без предела (2026-09-16, вне вех): приложение
перестало запускаться — `🌱 Twig failed to start: Invalid string length`.
`command-log.jsonl` в `userData` дорос до 882 МБ, а `CommandLog.load()` читал его
одной строкой: у V8 потолок строки ~512 МБ. Две причины и две правки в
`main/command-log.js`. Первая: журнал append-only, а обрезался только список в
памяти (2000 записей) — файл не обрезался никогда. Теперь `load()` читает файл
**построчно** (`createReadStream` + `readline`, ENOENT гасится на потоке, а
readline его только повторяет) и в конце **уплотняет** файл: перезаписывает его
минимальным журналом, который воспроизводит ровно оставшиеся записи
(`start` + `output` + `finish` на запись), атомарно через `.tmp` + `rename`.
То же самое происходит в сессии, когда с момента последнего уплотнения дописано
больше `COMPACT_BYTES` (16 МБ). Вторая: вывод одной команды не ограничивался
вовсе — 265 МБ из тех 882 дали страницы `git log`, перечитываемые рефрешами.
Теперь на каждый поток записи `MAX_STREAM` = 256 КБ, дальше чанк не пишется ни
в память, ни в файл, а в конце обрезанного вывода стоит «… output truncated by
🌱 Twig at 256 KB.». Обрезанный чанк уходит и слушателям (`console:update`),
поэтому renderer и main видят одно и то же. Живьём: 882 МБ загрузились за 472 мс
и файл стал 34 МБ, приложение стартовало. Проверки в `scripts/checks/git-exec.mjs`
(в `npm test`): 8 МБ вывода одной команды дают < 300 КБ в записи и < 2 МБ в файле,
перезагрузка компактного журнала даёт те же записи, а журнал на 2400 команд
загружается, оставляет последние 2000 и уменьшает файл.
Версия 0.8.7 → **0.8.8** (patch, по поручению пользователя): тем же тегом
уезжают перенос плашек, номера строк в диффе и неразрушающий авторефреш.

**Непрошеный рефреш ничего не закрывает** (2026-09-16, вне вех): `reload()`
принимает `{ keepView: true }` — в этом режиме он не трогает `selected`,
`selection`, `range`, `diff` и `fileHistory`, а перечитывает только refs, стеши,
марки и граф. Именно так зовут его watcher и возврат фокуса: раньше сворачивание
и разворачивание окна закрывало открытую панель коммита (дифф, историю файла) и
перекидывало выбор на вершину. Панель адресует содержимое по oid и пути и
перечитывает его сама, поэтому оставить её смонтированной безопасно даже если
коммит переписали — она скажет об этом, а граф просто не подсветит строку. Наши
собственные действия (checkout, rebase, кнопка Refresh) по-прежнему зовут
`reload()` без флага: там старый выбор устарел намеренно.

Номера строк в просмотре изменений (2026-09-16, вне вех): у каждой строки диффа
слева теперь два столбца — номер на старой стороне и на новой, как в редакторах.
Считаются из заголовка ханка (`@@ -10,4 +20,5 @@`) — единственного места, где
патч их называет: удалённая строка двигает старую сторону, добавленная — новую,
контекст обе; сам заголовок, `\ No newline at end of file` и шапка файла номера
не получают. Завершающий перевод строки патча больше не даёт пустую строку в
конце (раньше она рисовалась пустым `div`, теперь бы ещё и получила номер).
`annotatePatch` в `renderer/src/features/diff/intraline.js` добавляет к каждой
строке `oldLine`/`newLine`; `DiffLines.jsx` рендерит `.diff-gutter` с двумя
`.diff-line-number`, ширина каждого столбца — по самому длинному номеру этого
диффа (`--diff-old-digits`/`--diff-new-digits` в `ch`), поэтому код начинается с
одной колонки. Полоса номеров липнет к левому краю (`position: sticky`) при
горизонтальной прокрутке и не попадает в выделение (`user-select: none`), чтобы
копирование диффа не тащило номера. Отдельная заливка `--surface` и правая
граница; новых токенов нет. Git не вызывается, новых IPC/таймеров/сети нет —
только рендер уже полученного патча. Тем же путём номера появились в стешах и
в blame-детали (общий `DiffLines`); построчный staging (`StageDiff`) свои номера
имел и раньше. Проверки: `scripts/checks/intraline.mjs` (нумерация контекста/
удаления/добавления, второй ханк со своим счётом, `-0,0` у нового файла, строки
вне ханка, хвостовой перевод строки, паритет имён классов с CSS и JSX);
`history-smoke.mjs` — в реальном DOM у удалённой строки номер только слева, у
добавленной только справа, у заголовка ханка номеров нет.

macOS-сборка ad-hoc подписывается (2026-09-15, вне вех): DMG 0.8.6 и всех
более ранних версий устанавливался как «App is damaged and can't be opened»
на Apple Silicon (arm64) — не обходимое предупреждение Gatekeeper, а жёсткий
отказ ядра запускать полностью неподписанный код (на этот счёт с macOS 11
на arm64 действует более строгое правило, чем на Intel, где неподписанный
билд обычно ещё можно открыть через ПКМ → Open). Причина — `build.mac.identity`
в `package.json` явно `null` (платного Apple Developer ID нет), а
`release.yml` дополнительно ставит `CSC_IDENTITY_AUTO_DISCOVERY=false`;
`identity: null` — по коду `macPackager.js` electron-builder — значит «не
подписывать вовсе», без отката на ad-hoc, и по той же причине `afterSign`
electron-builder никогда не срабатывает (`doSignAfterPack` вызывает его,
только если реальная подпись произошла). Лечение — в `scripts/after-pack.mjs`
(этот хук выполняется всегда, независимо от того, подписал ли electron-builder
приложение сам): для `electronPlatformName === 'darwin'` запускается
`codesign --force --deep --sign - <appOutDir>/<productFilename>.app` —
ad-hoc-подпись без identity и entitlements, только чтобы ядро приняло код.
После неё `codesign --verify --deep --strict` отвечает «valid on disk», а
Gatekeeper переходит к обычной проверке Developer ID/нотаризации и показывает
привычное преодолимое предупреждение вместо отказа. `identity: null` в
конфиге остался как есть — платной подписи по-прежнему нет, изменилось
только то, что происходит после неудачи её найти. Живая проверка:
`npm run pack:mac` на macOS arm64 — оба архива (`mac-arm64`, `mac`) получили
`flags=0x2(adhoc)` и прошли `codesign --verify --deep --strict`. Проверка
`scripts/checks/after-pack.mjs` (в `npm test`) собирает фейковый `.app`-бандл
(валидный `Info.plist` + Mach-O `/usr/bin/true` вместо бинаря) и требует,
чтобы `codesign --verify --deep` его принял; на не-macOS хосте эта часть
пропускается (`codesign` есть только на macOS, а собрать mac-таргет тоже
можно только на macOS). Версия 0.8.6 → **0.8.7** (patch, тем же тегом
уезжает и фикс).

Ветки и теги переносятся по строкам, а не прячутся за «+N» (2026-09-14, вне вех):
столбец `Branch / tag` показывал две плашки и заглушку `+N` — число вместо имён.
Теперь показываются **все** ссылки: плашки переносятся на столько строк, сколько
нужно, а сама строка коммита становится выше (у ячейки `padding-block`, узел
графа и дорожки центрируются по фактической высоте). Перенос считается заранее,
а не отдаётся `flex-wrap`: виртуализованному списку высота строки нужна **до**
отрисовки. Чистый модуль без импортов `renderer/src/features/graph/ref-lines.js`
(грузят Vite и Node-проверка): `badgeWidth` (хром плашки + ширина имени),
`packRefLines` (жадная укладка слева направо; `lead` — место, занятое галкой HEAD
и марки на первой строке; плашка шире столбца получает свою строку и обрезается
там, а не исчезает), `extraHeight`. Ширина имени меряется `canvas.measureText`
тем же шрифтом (10px `--font-ui`), кэш на имя, перемер один раз по
`document.fonts.ready`; без canvas — оценка по числу символов. В `layout.js` —
`createRowMetrics(extras)`: высоты хранятся **разреженно** (`[индекс, добавка]`
только для высоких строк), `top`/`height`/`totalHeight`/`range` идут бинарным
поиском, поэтому 100k коммитов по-прежнему считаются за миллисекунды и без
массива на 100k. `segmentPath(segment, height)` рисует дорожки от высоты строки.
Git не вызывается, новых IPC/таймеров/подписок/сети нет. Проверки:
`scripts/checks/graph.mjs` (в `npm test`) — укладка строк, совпадение разреженных
метрик с наивной префиксной суммой, окно видимых строк внутри высокой строки,
пути дорожек на высоте 48, «ни одна ссылка не потеряна»; `history-smoke.mjs` —
у вершины пять ссылок, в DOM названы все, `+N` нет, `.ref-line` больше одной,
строка выше соседней, следующая строка начинается ровно под ней, каждая плашка
внутри своей строки.

Linux-сборки запускаются на хосте с более новым fontconfig (2026-09-14, вне вех):
AppImage на Gentoo падал сразу после старта — `Could not find any font: Sans, sans`
и `FATAL:SkFontMgr_FontConfigInterface.cpp: Not implemented`. Причина не в сборке:
Electron несёт **свой** fontconfig (2.17, кэш v11), а система пишет кэши
новым (2.18, v12); старый читатель отказывается и читать такие кэши, и
перегенерировать их («We will not regenerate the cache because some cache files
were generated by a newer version»), считает все каталоги шрифтов пустыми — и
Chromium умирает на первом же тексте. Тот же класс бага известен по Brave и
Spotify. `NODE_OPTIONS` в логе — только шум: Electron их игнорирует в упакованном
приложении, но печатает ERROR на каждый старт.

Лечение — в упаковке, а не в коде приложения: хук `afterPack`
(`scripts/after-pack.mjs`, только `linux`) переносит бинарь Electron в
`twig.bin`, а на его место кладёт bash-лаунчер (его имя и зовут AppRun у
AppImage и `.desktop`-запись у deb). Лаунчер снимает унаследованный
`NODE_OPTIONS` и подставляет `FONTCONFIG_FILE`/`FONTCONFIG_PATH` на
`build/fontconfig/fonts.conf`, скопированный в `etc/fonts/` рядом с бинарём
(`FONTCONFIG_SYSROOT` снимается, иначе он переприклеил бы все пути). Единственное
отличие этого конфига от системного — **свой каталог кэша**
(`<cachedir prefix="xdg">twig/fontconfig</cachedir>` → `~/.cache/twig/fontconfig`):
там лежат кэши, написанные нашим же fontconfig, поэтому конфликта версий быть не
может. Каталоги шрифтов перечислены обычные (плюс flatpak-овские `/run/host/…`),
настройки хоста (хинтинг, сглаживание, алиасы) подтягиваются через
`<include ignore_missing="yes">/etc/fonts/conf.d</include>`, в конце — запасные
generic-семейства. Шрифты внутрь сборки не кладутся: у хоста они есть, ломался
только их поиск. Отказ от подмены — `TWIG_SYSTEM_FONTCONFIG=1` в окружении.
Ни сети, ни новых зависимостей, ни изменений в `main/`/renderer.
Проверка `scripts/checks/after-pack.mjs` (в `npm test`): бинарь переименован,
лаунчер на его месте и исполняемый, `bash -n` его принимает, конфиг совпадает с
файлом в репозитории (копия не может разъехаться), один-единственный `cachedir`,
повторный прогон хука не заворачивает лаунчер сам в себя, macOS/Windows не
тронуты. Живьём собран `electron-builder --linux AppImage` (arm64, на macOS):
`release/linux-arm64-unpacked/twig` — это лаунчер, `twig.bin` — Electron,
`etc/fonts/fonts.conf` на месте. **Сам запуск на Gentoo проверяет пользователь:**
Linux здесь не запускался.

«Show output» ведёт к самой ошибке (2026-09-14, вне вех): кнопка рядом с
сообщением об ошибке (рабочее дерево, панель коммита, ветки, стеши, blame,
настройки, автоматизации) раньше просто открывала консоль — запись с провалом
приходилось искать глазами среди тысяч. Теперь она **раскрывает** нужную запись:
фильтр сбрасывается (`All`, пустой поиск), запись разворачивается с выводом,
скроллится в вид, получает фокус клавиатуры и подсветку (`.console-entry.focused`
— тот же `--danger`, тинт `color-mix` 12 %, разовая анимация 900 мс; снимается
при открытии другой записи). Тем же путём идут автооткрытия консоли после
провала sync/undo/stash/reset песочницы. Чистый модуль без импортов
`renderer/src/app/console-focus.js` (грузят Vite и Node-проверка):
`pickFailedEntry` — **самая свежая** запись с ненулевым кодом, перешагивая
успешные, которые успели пройти после неё (наш же reload); идущие команды не
считаются провалом; провал старше 60 с (`FOCUS_WINDOW_MS`) или с нечитаемой
датой даёт `null` — консоль тогда просто открывается, а не показывает пальцем на
чужую ошибку. `App` читает журнал через `entriesRef`, а не через замыкание, чтобы
асинхронный обработчик не взял устаревший список. Новых IPC, запусков Git,
таймеров и сети нет; `requestAnimationFrame` один на нажатие и отменяется.
Проверки: `scripts/checks/console-focus.mjs` (в `npm test`) — выбор записи,
окно давности, паритет с Console.jsx/layout.css/App.jsx; `browse-smoke.mjs` —
отказ `branch -d` на неслитой ветке, нажатие «Show output», и в DOM именно эта
команда подсвечена и раскрыта (снимок `artifacts/m5-console-focus.png`).

Ручная проверка обновлений (2026-09-14, вне вех): в Settings — раздел
«Updates» с кнопкой **Check for updates**. По нажатию (и только по нему) main
делает **один** запрос к `https://api.github.com/repos/kitarasenka/twig/releases/latest`
и сравнивает тег (`twig-v<version>`) с `app.getVersion()`. Ни фоновых проверок,
ни таймеров, ни скачивания, ни установки, ни телеметрии: наружу уходит только
`User-Agent: Twig/<version>` и `Accept`, никаких токенов и идентификаторов.
Ответ — «эта версия последняя» / «доступна X» / причина отказа, плюс ссылка на
Releases, которую открывает существующий `will-navigate` → `shell.openExternal`.
Чистый модуль без импортов `main/update-check.js` (грузят main и Node-проверка):
`parseVersion` (принимает `twig-v0.8.3`/`v0.8.3`/`0.8.3`, отвергает пререлизы и
мусор), `compareVersions`, `interpretRelease` (**URL из ответа сети доверяется
только если он начинается с `https://github.com/kitarasenka/twig/releases/`**,
иначе подставляется страница Releases; нераспознанный тег — `unknown`, а не
догадка), `checkForUpdate` (инъекция `fetch` ради теста, `redirect: 'error'`,
дедлайн 10 с через `AbortController` + `clearTimeout` в `finally` — не
`AbortSignal.timeout`, иначе таймер держит event loop). Канал
`app:check-update` в `main/ipc.js` проверяет sender/frame/0 аргументов и
переиспользует незавершённый запрос, если нажать дважды. CSP рендерера не
трогали: запрос делает main, renderer в сеть по-прежнему не ходит.
Проверки: `scripts/checks/update-check.mjs` (в `npm test`, **без сети**:
разбор тегов, сравнение, враждебные `html_url`, форма запроса, 404/503/битый
JSON/офлайн/таймаут), `smoke.mjs` — кнопка есть и доступна, но **не нажимается**
(прогон обязан остаться без сетевых вызовов). Версия остаётся 0.8.3.

Версия в README не разъезжается (2026-09-14, вне вех): `scripts/checks/version.mjs`
(первым в `npm test`) сверяет `package.json`, оба поля `package-lock.json` и
строку «Current version: X.Y.Z» в `README.md`. Сайт править не нужно:
`site/build.mjs` подставляет `{{version}}` из `package.json`, а Pages-воркфлоу
срабатывает на изменение `package.json`.

Переезд в отдельный репозиторий + публикация лендинга на GitHub Pages
(2026-09-08, вне вех): GitHub Pages для приватного репозитория требует
Enterprise, поэтому весь `modules/git_desk` выделен в публичный
`github.com/kitarasenka/twig` через `git subtree split --prefix=modules/git_desk`
(13 коммитов M0…M6 + один импорт-коммит с незакоммиченной «вне вех» работой:
реальная песочница, портативные сборки, редизайн сайта, регулируемые столбцы,
бейдж статуса файла, построчный дифф, ref-операции в меню). Монорепо-копия
`nodes-managers/modules/git_desk` пока оставлена как есть.

Воркфлоу `.github/workflows/site.yml` собирает `site/dist` и деплоит его на Pages
при push в `main` по путям `site/**`, `package.json`,
`renderer/src/ui/tokens.css` и самого воркфлоу, плюс `workflow_dispatch`.
Job `build`: `npm ci --omit=dev` c `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (для
`build:site` нужны только `@fontsource/fira-sans` и `tokens.css` из репо, не
electron/vite/playwright), затем `build:site` с
`TWIG_SITE_DOWNLOAD_BASE=https://github.com/${{ github.repository }}/releases/download/twig-v<version>/`,
`upload-pages-artifact`; job `deploy` — `actions/deploy-pages` (нативный Pages
этого же репозитория, репозиторий публичный). Concurrency-group
`pages`, `cancel-in-progress: false`. Разово в Settings → Pages выбрать source
«GitHub Actions».

`site/build.mjs`: новая переменная `TWIG_SITE_DOWNLOAD_BASE` — абсолютный
`https://`-префикс для кнопок скачивания вместо соседнего `downloads/` (по
умолчанию). Значение нормализуется (хвостовой `/`) и проверяется регэкспом
`^https://<host>(/<seg>)*/$`; не-`https` или подозрительный путь роняет сборку.
Имена файлов приписываются к базе как раньше и по-прежнему проходят
`^[a-zA-Z0-9._-]+$`. Установщики на Pages не помещаются (~1 ГБ на сайт против
восьми сборок Electron), поэтому бинарники — ассеты GitHub Release с тегом
`twig-v<version>`; до публикации Release кнопки отдают 404 (то же, что при
самостоятельном хостинге до загрузки файлов). Порядок выпуска в
`site/README.md` (раздел «GitHub Pages»).

`site/check.mjs`: download-ссылки теперь могут быть кросс-доменными.
`downloadUrl`/`isDownload` резолвят href из `downloads.json` относительно origin;
route-перехват фикстуры и фильтр внешних запросов (обе страницы) сверяются с этим
множеством, а не с глобом `**/downloads/*`. Проверка прогнана локально в обоих
режимах (относительный `downloads/` и абсолютный Release-URL), 8 ссылок,
без утечки внешних запросов; `eslint site/build.mjs site/check.mjs` чист.
Живьём воркфлоу запускается после первого push в новый репозиторий; в Settings →
Pages должен быть выбран source «GitHub Actions». Версия остаётся 0.8.0.

Сайт: конкретные преимущества и анимации (2026-09-08, вне вех): переработаны
`site/index.html` и `site/style.css`. Первый экран — три переключаемых примера
(автоматизация блокирует push, предпросмотр merge, локальная марка с заметкой).
Главные акценты: визуальные автоматизации, марки, журнал и реальная песочница;
rebase/staging/конфликты/blame — отдельный основной набор. Убраны лозунги и
неподтверждённые обещания скорости. Сравнение официальных сайтов GitKraken,
Fork, Tower, Sourcetree, GitHub Desktop и основания утверждений лежат в
`site/COMPETITORS.md`; исключительность возможностей не заявляется.

`site/site.js` — небольшой локальный скрипт без зависимостей: ARIA-вкладки
(стрелки/Home/End, панель получает фокус по Tab) и одноразовый IntersectionObserver
для появления секций. Нет автопереключения/опроса/бесконечных анимаций.
Reduced motion выключает движение, включая изменение настройки в открытой
вкладке. Без JS все примеры видны подряд, якоря и загрузки работают.
CSP разрешает только свой скрипт; `preview.mjs` отдаёт `.js` с корректным MIME.
При сборке `tokens.css` берётся из приложения, селектор светлой темы расширен
с root до контейнера секции — палитра больше не дублируется в CSS лендинга.
Снимок `site/assets/workspace.png` обновлён из `artifacts/sandbox-dark.png`:
реальная песочница, регулируемые столбцы и статусы файлов. Иллюстрации на сайте
отдельно подписаны, Git-команды не выполняются. Ранее записанное «без клиентского
JavaScript» относится к первоначальному лендингу и больше не актуально.

Проверки этой правки: `npm run build:site`, ESLint для `site/*.mjs`/`site/site.js`
и `git diff --check` прошли. Chromium проверил 375/768/1024/1440 px: без JS по
HTTP, с JS — локальную сборку `site/dist/index.html`; все вкладки, клавиатуру,
стабильную высоту примеров, отсутствие переполнения, смену reduced motion,
ресурсы, якоря и восемь ссылок (ответы установщиков — фикстуры, не бинарники).
Просмотрены снимки `artifacts/site-desktop.png`, `site-mobile.png` и полные страницы.

Аудит безопасности: только статический HTML и локальный JS, CSP без inline/eval,
нет форм, fetch, cookies/storage, исполнения команд и новых зависимостей.
Аудит производительности: анимации конечные, нет таймеров/опроса; observer
отключается для показанной секции и на pagehide, учитывает reduced motion.
Снимок загружается лениво; исходные ресурсы локальные, фото-генерация не нужна.


Авторефреш при изменениях извне (2026-09-08, вне вех): раньше история
перечитывалась только после действия внутри 🌱 Twig или по кнопке Refresh —
коммит/checkout/fetch из терминала оставались невидимыми. Теперь `main` следит
за git-каталогом активного репозитория и шлёт renderer событие, по которому
`HistoryWorkspace` перечитывает граф, refs, стеши, марки и состояние операции.
**Это не опрос:** один `fs.watch` (`persistent: false`) на git-каталог,
дебаунс 300 мс, ни одного `setInterval`. Событийная модель, как у уже
существующего `onUndoUpdate`. Чистый модуль `main/repo-watch.js` (без импортов
`electron`, чтобы Node-проверка гоняла его напрямую): `resolveGitDir`
(`.git`-каталог или файл-указатель `gitdir:`, без запуска Git),
`isWatchedPath` (реагируем на `HEAD`/`ORIG_HEAD`/`*_HEAD`/`packed-refs` и
каталоги `refs`/`logs`/`rebase-*`/`sequencer`; `index` и `*.lock` игнорируются —
`git status` внутри нашего же reload переписывает `index`, это была бы петля),
`createRepositoryWatcher(getWindow)` (`watch(cwd|null)`, `stop`, `watching`).
IPC-канал `repo:watch` в `main/ipc.js` резолвит репозиторий только по
сохранённому списку и переключает единственный watcher вслед за активной
вкладкой; renderer зовёт его из `App.jsx` по активному репозиторию (в т. ч.
песочница), `null` — когда репозиторий не открыт. `preload`: `watchRepository`
и `onRepositoryChange`. В `HistoryWorkspace` эффект слушает событие только для
активной вкладки и ещё `blur`→`focus` с реальным отсутствием > 1.5 с (запас на
`git add`, который в `.git` не пишет, и на платформы без `fs.watch`);
`run()` пропускается, если идёт наша операция (`working`/`dropRunning`/
`execution`/`conflict`/git-drag) или наш reload был < 1.2 с назад
(`lastReload`-штамп в `reload()` — глушит собственное эхо от переноса HEAD).
Новых таймеров опроса, подписок и сети нет; git не запускается ни на hover, ни
на событие watcher (только тот же `reload`, что и по кнопке). Проверки:
`scripts/checks/repo-watch.mjs` (в `npm test`) — `isWatchedPath`, `resolveGitDir`
на настоящем temp-`.git` (каталог, `gitdir:`-файл, отсутствие), реальный
`fs.watch`: событие на смену ref'а, дебаунс, `.lock` молчит, `watch(null)`
глушит; `history-smoke.mjs` — коммит из внешнего `git` появляется в графе без
кнопки Refresh. Версия остаётся 0.8.0.

Регулируемые по ширине столбцы истории (2026-09-08, вне вехи): у всех пяти
столбцов графа — `Branch / tag`, `Graph`, `Commit message`, `Author`, `Date` —
на правом краю появился маркер перетаскивания; тянешь вправо — столбец шире.
`Graph` особый: по умолчанию (`defaultWidth: null`) считается от числа дорожек;
drag фиксирует его ширину, двойной клик / `Home`/`Enter` возвращают `null` и
авторазмер. Все остальные столбцы, включая `Commit message`, — обычные
фиксированные ширины (`var(--col-*)`); слабину добирает **хвостовой трек**
`minmax(0, 1fr)` шестой колонкой грида (без своего span), поэтому ползунок на
правом крае столбца тянет именно этот столбец сразу и заметно, а горизонтальный
скролл появляется только когда колонки перерастают панель. Шапка
(`.real-history-columns` — сосед скроллера, а не его потомок) сдвигается вручную
по `scrollLeft` через `transform` в `onScroll`, чтобы не разъехаться с телом.
`--table-min-width` (сумма фикс-ширин + `var(--graph-width)` + padding, без
`1fr`) задаёт `min-width` и шапке, и `.virtual-commits`. Заголовки столбцов центрированы
(`justify-content: center` на `.real-history-columns > span`). Маркер —
`<span role="separator" aria-orientation="vertical" tabIndex=0>` в ячейке шапки:
pointer-drag с `setPointerCapture`, `←`/`→` (шаг 12 px, `→` всегда расширяет),
`Home`/`Enter` и двойной клик — сброс к дефолту; `aria-valuenow/min/max`.
Ширины лежат в `localStorage` (`twig:history-columns`, JSON
`{branch,graph,message,author,date}`, `graph` = число или `null`, `message` —
реальная ширина, а не минимум) по образцу
`twig:commit-colors`/`twig:commit-details`; чтение и запись в try/catch,
значение вне диапазона подтягивается в него на чтении. На ≤1250 px столбец
`Author` (и его маркер) уже скрыт прежним `.author-col { display: none }` (плюс
явный `.real-history-columns > .author-col { display: none }` — новый `> span`
перебивал бы его по специфичности) — шаблон грида и `--table-min-width` там на
4 дорожки. Чистый модуль без импортов
`renderer/src/features/graph/column-widths.js` (грузят Vite и Node-проверка):
`HISTORY_COLUMNS` (min/max/default по столбцу, у `graph` default `null`),
`clampColumnWidth` (нечисло → default, у `graph` это `null`),
`normalizeColumnWidths`, `read/writeColumnWidths`, `dragColumnWidth`,
`nudgeColumnWidth`. Grid-шаблон в `history.css` — на
`var(--col-branch) var(--graph-width) var(--col-message) var(--col-author) var(
--col-date) minmax(0,1fr)` с дефолтами на `.real-history`; `CommitGraph`
считает `graphWidth = columns.graph ?? auto` и проставляет `--*` инлайном. Git
не вызывается, новых IPC/таймеров/подписок/сети нет. Проверки:
`scripts/checks/column-widths.mjs` (в `npm test`) — клампы, drag, `graph`-null,
нормализация, round-trip и падающий storage; `history-smoke.mjs` тянет маркеры
`Branch / tag`, `Commit message`, `Graph`, проверяет рост
`--col-branch`/`--col-message`/`--graph-width` и что они пережили перезагрузку,
а двойной клик по `Graph` вернул авторазмер. Версия остаётся 0.8.0.

Детали коммита скрыты по умолчанию (2026-09-08, вне вех): в панели коммита при
открытии видны только заголовок (subject), список файлов и дифф. Тело сообщения
(`.commit-body`), карточка автора и метаданные (`Authored` / `Committed` /
`Parents`) свёрнуты за кнопкой `Show details` / `Hide details` (`.details-toggle`,
обычный `.text-button` под заголовком). Выбор запоминается в `localStorage`
(`twig:commit-details`, `show`/`hide`) по образцу темы и `twig:commit-colors` —
коммит открывается так же, как в прошлый раз; чтение и запись в try/catch. Режим
сравнения (`range`) кнопки не показывает и всегда рендерит эти блоки. Git не
вызывается, новых IPC/токенов/таймеров нет. `ops-smoke.mjs` перед снимками тем
жмёт `Show details`, чтобы на ревью-картинках были автор и сообщение. Версия
остаётся 0.8.0.

Цветной бейдж статуса файла (2026-09-08, вне вех): буква статуса перед путём
изменённого файла (панель коммита, рабочее дерево, файлы стеша) теперь —
залитый скруглённый квадратик: буква в `var(--bg)` на заливке `--mark-*`, свой
цвет на каждый статус — added/untracked `--mark-green`, modified `--mark-amber`,
deleted/conflict `--mark-red`, renamed/copied `--mark-blue`, type-change
`--mark-violet`, прочее `--mark-slate`. Переиспользует те же шесть токенов марок
ровно как узлы графа (заливка цветом марки, глиф в `--bg`); новых токенов нет.
Цвет не единственный носитель: буква сама называет статус, у каждого бейджа
`title`/`aria-label` («Added», «Modified», …). Чистый модуль без импортов
`renderer/src/features/diff/file-status.js` (`FILE_STATUS`, `fileStatus` —
нормализация: ведущая буква, `R100`→`R`, `?`→untracked, пробел/неизвестное →
нейтральный) грузят Vite и Node-проверка; общий компонент
`renderer/src/features/diff/FileStatus.jsx` заменил три копии
`<span className="file-status">`. Git не вызывается, новых IPC/таймеров/сети нет.
Проверка `scripts/checks/file-status.mjs` (в `npm test`): нормализация, паритет
имён классов с `history.css` (каждый класс залит токеном марки), контраст `--bg`
на каждой заливке ≥ 3:1 в обеих темах (тот же порог, что у марок в
`foundation.mjs` — глиф это жирный однобуквенный бейдж с дублирующей текстовой
подписью). Версия остаётся 0.8.0.

Построчный дифф изменённых частей строки (2026-09-08, вне вех): в диффе строки,
которую хунк одновременно удаляет и добавляет обратно, теперь подсвечивается
**только изменившийся фрагмент**, а не вся строка. Дифф идёт по **токенам**
(слова, пробелы, одиночная пунктуация), а не по сырым символам: вставка
`runAutomation = null, ` перед `onConsole` подсвечивает ровно этот фрагмент, а не
раскидывает общие буквы `o`/`n`/`s` по строке (первый заход был посимвольным и
на реальных правках кода давал мусор). Заменённый токен, который лишь слегка
поправили («сорока» → «сорок»), затем уточняется до символа. Цвет не единственный
носитель: добавленное подчёркнуто, удалённое — зачёркнуто
(`.diff-seg-add` / `.diff-seg-del`, лёгкий `color-mix` 26 % / 34 % от `--accent` /
`--danger` на `var(--text)`, как у марок; новых токенов нет; тинт нарочно слабый,
чтобы текст держал 4.5:1). Ядро — чистый модуль без импортов
`renderer/src/features/diff/intraline.js` (грузят Vite и Node-проверка):
`segmentPair` — токенайзер + LCS по токенам + `refine` (пара delete→insert
уточняется посимвольно, если общего ≥ 25 %) → сегменты `same/del/add`, возвращает
`null`, если строки равны, длиннее 400 символов или общего меньше 20 % (это уже
переписывание — тогда красится вся строка); `segmentHunkLines` — пары k-я
удалённая ↔ k-я добавленная в одном подряд идущем блоке; `annotatePatch` — то же
для сырого текста патча, строки до первого `@@` (`diff --git`, `index`,
`---`/`+++`) никогда не парятся. Общий компонент `renderer/src/features/diff/
DiffLines.jsx` заменил три копии `patch.split('\n').map(...)` в `HistoryWorkspace`
(панель коммита / история файла), `StashScreen` и `BlameDetail`; `StageDiff`
(построчный staging) рендерит сегменты в `.line-text`. Git не вызывается, новых
IPC/таймеров/сети нет — только рендер уже полученного патча. Проверки:
`scripts/checks/intraline.mjs` (в `npm test`) — реконструкция обеих сторон из
сегментов, guard'ы длины и похожести, парность в хунке и патче, паритет имён
классов с CSS; `history-smoke.mjs` дополнительно проверяет `.diff-seg-add/-del`
в реальном DOM на правке hello.txt на вершине. Версия остаётся 0.8.0
(см. запись про 0.8.0 ниже — до 1.0.0 не бампаем во время проверки).

Ref-операции в контекстном меню коммита (2026-09-08, вне вех): раньше меню
графа (§8.2) только *создавало* ветки/теги, а удаление/переименование/upstream/
публикация жили лишь на экране «Branches and tags». Теперь для каждой ссылки,
которая указывает на этот коммит (её плашка на строке), меню добавляет полный
набор с того экрана: локальная ветка — `Rename …`, `Set upstream for …`,
`Publish … to <remote>` (по пункту на remote, если их >1), `Delete` (у текущей
ветки пункт есть, но выключен — «checked-out branch cannot be deleted»);
remote-ветка — `Check out … as a new branch…`, `Delete … on its remote`;
тег — `Publish … to <remote>`, `Delete tag …`, `Delete … on <remote>`.
Пункты без настроенного remote не показываются. Все мутирующие идут через тот
же §6.5-диалог, что и на экране: удаление слитой ветки — сразу `branch -d`,
отказ открывает `-D`; удаление на remote — `sync:push-ref --delete`; публикация —
`sync:push-ref` без force. Никаких новых IPC-каналов и git-путей: те же
`window.twig.deleteBranch/renameBranch/setUpstream/deleteTag/pushRef/createBranch`.
`buildCommitMenu` получил параметр `remotes` (список имён); `UpstreamDialog`
вынесен из `RefsScreen.jsx` как экспорт и подключён к `dialog` типа `upstream`
в `HistoryWorkspace`. `commit-menu.js` — `renderer/src/features/refs/remote-ref.js`
(`splitRemoteRef`, `pushRefCommand`) переиспользуется для команд в диалоге.
Проверки: `history-ops.mjs` — новые кейсы applicability (пункты появляются
только при наличии ссылки, publish требует remote, текущая ветка не удаляется,
mid-operation всё выключено); `ops-smoke.mjs` — меню на ветке показывает
Rename/Delete, создание ветки `scratch` из меню и её удаление из меню (реальный
`branch -d` + перезагрузка графа). `npm test` и `ops-smoke` зелёные. Версия не
бампалась (см. запись про 0.8.0 ниже).

Версия с датой и патчноуты выпусков (2026-09-14, вне вех): в шапке сайта
(первая строка героя) теперь `ДЕСКТОПНЫЙ GIT-КЛИЕНТ · v0.8.4 · 14 СЕНТЯБРЯ 2026`,
а перед блоком скачивания — секция `#whats-new` «Что нового в X.Y.Z» со списком
изменений выпуска и свёрнутыми тремя предыдущими. Источник — новый
`CHANGELOG.md` (русские пользовательские строки, раздел
`## <версия> — <дата>`), тот же текст уходит в тело GitHub Release.
Дата выпуска хранится как `releaseDate` (`YYYY-MM-DD`) рядом с `version` в
`package.json`: форматируется один раз при сборке (`Intl`, ru-RU, без «г.»), на
странице остаётся статический `<time datetime=…>` — клиентских часов и локалей
нет. Чистый модуль без зависимостей `scripts/changelog.mjs` (`formatDate`,
`parseChangelog`, `pickRelease`, `releaseNotes`) грузят `site/build.mjs`,
`scripts/checks/version.mjs` и `scripts/release-notes.mjs` — последний печатает
раздел версии, и `release.yml` отдаёт его в `gh release create --notes-file`
вместо `--generate-notes` (список коммитов релиз читает человек, а не машина);
раздела нет — воркфлоу падает до публикации. `version.mjs` (первым в `npm test`)
дополнительно требует: `releaseDate` — настоящая дата, верхний раздел
CHANGELOG — это текущая версия с той же датой и непустым списком, версии не
повторяются. `site.yml` пересобирает Pages и на изменение `CHANGELOG.md`.
`.eyebrow` получил `flex-wrap: wrap` (в строке теперь два элемента, на 375 px
иначе был бы горизонтальный скролл), дата поднимается в верхний регистр только
через CSS. `site/check.mjs`: локаторы `details` стали адресными
(`.install-help` / `.release-history`), добавлены проверки версии и даты в
шапке, непустого списка изменений и раскрытия предыдущих выпусков; прогнан
живьём на 375/768/1024/1440 px — без переполнения, 5 ссылок.

**Бамп версии = четыре файла + тег.** `package.json` (`version` и
`releaseDate`), оба поля `package-lock.json`, строка «Current version» в
`README.md`, новый раздел в `CHANGELOG.md` — и следом `git tag twig-v<version>`
с пушем, иначе `release.yml` не сработает и установщики не соберутся.

AppImage вернулся (2026-09-14, вне вех): `build.linux.target` — `deb` (amd64)
**и** `AppImage` (x86_64), рядом с DMG (arm64/x64) и NSIS (x64). AppImage
запускается без установки (`chmod +x`), но userData остаётся стандартным
каталогом Electron: `main/portable.js` не возвращается, автономного режима
состояния нет. `site/build.mjs`: `formats` получил `AppImage: 'AppImage'`,
`archNames` — `AppImage: { x64: 'x86_64' }` (electron-builder переписывает
`${arch}` по таргету: deb → `amd64`, AppImage → `x86_64`; сырой `x64` дал бы
битую ссылку), карточка Linux — вторая кнопка «AppImage · x64». В
`release.yml` ubuntu-раннер грузит `release/*.deb release/*.AppImage`.
`site/check.mjs` считает ссылки из `downloads.json`, правок не потребовал —
теперь их 5. Проверено: `npm run build:site` печатает
`Twig-0.8.3-linux-x86_64.AppImage`, `eslint site/build.mjs` чист, `AppImage`
есть в схеме установленного electron-builder. Реальная Linux-сборка на macOS
не запускалась — её делает раннер релиза. Версия 0.8.3 → **0.8.4** (patch,
по поручению пользователя): тем же тегом уезжают Check for updates и проверка
версии в README, закоммиченные без бампа.

**Релиз по тегу — часть бампа версии.** Каждый подъём версии обязан
сопровождаться тегом `twig-v<version>` на коммите с этой версией и его пушем:
`release.yml` срабатывает только на push тега `twig-v*`, иначе установщики не
собираются и кнопки сайта отдают 404. Тег сверяется с `package.json`, иначе
воркфлоу падает.

Только установщики (2026-09-14): по запросу пользователя удалены ZIP, Windows
portable и AppImage, их ссылки на сайте и публикация в release workflow.
Остаются DMG (arm64/x64), NSIS (x64), DEB (amd64); AppImage позже вернули
(см. запись выше). Удалён main/portable.js:
маркеры рядом с бинарём и переменные портативного режима больше не
перенаправляют userData; используется стандартный каталог Electron.
Изоляция smoke-тестов через --user-data-dir сохраняется.

Историческая запись ниже описывает удалённую функциональность:

Портативные сборки + автономный режим состояния (2026-09-08, вне вех):
`build.mac.target` получил `zip` (обе арки) рядом с `dmg`, `build.win.target` —
`portable` рядом с `nsis`, плюс блок `build.portable.artifactName`
(`Twig-${version}-windows-${arch}-portable.${ext}`), чтобы портативный `.exe`
не столкнулся по имени с nsis-инсталлятором. Linux `AppImage` и так портативный.
«Портативное» = запуск без установки: `.zip` разворачивается куда угодно и
стартует двойным кликом по `🌱 Twig.app`, `-portable.exe` — самодостаточный
без записи в реестр.

**Автономное состояние (`main/portable.js`):** весь `userData` (настройки,
подключённые репозитории, журнал, марки, автоматизации, демо-песочница, кэш
Chromium) переезжает в папку `twig-data` рядом с бинарём, так что копия на
флешке несёт состояние с собой. Чистая функция `resolvePortableDataDir({ env,
platform, packaged, execPath, exists })` решает куда: `TWIG_DATA_DIR` (абсолютный)
побеждает на любой платформе и без упаковки; иначе только упакованная сборка и
только по запросу — `TWIG_PORTABLE=1`, запуск Windows-portable
(`PORTABLE_EXECUTABLE_DIR`), либо уже лежащая рядом папка `twig-data` /
маркер-файл `.twig-portable`. Хост-каталог: рядом с `PORTABLE_EXECUTABLE_DIR`
(win), рядом с `$APPIMAGE` (linux), каталог, содержащий `Twig.app` (macOS —
выход из бандла по `.app/Contents/MacOS/`). `main/index.js` зовёт её на
верхнем уровне модуля (до `app.whenReady()` и любого `getPath('userData')`),
и при непустом ответе делает `mkdirSync` + `app.setPath('userData', …)`.
Обычный dmg/nsis-инсталл и `npm run dev`/smoke (unpackaged, без маркера)
поведения не меняют.

`site/build.mjs`: `formats` расширен `zip`/`portable`, портативный target берёт
имя из `build.portable.artifactName`, на карточках скачивания подписи
«· портативный» / «Портативная версия». `site/check.mjs` и
`site/README.md`/`index.html` — под 8 ссылок вместо 5. Заодно исправлено давнее
расхождение: electron-builder переписывает `${arch}` по таргету — AppImage
получает `x86_64`, deb — `amd64` (проверено реальной сборкой
`Twig-0.8.0-linux-x86_64.AppImage`), а `site/build.mjs` подставлял сырой `x64`,
из-за чего обе Linux-ссылки на сайте были битыми. Добавлена карта `archNames`.
Отдельно: `deb` не собирается без `homepage`/email автора в `package.json`
(`pack:linux` упрётся в это) — не тронуто, нужен URL.

Проверки: `scripts/checks/portable.mjs` (в `npm test`) — `TWIG_DATA_DIR`
absolute/relative, отказ автодетекта в dev, win-portable, nsis остаётся на ОС,
AppImage только с opt-in, macOS выход из бандла и маркер, не-бандловый путь.
`npm test` зелёный. Живьём: `env -u PYTHON_PATH electron-builder --mac zip
--arm64` собрал `release/Twig-0.8.0-macos-arm64.zip`, распакованная копия с
`.twig-portable` рядом создала `twig-data/` с `command-log.jsonl`,
`demo-sandbox*` и кэшем — не в `~/Library/Application Support`. `portable.exe`
на macOS не собрать (нужен wine), target стандартный. Версия остаётся **0.8.0**
(едет в том же незакоммиченном наборе, что и реинит песочницы): пока идёт
проверка «как всё работает», до 1.0.0 не поднимаем — 1.0.0 приберегли на релиз.

Рабочая демо-песочница + реинит (2026-09-07, вне вех): вкладка `workspace-demo`
больше **не** статичный фейк (`DemoGraph.jsx`/`demo.js`/`Workspace.jsx` удалены,
`Panels.jsx` → `Console.jsx` — остался только `Console`). Теперь это **настоящий
git-репозиторий** в `userData/demo-sandbox` с локальным bare-remote
`userData/demo-sandbox-remote.git`; ни одного сетевого вызова. `main/git/sandbox.js`:
`sandboxPlan()` — чистый список из 12 бэкдейт-коммитов (ветки `main` +
`feature/command-log` + `feature/repository-tabs`, merge, теги `v0.0.1`/`v0.0.2`,
`origin/main` на один коммит позади, один стеш, README с несохранённой правкой и
untracked `notes.todo`); `runSeed`/`resetSandbox`/`ensureSandbox` его исполняют.
`ensureSandbox` на старте: если `.git` нет или `demo-sandbox.json` (маркер **вне**
репозитория) с чужим `SEED_VERSION` — снести и пересеять. Песочница —
производная запись репозитория (`{ sandbox: true }`, id = путь), всегда первая в
`repositories`, **не** пишется в `repositories.json`; `createRepositoryService`
инъектит её в каждый снапшот, `remove` для неё отказывает, `resetSandbox()`
чистит Undo (`undo.forget`) и марки (`marks.forget`). `HistoryWorkspace`
переиспользуется как есть — все команды (checkout/merge/rebase/commit/stash/
blame/автоматизации/консоль/Undo/drag-drop) работают, потому что это реальный git.
Реинит: Settings → **Reset demo workspace** → §6.5-подтверждение (`.confirm-dialog`,
`AlertTriangle` + текст, список последствий, danger-кнопка последней в tab-order,
`closeReason` блокирует Esc во время сброса) → канал `sandbox:reset`.
`buildHistoryArgv`/`buildSearchArgv` получили `--exclude=refs/stash`: стеш и так
показан плашкой на своём базовом коммите, сырые `WIP on …`/`index on …` в графе не
нужны. App.jsx: демо-вкладка без крестика, `repository` теперь берётся по активной
вкладке (а не по `activeId`), демо-`HistoryWorkspace` монтируется только когда
активна (реальные вкладки — всегда, ради сохранения DOM), иначе её граф
пересекался бы с локаторами других вкладок в смоук-тестах. `Cmd+B`
(сворачивание сайдбара на уровне App) удалён — работал только для старого демо.
Проверки: `checks/sandbox.mjs` (план + настоящий сев/сброс), `sandbox-smoke.mjs`
(демо-репо, стеш-pop, Reset demo workspace восстанавливает историю, обе темы);
`smoke.mjs` переписан под реальный демо-граф; `browse/profile/repositories-smoke`
поправлены под «старт на реальном демо-репозитории». UI-скилл прогнан по
Settings-диалогу, решения — в `design/TOKENS.md`. Версия 0.7.0 → **0.8.0** (minor).

Упаковка 0.6.1 (2026-09-07): первая реально собранная нативная сборка после M6.
Две правки в `package.json`. `build.files` получил
`renderer/src/features/automations/*.js` — `main/automations-ipc.js`,
`main/automations-store.js` и `main/automation/{engine,actions,discovery}.js`
импортируют эти семь чистых модулей относительным путём (приём, санкционированный
в разделе про M6), но в асар попадали только `main/**` и `dist/**`, поэтому
упакованное приложение падало с `ERR_MODULE_NOT_FOUND` на `event-labels.js`.
Глоб сохраняет путь внутри асар, `../renderer/src/...` резолвится; из `main/`
за пределы `main/` уходят только эти импорты. `pack:mac` и `pack:linux` теперь
`env -u PYTHON_PATH electron-builder …`: `dmg-builder` (`out/dmg.js`) при
кастомизации DMG прямо доверяет `process.env.PYTHON_PATH`, а на машине сборки
она указывала на несуществующий каталог `/Library/Python/3.9/bin` → `spawn ENOENT`.
Без переменной он уходит в штатный `which python3`. `pack:win` не тронут:
`env -u` не работает в cmd, а `dmg-builder` — только macOS.

Сайт-визитка 🌱 Twig (2026-09-07): `site/` — автономный статический лендинг
на русском, без клиентского JavaScript и внешних ресурсов. Оригинальная иконка,
локальные Fira Sans и палитра приложения; адаптация от 375 px. Продвигает
локальные марки, rebase, редактор конфликтов, BugHunter, быстрый граф,
построчный staging, drag-and-drop, журнал и автоматизации внутри 🌱 Twig.
`npm run build:site` → `site/dist/`, `npm run preview:site` → localhost:5190.
Версия и пять ссылок берутся из `package.json` / `build.*.artifactName/target`;
ту же конфигурацию используют новые `pack:mac`, `pack:win`, `pack:linux`.
Установщики из `release/` пользователь размещает в `downloads/` рядом с сайтом.
До загрузки файлов эти ссылки возвращают 404. Нативные сборки/подписи и деплой
в рамках сайта не выполнялись. Инструкция: `site/README.md`; браузерная проверка
с отключённым JS и снимками: `node site/check.mjs` при запущенном preview.
Старые записи «нет установщиков» ниже относятся к фактически выпущенным
и проверенным сборкам; конфигурация упаковки и команды теперь существуют.

Аудит сайта: статические HTML/CSS, без форм и клиентского исполнения;
версия экранируется, имена установщиков проверяются, preview ограничен каталогом
сборки и localhost. Новых IPC, таймеров, подписок и сетевых зависимостей нет.
Ресурсы локальные, иконка уменьшена, снимок загружается лениво, внешних шрифтов нет.
Проверки лендинга: сборка, профильный ESLint, схема electron-builder и `git diff --check`
прошли; Chromium проверил 375/768/1024/1440 px, отсутствие переполнения,
локальные ресурсы, якоря, клавиатуру, раскрытие инструкции и пять ссылок
скачивания с тестовыми ответами. Снимки desktop/mobile просмотрены.
`checks/graph.mjs` повторно прошёл на 100k коммитов (74 мс на текущем Mac);
лендинг явно называет это проверкой раскладки, не бенчмарком всего клиента.

Drag and drop (2026-09-06, вне вех): ветки перетаскиваются из левого сайдбара
и плашек графа на ветки/коммиты; строка без однозначной ветки переносит коммит.
У строки с несколькими ветками выбирается текущая, если она здесь, иначе
нужную ветку указывают её плашкой или в сайдбаре. Источник обозначен пунктиром,
цель сплошной рамкой, обе строки/узла подсвечены, подпись Source → Target
показывает направление без зависимости от цвета. Подпись плавает над графом,
не сдвигая цель во время drag; у края граф автоматически прокручивается.
Клавиатура: Alt+D на ветке/строке, выбор цели, Alt+Enter; Escape отменяет.

Drop только открывает меню: merge/no-ff в целевую локальную ветку, rebase
исходной локальной ветки на цель, remote → local — pull (ff-only/merge/rebase),
local → remote — push одного ref без force. Коммит → local/коммит — cherry-pick
и revert; merge-коммит требует выбора mainline parent. Compare открывает дифф
без мутаций. После выбора действия диалог показывает все команды по порядку,
смену ветки и последствия; коммит-цель без ветки явно означает detached HEAD.
Составной операции нет безопасной инверсии: она обрывает цепочку Undo.

`main/git/drop-plan.js` — общий чистый план меню/предпросмотра/исполнения,
`drop.js` — исполнение через `runGit`. Узкий канал `sync:drop` проверяет
аргументы, sender/frame и сохранённый repository id, использует `undo.perform`
и ту же отмену `sync:cancel`. Перед мутацией проверяет HEAD, oid обеих веток,
чистое дерево, отсутствие операции/bisect и настроенный remote; после switch
повторно сверяет целевую ветку и дерево. Операнды коммитов закреплены oid,
remote-имя разбирается по самому длинному совпадению настроенного имени.
Rebase/pull не делают autostash и не двигают сторонние refs через updateRefs;
push не публикует дополнительные теги через followTags. Конфликт возвращает
состояние существующему баннеру. Это не транзакция с внешними процессами Git:
между финальной проверкой и командой всё ещё возможно внешнее изменение.

Аудит безопасности: argv собирается из фиксированных действий и проверенных
oid/ref, shell не используется, DataTransfer не десериализуется и не даёт
внешнему приложению выполнить Git; любой drag только выбирает действие.
Аудит производительности: Git не вызывается на hover, переиспользуются refs
и виртуализация, обработчики снимаются, requestAnimationFrame работает только
во время drag и отменяется при завершении. Проверки: `checks/drop.mjs` на
реальном Git и `drop-smoke.mjs` с нативным перетаскиванием в Electron.
Сквозной прогон дополнительно проверяет автопрокрутку с удержанием мыши,
открытие графа при старте из сайдбара на экране веток, сравнение, отмену
предпросмотра и обе темы на 1000×640. Подсказка занимает две строки и не
сжимает имя источника в узкую колонку; активация рабочего пространства после
закрытия диалога не отменяет новое перетаскивание.

Git Hooks Automation Pipeline — M6, шаг 1 (2026-09-06): визуальная система
автоматизаций поверх клиентских git-хуков. Ответ на вопрос «когда происходит
это git-событие — что запустить?» без ручных файлов в `.git/hooks`. Модель:
**триггер → условия → действия → результат**. Шаг 1 закрывает движок и весь UI;
пайплайны срабатывают на git-операции, **запущенные внутри 🌱 Twig** (commit, push,
merge, rebase, reword, checkout). Установка диспетчеров в `.git/hooks` и покрытие
git из внешнего терминала — шаг 2 (не сделано). Существующие чужие хуки шаг 1
только **показывает** (read-only), не трогает и не оборачивает.

- Экран: новый пункт левого сайдбара **Automations** (рядом с Branches/Stashes),
  вкладки Pipelines / Run history. Карточка пайплайна: вкл/выкл, Run now, Edit,
  Duplicate, Delete. Редактор — триггер (10 событий), условия, действия с
  переупорядочиванием (drag + Move up/down + Alt+стрелки, как `RebaseDialog`),
  поведение при ошибке (block/warn). Оверлей выполнения: шаги с иконкой+словом
  (не только цветом), тайминги, «Commit/Push blocked», кнопки Fix and retry /
  Run again / Bypass once. `Bypass once` — разовый, не сохраняется, пишет
  «checks skipped» в лог и заметку.
- Действия: `command` / `custom` (только имя программы из PATH, argv,
  **никогда shell** — `command-parse.js` отвергает `& | ; < > $ \``, переносы
  строк, несбалансированные кавычки; цепочка = новое действие), `script`
  (путь только внутри рабочего дерева, `path.relative`-проверка), `validateMessage`
  (conventional / regex / ticket), `checkBranch`, `checkChangedFiles`,
  `secretScan` (локальные regex'ы `secret-rules.js`, наружу ничего не уходит).
- Хранилище: `automations.json` (пайплайны + settings + trust) и
  `automation-runs.json` (история, до 100, stdout/stderr ≤ 100 КБ/шаг) в
  `userData`, ключ — id репозитория, атомарно по образцу `marks-store.js`.
  Логи в репозиторий не коммитятся.
- Модель доверия (обязательна): `.twig/hooks.json` из репозитория — **данные**,
  не исполняются никогда до явного «Review & Enable» в `TrustPrompt`. Trust =
  `{ digest: sha256(байты файла), approvedCommands, enabledRepoPipelineIds }`.
  Правка файла → digest не совпал → все repo-пайплайны выключены + повторный
  запрос; новые команды не одобряются автоматически. На clone/open ничего не
  запускается. Локальные пайплайны доверенные по построению (их набрал человек).
- Запуск процессов: `main/automation/exec.js`, `spawn(exe, argv, { shell:false })`
  по образцу `main/ssh/exec.js`, журналируется с полем `executable`, таймаут на
  шаг (120 с по умолчанию) и отмена по `AbortController`, как `sync:run`. PATH
  логин-шелла резолвится один раз на старте (`resolveLoginPath`), плюс extraPath
  из настроек. Сеть не используется вовсе; `git` по-прежнему только через
  `main/git/exec.js`.
- Каналы `main/automations-ipc.js`: `automation:config|save|trust|run|cancel|
  runs|run-detail`, стрим шагов `automation:step`. Каждый проверяет
  sender/frame/число аргументов и резолвит репозиторий только по сохранённому
  списку; невалидный запрос **отклоняется**. `automation:run` с `bypass:true`
  ничего не исполняет — только пишет запись `bypassed`.
- Чистые модули (без импортов кроме соседних, грузят Vite и Node):
  `renderer/src/features/automations/{event-labels,command-parse,condition-eval,
  message-rules,secret-rules,schema,templates}.js`. `main/automation/{engine,
  actions,discovery,exec,path}.js` импортируют их относительным путём — как это
  уже делает `HistoryWorkspace` с `main/git/drop-plan.js` и `scripts/checks/*`.
- Проверки: `checks/automation.mjs` (события, парсер команд, условия, правила
  сообщений, схема, шаблоны), `checks/secret-rules.mjs`, `checks/automation-run.mjs`
  (**настоящий spawn** и настоящий git: коды выхода/вывод/таймаут/отмена,
  guard пути скрипта, последовательность движка, gating по условиям).
  `scripts/automations-smoke.mjs` — Electron: пайплайн из шаблона, заблокированный
  коммит, bypass once, история прогонов, 4 отказа IPC, обе темы. Скриншоты
  `artifacts/m6-automations-{blocked,dark,light}.png`.

Глобальный поиск по коммитам (2026-09-07, вне вех): поле в левом сайдбаре
теперь один общий поиск. Раньше оно фильтровало только имена ref'ов; при
запросе от двух символов оно вдобавок ищет по сообщениям коммитов (subject +
body) и по хэшу **по всей истории, а не только по подгруженной странице**, и
сворачивает граф в плоский список совпадений (новыми сверху, без дорожек —
предки скрыты). Плашка сверху: «N commits match «query»» (или «N+», если
упёрлись в потолок 200) и кнопка Clear search results. Клик по строке
открывает панель коммита; правый клик даёт то же контекстное меню операций,
что и в графе (ветка/чекаут/merge/cherry-pick/…), — можно найти и сразу
действовать. Рефы в сайдбаре фильтруются тем же полем как и прежде.
`main/git/history.js`: `buildSearchArgv` → `git log --all -i --fixed-strings
--grep=<q> -z --format=… --max-count=200` (литеральный запрос, регэксп/флаг не
интерпретируется, стоит одним argv-токеном после `--grep=`); `searchHistory`
дополнительно резолвит hex-запрос как commit id через `git rev-parse --verify
--quiet <q>^{commit}` и подтягивает этот коммит, даже если в сообщении цифр
нет. Новый канал `history:search` резолвит репозиторий только по сохранённому
списку, отклоняет пустой/длиннее 200/с NUL запрос. Запрос дебаунсится на
250 мс — один вызов git на серию нажатий; новых таймеров опроса, подписок и
сети нет. Проверки: `buildSearchArgv` в `scripts/checks/history.mjs` (argv,
trim, литеральность, отказы), `history-smoke.mjs` ищет по сообщению (2
совпадения), по префиксу хэша (резолв в коммит), открывает результат,
очищает поиск и добавляет 2 отказа IPC. Версия рабочего дерева 0.6.0.

Blame, Blame History и Reverse Blame (2026-09-07, вне вех): построчный
последний-изменивший для **зафиксированной** версии файла. Пункт «Blame history»
в контекстном меню файла в панели коммита и кнопка **Blame** в шапке просмотра
диффа / File history. Открывается всегда по реальному oid (той версии, которую
показывала панель), рабочее дерево не подмешивается — каждое чтение это
`git blame <oid>` либо `--reverse <start>..<end>`, ничего не чекаутится и не
стейджится. Экран (`renderer/src/features/blame/BlameView.jsx`): заголовок
`путь at <sha>`, переключатель Blame / Reverse blame, локальные Back/Forward со
счётчиком шагов, виртуализованный список строк (окно как у `CommitGraph`, 22 px
на строку). Плашка коммита печатается один раз на серию соседних строк одного
коммита, дальше идёт цветной корешок — соседние строки читаются одним блоком;
цвет не единственный носитель (в плашке короткий хэш, автор, дата, тема).
Выбор строки/блока (клик, Shift-клик, стрелки, Shift+стрелки) открывает справа
`BlameDetail` — коммит + дифф этого файла в нём + «Go to commit» (переводит граф
через `jump`). «Blame before this change» (кнопка, пункт меню строки, клавиша
`[`) открывает blame версии **перед** коммитом выбранной строки: путь и номер
берутся из porcelain-поля `previous` (git уже прошёл переименования), строки
сопоставляются через дифф-ханк (`main/git/blame-map.js`), а не по совпадению
номера; неточное соответствие честно помечается и поясняется, добавленная строка
показывает окружение. Первый коммит / впервые добавленный файл → «нет предыдущей
версии»; shallow → «за пределами клона»; merge → выбор родителя (по умолчанию
тот, в который спустился git). Reverse blame: Start (по умолчанию открытая
версия) и End (по умолчанию HEAD) — обе ссылки резолвятся в полные oid, main
проверяет `merge-base --is-ancestor` и наличие файла в Start; Start = End —
отдельный валидный случай. «Present at end» (строка дошла до End, attributed ==
End) и «Last present in …» (последний коммит существования) различаются явно; git
`--reverse` A→B→C с удалением в C возвращает B и **не** называет его удаляющим.
Недопустимый диапазон показывает причину, не догадку. Кэш
(`blame-cache.js`, ключ = repo+режим+oid+путь+endOid, до 16 записей) и один
in-flight blame на репозиторий: новый запрос отменяет прежний через
`AbortController` → `signal` в `runGit`, `blame:cancel` — при закрытии экрана.
Git-слой: чистые `buildBlameArgv` / `buildReverseBlameArgv` (путь **сырым**
после `--`, не `:(literal)` — у `git blame` другой контракт путей, чем у
`log`/`diff`), `parseBlamePorcelain` (метаданные, boundary, previous, filename с
C-раскавычиванием, строки с ведущим табом сохраняются, NUL → бинарный),
`--no-textconv` запрещает внешние textconv. Каналы `main/blame-ipc.js`
(`blame:file|reverse|before|cancel`) проверяют sender/frame/число аргументов,
резолвят репозиторий только по сохранённому списку, валидируют oid/ref/путь/
номера строк; невалидный запрос **отклоняется**, неудобный, но валидный ответ
(нет предка, файла нет в Start) возвращается как причина. Навигация Back/Forward
не вмешивается в Undo/Redo Git-операций (blame ничего не мутирует). Проверки:
`scripts/checks/blame.mjs` (argv, парсер, `mapLineBack`, и на настоящем Git —
добавление/изменение/удаление строк, шаги в прошлое, переименование, root,
reverse A→B→C, Start=End, имена с пробелами/Unicode/ведущим дефисом),
`scripts/blame-smoke.mjs` (Electron: открытие из меню, навигация клавиатурой,
шаг в прошлое, Back/Forward, reverse blame, недопустимый диапазон, возврат в
граф, Unicode-имя, неизменность HEAD/индекса/дерева, 6 отказов IPC, обе темы
1000×640; снимки `artifacts/blame-{dark,light}.png`). Версия НЕ бампалась
(отдельного поручения не было).

Ввод команд в консоль — read-only (2026-09-07, вне вех): `PROMPT.md` §7 откладывал
ввод произвольных команд «не в первой версии»; пользователь включил его в самом
узком объёме — **только неизменяющий git**. Внизу развёрнутой консоли строка
`$ git …`: набранное токенизируется без шелла (та же логика, что
`command-parse.js` — запрет `; & | < > $ \``, никакого раскрытия, ведущий `git`
отбрасывается) и проверяется по allowlist подкоманд, которые ничего не пишут
(`log show diff status blame reflog rev-parse … branch/tag/remote/stash/worktree`
только в листинговой форме). Разрешённая команда идёт тем же `runGit` с
`operation: 'Console command'` и попадает в журнал как обычная запись (видна в
фильтре «My actions»), её вывод сразу разворачивается. Мутирующая или опасная
(`commit`, `reset --hard`, `push`, `branch -D`, `git branch <имя>`, `stash drop`,
`worktree add`, `remote add`, `symbolic-ref <name> <ref>`, `reflog delete`),
глобальные опции (`-c`, `-C`, `--exec-path`, `--git-dir`), `--output`/`-o`,
`--ext-diff`, `--textconv` (кроме `cat-file`), `--upload-pack`/`--receive-pack`,
а также `config` и `help` целиком — **отклоняются** с пояснением под полем;
`config` исключён намеренно (у приложения есть экран Git profile, `--list` слил
бы токены из URL — то же решение, что в `profile-ipc`). История ввода — стрелки
вверх/вниз, в памяти. Поле выключено без открытого репозитория. Канал
`console:run-command` проверяет sender/frame/2 строковых аргумента, резолвит
репозиторий только по сохранённому списку и **сам** гоняет токенайзер и
allowlist — вердикт renderer не в счёт; ошибка парсера или allowlist отклоняет
запрос, а не отвечает «ok:false». Чистый модуль `main/git/read-only-command.js`
без импортов (по образцу `drop-plan.js`), его грузят и renderer, и Node-проверка;
новых токенов CSS, таймеров, подписок и сети нет. Проверки:
`scripts/checks/read-only-command.mjs` (токенайзер, ~35 разрешённых и ~55
отклонённых команд, guard'ы подкоманд) в `npm test`; `history-smoke.mjs` вводит
`log --oneline -3` (запись в журнале + раскрытый вывод), отклоняет `commit -m nope`
в UI (журнал не меняется), рекол истории по ↑ и 4 отказа IPC. Снимки —
`artifacts/console-input-{dark,light,error}.png`. Версия 0.6.1 → 0.7.0
(minor, по поручению пользователя; тем же коммитом уехала ранее не
закоммиченная упаковочная правка 0.6.1).

Текущая веха: **M5 в работе: профиль, remotes, список репозиториев и clone;
версия рабочего дерева 0.6.0**.
Сверка M2–M4 с полным брифом и оставшиеся пробелы/риски находятся в
`tasks/M4-HISTORY-OPS-RESULT.md` (независимая проверка 2026-09-05).
Пользователь поручил пока не исправлять их и перейти к M5.

История файла (2026-09-06, вне вех): контекстное меню на изменённом файле в
панели коммита (правый клик, Shift+F10 или клавиша Menu на строке) — пункт
«File history». Он открывает в центральной панели список всех коммитов, которые
трогали этот файл, новыми сверху, с проходом по переименованиям (`git log
--follow`). Клик по строке оставляет список открытым и показывает справа только
дифф этого файла в выбранном коммите относительно первого родителя (для root —
добавление файла); выбор диапазона в графе на этот дифф не влияет. Строка
выделяется и получает `aria-pressed`, Enter/Space доступны через обычную кнопку.
«Go to commit» над диффом отдельно переводит граф на полный коммит через `jump`.
Закрытие диффа сохраняет список, закрытие истории возвращает граф и его выбор.
Правый разделитель у истории файла тянет отдельное состояние `fileHistoryWidth`
с размером `FILE_HISTORY_PANEL_SIZE` (max = `PANEL_MAX`×2 = 1120): дифф файла
занимает панель целиком, соседнего ряда графа рядом нет, поэтому лишняя ширина
полезна только здесь; пол графа в `panelWidthLimits` по-прежнему останавливает
раньше, чем граф схлопнется. У обычной панели коммита ширина прежняя.
Argv строит `buildFileHistoryArgv` в `main/git/history.js`
(single pathspec как `:(literal)<path>` после `--`), выполняет `loadFileHistory`
через тот же `runGit`; `--name-status -z` сохраняет прежние пути при переименовании.
`parseFileHistory` переиспользует `parseHistoryV1` для заголовков и добавляет
путь файла в каждом коммите, чтобы старые версии открывались по старому имени.
Новый канал `history:file-log` резолвит репозиторий только по сохранённому
списку и валидирует путь (`validateFile`: без `..`, без ведущего `/`, без NUL) —
невалидный путь **отклоняет** запрос, а не отвечает пустым списком. Новых
таймеров, подписок и сетевых вызовов нет; один `git log` на открытие панели,
один запрос диффа на выбор строки. Счётчик запросов отсекает устаревшие ответы.
Проверки: `buildFileHistoryArgv` в `scripts/checks/history.mjs`, а сквозной
`history-smoke.mjs` проверяет две версии, отсутствие чужого файла в диффе,
выбор клавиатурой, путь до переименования, отдельный переход к полному коммиту,
обе темы на 1000×640 и два отказа IPC на traversal/абсолютном пути.

Ссылки на фордж и автора (2026-09-06, вне вех): панель коммита показывает
кликабельную ссылку на страницу коммита в GitHub / GitLab / Bitbucket (иконка +
имя форджа рядом с коротким sha в заголовке), ссылку на список коммитов автора
на фордже (GitHub/GitLab, `?author=<email>`; у Bitbucket фильтра по email нет)
и `mailto:` на email автора в карточке. URL собирает чистая функция
`renderer/src/features/commit/forge-url.js` (без импортов, грузит и Vite, и Node)
из уже читаемого `remotes:read`: `HistoryWorkspace` тянет remotes одним вызовом
на `reload` вместе с refs и стешами и передаёт их в `CommitPanel`. Распознаются
только три публичных хоста; self-hosted GitLab — по префиксу `gitlab.`. Адрес с
credentials, неизвестным транспортом или локальный путь ссылки не даёт вовсе —
панель тогда показывает простой текст. Ссылку открывает существующий
`will-navigate` → `shell.openExternal`; ради `mailto:` в `main/security.js`
`isExternalLink` теперь пропускает схему `mailto:` для голого адреса без query
(тема/тело из данных репозитория подставить нельзя). Новых IPC-каналов, запусков
Git, таймеров и сетевых вызовов нет. Проверка `scripts/checks/forge-url.mjs`
(разбор всех форм remote, отказы, построение commit/author URL, `pickRemoteUrl`),
`foundation.mjs` дополнена кейсами `mailto:`. Версия рабочего дерева 0.3.2.

Локальные марки коммитов (2026-09-06, вне вех): в контекстном меню коммита —
«Mark this commit…» / «Edit mark and note…» и «Remove mark». Марка = один из
шести фиксированных цветов (`red`/`amber`/`green`/`blue`/`violet`/`slate`,
токены `--mark-*` в обеих темах) плюс необязательная текстовая заметка. Цвет и
заметка выбираются в блоке «Mark» — он идёт первым в панели коммита, перед
сообщением (свотчи + textarea + «Save note»); пункт меню только открывает
панель на нужном коммите. Помеченная строка в графе:
узел коммита залит цветом марки (халка в `--bg`), слева цветная полоса
(`::before`), фон строки — `color-mix` с цветом марки (крепче, когда строка
ещё и выбрана), плюс иконка-закладка первой в колонке ref'ов с заметкой в
тултипе — поверх любого режима «Commit colors» (age/lanes). Цвет — не
единственный носитель смысла: есть иконка и `aria-label`. Хранится в `marks.json` в `userData`, ключ — id репозитория (это
абсолютный путь к его корню) и полный oid; запись атомарна и сериализована,
память меняется только после `rename`. Git не запускается вовсе, консоль не
трогается, новых таймеров/подписок/сетевых вызовов нет; марки грузятся одним
IPC на `reload` вместе с refs/стешами/remotes и обновляются без перезагрузки
истории. Канал `marks:set` прогоняет `validateMark` (oid hex 40/64, цвет из
allowlist, заметка ≤ 2000 без NUL) и **отклоняет** невалидный запрос.
Проверки: `scripts/checks/marks.mjs` (паритет палитры renderer↔main, валидация,
атомарный per-repo стор), кейсы меню в `history-ops.mjs`, `foundation.mjs`
сверяет контраст `--mark-*` ≥ 3:1, `history-smoke.mjs` ставит марку из меню,
пишет заметку, переживает reload и снимает марку, плюс три отказа IPC.

Цвет по возрасту коммита (2026-09-06, вне вех): в Settings добавлена опция
«Commit colors» — «Commit age» (по умолчанию) или прежние «Branch lanes».
В режиме возраста дорожки, точка коммита, колонка Date и дата в панели коммита
красятся рампой из пяти токенов `--age-fresh`…`--age-root`: зелёное — сегодняшнее,
коричневое — корни; строка «Uncommitted changes» берёт самый свежий зелёный.
Шкала абсолютная (сегодня/неделя/месяц/год/старше), а не относительно
загруженной страницы: относительная перекрашивала бы уже показанные строки при
подгрузке старых коммитов, и «старый» значил бы разное в разных репозиториях.
Дата неизвестного формата не получает цвета вовсе — строка остаётся на цветах
веток. Выбор лежит в localStorage (`twig:commit-colors`), как и тема; новых
IPC-каналов, запусков Git, таймеров и сетевых вызовов нет, `Date.now()` читается
один раз на отрисовку и только для видимых строк.

Инициалы автора в узле графа (2026-09-06, вне вех): кружок коммита увеличен
(r=8) и несёт инициалы автора — первые буквы двух слов имени или первые две
буквы односложного имени (`authorInitials` в `features/graph/layout.js`, чистая
функция, её грузит и Vite, и Node). Обводка кружка по-прежнему кодирует
ветку/возраст, марка рисуется тем же кольцом поверх (`circle.mark-node` теперь
`fill: none`). Настоящих аватарок нет и быть не может: это сетевой запрос
(Gravatar/фордж) и внешнее изображение — оба запрещены. Инициалы показаны и в
демо-графе. Новых токенов нет (`.commit-initials` на `--text`/`--font-ui`),
новых IPC/Git/таймеров/сети нет.
Коммиты вех (ветка
`feat/git-desk`): M0 `add desktop workspace shell`, M1 `add M1 Git executor,
journal and repository picker`, M2 `add M2 real commit graph, refs sidebar and
diff panel`, M3 `add M3 staging, commit, stash and sync`.
M5 пока не завершена: SSH, Undo/Redo §8.1, установщики и финальная проверка
на трёх ОС остаются следующими частями.

Переименование коммита (reword) — в контекстном меню §8.2. Вершину переписывает
`git commit --amend --only --file=-`: без `--only` amend втянул бы в чужой
коммит всё, что лежит в индексе, и человек, правивший опечатку, молча отправил
бы туда свою работу. Коммит внутри истории переписывается тем же интерактивным
rebase: renderer строит план, где ровно одна строка `reword`, остальные `pick`
(`features/ops/reword-plan.js`), и передаёт его в уже существующий `ops:rebase`.
Диалог §6.5 показывает точную команду и сколько коммитов сменит object id.
Меню объясняет каждый отказ вместо того, чтобы прятать пункт: у вершины условий
нет вовсе (грязное дерево ей не мешает), а коммиту внутри истории нужны чистое
дерево, родитель и не-merge — условия самого rebase. Undo вершины — тот же
`reset --soft`, что у обычного коммита; reword через rebase, как любой rebase,
обрывает цепочку Undo честно. Невалидное сообщение или oid отклоняют канал,
а сдвинувшийся HEAD и идущая операция возвращают `ok: false` с состоянием.

Третий шаг M5 (просмотр и bisect): `main/git/stash.js`, `main/git/bisect.js`,
`features/refs/RefsScreen.jsx`, `features/stash/StashScreen.jsx`,
`features/ops/BisectBanner.jsx`. В сайдбаре два новых экрана: «Branches and
tags» — поиск, checkout, переименование, upstream, удаление, публикация тега и
удаление ветки/тега на remote — и «Stashes» — список, файлы стеша, дифф,
apply/pop/branch/drop.

Стеш читается по oid коммита, а мутируется только по `stash@{n}`:
`git stash drop <sha>` отвергается («is not a stash reference»), а индекс
съезжает после любого drop. Поэтому renderer присылает индекс **и** oid, который
он показывал, main перечитывает список и отказывает, если пара разошлась.
Untracked-часть стеша лежит в третьем родителе: файлы читаются из `^3`, а их
дифф — как `^1..^3`, иначе нового файла не видно вовсе.

🌱 BugHunter (bisect): старт из контекстного меню коммита с багом или кнопкой
рядом с Terminal от выбранного коммита. Кнопку тулбара рендерит активный
HistoryWorkspace через React portal, поэтому состояние скрытой вкладки не
может подменить цель запуска. При недоступности hover на обёртке показывает
причину: нет репозитория/выбранного коммита, история или состояние ещё не
проверены, есть изменения, идёт другая операция либо BugHunter уже запущен.
Дополнительных запросов состояния ради тулбара нет. Панель
проводит через выбор диапазона, проверку версий и результат. Старый коммит
без бага выбирается в истории и отмечается кнопкой прямо в панели; дальше
Bug absent / Bug present / Cannot test · Skip относятся к показанному тестовому
oid, даже если в истории выбран другой коммит. Есть раскрываемая инструкция,
оценка числа проверок после текущей, Show test commit и Stop/Finish and return
с пояснением возврата к исходной ветке. Неизвестная оценка не подменяется нулём;
пропуски могут увеличить число проверок или оставить несколько кандидатов.
Состояние читается из маркеров
`BISECT_START`, `BISECT_TERMS`, `BISECT_EXPECTED_REV` и `refs/bisect/*`, а
сколько осталось — из `git rev-list --bisect-vars`, машинной формы той самой
фразы, которую Git печатает; человеческий вывод `git bisect` не парсится (§6.3).
Термины берутся из репозитория, а не зашиты: bisect, начатый в терминале с
`--term-old/--term-new`, отвечает только на свои слова. `git bisect run`
сознательно отсутствует — он исполняет произвольную команду, а приложение
запускает только `git`. Отдельного баннера хватает: bisect ничего не
конфликтует и не блокирует остальные команды, в отличие от прерванного merge.

Проверка BugHunter: production build, профильный ESLint и `browse-smoke.mjs`
прошли. Сквозной тест проверяет инструкцию, выбор границы кнопкой, просмотр
другого коммита без смены тестовой цели, skip, stop/reset и полный поиск
заранее внесённого бага. Проверены обе темы и окно 1000×640; снимки —
`artifacts/m5-bughunter-{help,dark,light,compact}.png`.
Аудит: новых каналов, сетевых вызовов, таймеров и подписок нет; отметки идут
через существующий валидируемый IPC с явным oid. Выбранный коммит берётся
из готового индекса истории за O(1); высота панели ограничена и прокручивается.

Публикация тега и удаление ветки/тега на remote идут через `sync:push-ref` —
там же, где pull/push, поэтому у них та же отмена. Ref пишется полным
(`refs/heads/…`, `refs/tags/…`) и стоит после `--`. Какому remote принадлежит
`origin/feature`, решает список настроенных remotes с самым длинным совпадением,
а не первый слэш: имя remote само может содержать слэш. Текст команды в диалоге
§6.5 собирает `features/refs/remote-ref.js`, и проверка сверяет его с argv из
`sync.js`, чтобы показанное не разошлось с исполняемым.

Удаление слитой ветки выполняется сразу — `branch -d` Git сам отвергает, когда
что-то потерялось бы, — и только отказ открывает `-D` через диалог §6.5. Все
новые мутации проходят через `undo.perform`: безопасной инверсии у них нет,
поэтому они честно обрывают цепочку Undo вместо того, чтобы изображать откат.

Проверка третьего шага M5 на macOS arm64 / Node 20.20.0 / git 2.54.0: `npm test`
зелёный (lint + 19 Node-проверок, включая новые `stash.mjs` и `bisect.mjs` на
настоящем Git), production build, `browse-smoke.mjs` целиком — включая полный
bisect, который обязан найти именно тот коммит, который фикстура сломала.
Оба экрана просмотрены в обеих темах на снимках с непустыми списками;
`git diff --check` чист. Аудит: все новые каналы проверяют sender/frame/число
аргументов и резолвят репозиторий по сохранённому списку; oid, имена ref'ов,
индекс стеша и bisect-термины валидируются до argv, имена стоят после `--`.
Новых таймеров, опроса и сетевых вызовов, кроме `push` одного ref, нет;
`git stash list` добавлен к перечитыванию истории — один дешёвый вызов на
обновление, не на каждый ряд.

Второй шаг M5: `main/repository-ipc.js`, `main/git/remotes.js`,
`main/git/clone.js`, `features/settings/{Repositories,Remotes,CloneRepository}.jsx`.
В Settings — Manage repositories / Manage remotes; на новой вкладке — Clone
repository / Connected repositories. Remotes: список адресов, add, изменение
основного fetch URL, remove с пояснением последствий, fetch --prune с отменой.
Дополнительные fetch URL и явные push URL показаны без редактирования.
После изменения refs граф и сайдбар выбранного репозитория перечитываются.
Удаление из списка сохраняет файлы на диске; мутации списка сериализованы,
запись store меняет память только после успешного rename файла.

Clone: выбор родителя нативным диалогом даёт renderer временный opaque token
(15 минут), а не право передать путь назначения. Имя — единственный новый
компонент пути с проверкой Windows reserved names; существующий каталог
отвергается. Git работает через `exec.js` с `--progress`, вывод живёт в консоли
и в диалоге; отмена не добавляет запись репозитория. После сбоя удаляется только
пустой созданный каталог; непустые остатки сохраняются. Ограничение остановки
потомков Git остаётся тем, что зарегистрировано в отчёте M2–M4.

Аудит второго шага M5: sender/frame/число аргументов, известный id и токен
назначения проверяются main. URL с credentials/query, ext:: и неизвестные
транспорты запрещены; shell не используется. Чтение существующих remote URL
буферизует короткий ответ и скрывает недопустимые/credential-bearing адреса
перед отправкой в журнал (включая finish); argv остаётся точным. Это явное
исключение для вывода с секретами. Перед изменением remote сверяется снимок
адресов. Новых таймеров/опроса нет; подписки/effects очищаются. Межпроцессная
гонка после проверки снимка не превращается в транзакцию Git config.
`checks/repositories.mjs` проверяет настоящие remotes, fetch, clone, отмену,
refusal существующего каталога, отсутствие удаления файлов, параллельные
операции списка и восстановление. `repositories-smoke.mjs` проводит те же
основные пользовательские сценарии в Electron, включая повторный запуск.
Проверено на macOS arm64: `npm test` (15 Node-проверок и ESLint), затем после
финальных изменений — профильные проверки и lint, полный `npm run test:smoke`
(все шесть скриптов) и `git diff --check`. Снимки новых экранов —
`artifacts/m5-{clone,repositories,remotes-dark,remotes-light}.png`.

Первый шаг M5: `main/git/profile.js`, `main/profile-ipc.js`,
`features/settings/GitProfile.jsx`. Кнопка профиля открывает реальные настройки
`user.name`, `user.email`, `core.editor`, `pull.rebase`, `init.defaultBranch`.
Выбор local/global, эффективные значения, сохранение/удаление каждого поля,
защита от устаревшего значения и Reload. Все чтения/записи — через `runGit`;
читается только allowlist из пяти ключей, не весь конфиг с credentials.
Тесты `checks/profile.mjs` и `profile-smoke.mjs` изолируют global config во
временном каталоге. Версия для следующего коммита M5 ещё не выбрана пользователем;
текущий бамп относится к работе M4.

Проверка первого шага M5: `npm test` (lint + 14 Node-проверок) зелёный,
production build, базовый Electron smoke и `profile-smoke.mjs` зелёные.
До правок M5 повторно прошли все четыре прежних Electron smoke M0–M4.
UI-профиль просмотрен в обеих темах на 1000×640, доступен с клавиатуры.
Аудит M5: sender/frame, число аргументов, scope и известный repository id
проверяются в main; запись разрешена только для пяти ключей, значения остаются
отдельными argv. Два ограниченных чтения вместо полного дампа конфигурации;
нет новых сетевых вызовов, таймеров или подписок. Проверка устаревшего значения
защищает от изменений до Save, но не является межпроцессной транзакцией между
проверкой и `git config`; сам Git блокирует запись своего конфигурационного файла.

Сделано:
- Изолированное окно Electron, сборка preload и Vite, запуск dev одной командой.
- Табы, тулбар, сайдбар, правая панель, раскрываемая консоль. Вкладка
  `workspace-demo` — реальная git-песочница (`main/git/sandbox.js`), не фейк;
  сохранение состояния DOM при переключении вкладок — для реальных репозиториев
  (демо монтируется только когда активна).
- System/dark/light с сохранением выбора, локальные Fira Sans / Fira Code,
  Lucide SVG. Темы применяются до загрузки React без светлой вспышки.
- Клавиатурная навигация, хоткеи Cmd/Ctrl, сворачивание сайдбара, закрытие и
  изменение ширины деталей перетаскиванием разделителя (мышь и клавиатура).
- `nodexInstall: false`; общий установщик проверяет это поле, пишет причину
  пропуска, отдельно сообщает невалидный package.json и продолжает другие модули.
- Полный `PROMPT.md`, токены и документация, ESLint, Node self-check и Electron smoke.
- M1: `main/git/exec.js` — единственный запуск Git с `spawn`, `shell: false`,
  `--no-pager`, отключённым цветом и неинтерактивным askpass. stdout/stderr
  стримятся в журнал вместе с argv, cwd, кодом, длительностью и временем старта.
- M1: append-only JSONL-журнал в `userData`, последние 2000 записей переживают
  перезапуск. Консоль показывает точный argv/cwd/статус/длительность, поток
  вывода, поиск, фильтр «all / my actions» и копирование записи.
- M1: проверка системного Git при старте, открытие каталога нативным диалогом,
  хранение подключённых репозиториев в `userData` и проверка доступности при
  следующем старте. Ветка и изменения читаются только porcelain-v2 в тулбаре.
- M1: `status-parser.js` разбирает porcelain-v2 без запуска Git: SHA-1/SHA-256,
  detached/unborn HEAD, upstream/ahead/behind, rename/copy, конфликт, игнор,
  вложенные репозитории и NUL-пути.
- M2: `history-parser.js`/`history.js` — постраничный `git log --all
  --topo-order -z` с собственным NUL-форматом (oid/parents/author/dates/
  subject/body), `parseHistoryV1` без запуска Git; `refs.js` — `git
  for-each-ref` (local/remote/tag, upstream+ahead/behind, дереференс
  annotated-тегов, отбрасывание символической `origin/HEAD`).
- M2: `main/git/commit.js` — детали коммита (`git show --no-patch`), список
  изменённых файлов (`diff-tree`/`ls-tree`), дифф файла (`show`/`diff` с
  `:(literal)`) и сравнение диапазона (`diff --name-status`); `history-ipc.js`
  проверяет sender/frame/аргументы и резолвит id репозитория только по уже
  сохранённому списку — путь из renderer никогда не приходит напрямую.
- M2: реальный виртуализованный граф (`features/graph/CommitGraph.jsx`) поверх
  инкрементальной раскладки дорожек (`features/graph/layout.js`, без
  графовой библиотеки) — окно видимых строк считается от `scrollTop`,
  проверено на 100k линейных коммитов (`scripts/checks/graph.mjs`).
- M2: сайдбар LOCAL/REMOTE/TAGS из `refs.js`, ветки с `/` группируются в
  папки (`feat/x/y`), ahead/behind как бейдж; строка «Uncommitted changes»
  первой в дереве открывает рабочее дерево только на чтение; правая панель —
  сообщение, автор, клик по родителю, список файлов и дифф; Shift-клик —
  диапазон между двумя коммитами.

- M3: `diff-parser.js` разбирает однофайловый патч в hunk'и и строки;
  `patch-builder.js` собирает из выбранных строк патч для
  `git apply --cached [--reverse]`; `worktree.js` отдаёт staged/unstaged/
  untracked и дифф файла с отпечатком (`digest`).
- M3: `stage.js` (add/restore/rm --cached/intent-to-add/apply),
  `commit-ops.js` (commit через stdin, stash push/pop/list),
  `sync.js` (fetch/pull/push, только `--force-with-lease`, отмена по
  AbortSignal). `exec.js` получил необязательные `stdin` и `signal`.
- M3: экран рабочего дерева — списки staged/unstaged/untracked, дифф с
  выбором отдельных строк и hunk'ов, окно коммита с проверкой сообщения;
  в тулбаре Pull/Push с бейджами расхождения, Stash и Pop.
- Массовые кнопки в заголовках секций рабочего дерева: «Stage all» отдельно
  для отслеживаемых изменений (`add --update`) и для новых файлов, «Unstage
  all» в Staged. Pathspec'а «только untracked» у Git нет, а `--all` смёл бы
  оба списка в один, поэтому новые пути перечисляются явно и уходят в
  `add --pathspec-from-file=- --pathspec-file-nul` через stdin: список не
  упирается в длину командной строки и не попадает в argv вовсе. Unstage all —
  `reset`: единственная форма, которая работает и до первого коммита, где
  `restore --staged` падает. Список секции читает main из свежего `git status`
  (renderer не присылает пути): массовое действие означает «всё, что в секции
  сейчас». Конфликтный файл запрещает любое из них — `add` пометил бы конфликт
  разрешённым как есть, — а `reset` во время merge/cherry-pick/revert/rebase
  удалил бы маркер операции и молча её отменил, поэтому Unstage all отказан до
  её завершения; в UI кнопка при этом отключена с объяснением.
- Амменд последнего коммита в панели предкоммита (2026-09-06, вне вех):
  чекбокс «Amend last commit» в окне сообщения. Включение подтягивает сообщение
  вершины (`getCommit` по `status.branch.oid`), даёт его отредактировать и меняет
  кнопку на «Amend last commit»; коммит идёт через тот же `worktree:commit` с
  `amend: true`. `createCommit` при amend сверяет HEAD с oid, который показывал
  renderer (`expectedHead`), и отказывается, если ветка уехала — как `rewordHead`;
  argv остаётся `commit --file=- --cleanup=strip --amend`, сообщение по-прежнему
  через stdin. Undo — существующий `reset --soft before.head` для `worktree:commit`:
  он и так восстанавливает исходную вершину и оставляет добавленные файлы в
  индексе. Чекбокс выключен при unborn-ветке и во время merge/rebase/cherry-pick/
  revert; когда вершина уже на upstream (`ahead == 0`), под полем показывается
  предупреждение о переписывании общей истории и необходимости force-push. Amend
  прогоняет те же автоматизации, что commit (`pre-commit`, `commit-msg`,
  `post-commit`), плюс `post-rewrite`. Канал `worktree:commit` теперь принимает
  4 аргумента и **отклоняет** запрос, где `amend` есть, а `expectedHead` не
  строка (или наоборот). Проверки: amend + guard устаревшего HEAD в
  `scripts/checks/stage.mjs` на настоящем Git, сквозной сценарий в
  `worktree-smoke.mjs` (стейдж файла, префилл сообщения, предупреждение об
  upstream, переписанная вершина с неизменным родителем, отказ на устаревшем oid).
- Мультивыбор коммитов и squash (2026-09-06, вне вех): в графе Cmd/Ctrl-клик
  добавляет/убирает коммит из выделения, Shift-клик выделяет непрерывный диапазон
  от якоря; ровно два выделенных по-прежнему открывают дифф-сравнение как раньше.
  Правый клик по выделенному коммиту (когда их ≥2) открывает отдельное меню
  `buildMultiCommitMenu`: пункт «Squash N commits into one…» показывается **только**
  если выделены смежные немерджевые коммиты текущей ветки (`squashable` +
  ancestor-of-HEAD по загруженной истории); при грязном дереве или идущей операции
  пункт остаётся, но выключен с причиной — как у reword. Не подряд / не этой ветки
  → пункта нет вовсе. Squash — это интерактивный rebase (как reword внутри истории):
  `openSquash` читает диапазон `getRebaseCandidates(base)`, отказывает, если
  коммиты не на ветке, и показывает `MessageDialog` (новый проп `allowUnchanged`)
  с уже собранным сообщением. План строит чистый `features/ops/squash-plan.js`:
  самый старый коммит серии → `reword` с объединённым сообщением, остальные серии
  → `fixup`, всё после — `pick`; идёт в тот же `ops:rebase`. Так существующая
  карта сообщений (только `reword`) доносит текст без второго запроса редактора.
  Undo обрывается честно, как у любого rebase. Git на hover/выделение не
  запускается; новых IPC-каналов нет. Проверки: `squash-plan`/`buildMultiCommitMenu`
  в `scripts/checks/history-ops.mjs`, настоящий squash-replay в
  `history-ops-live.mjs`, сквозной сценарий в `ops-smoke.mjs` (мультивыбор,
  скрытый пункт на разрыве, диалог, свёрнутая серия, +1 отказ IPC на плане
  с первым `fixup`).
- M4: контекстное меню коммита (§8.2) целиком — ветка, тег, checkout, merge с
  `--no-ff` и без, rebase, интерактивный rebase, cherry-pick, revert, reset в
  трёх режимах, копирование sha и сообщения. Пункты строит чистая функция
  `features/ops/commit-menu.js`, поэтому применимость проверяется тестом.
- M4: интерактивный rebase выполняет Git, приложение только подставляет себя
  как `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR`. Диалог плана:
  `pick/reword/edit/squash/fixup/drop`, перестановка перетаскиванием, кнопками
  и Alt+стрелками.
- M4: редактор конфликтов — три стадии индекса, редактируемый результат,
  построчный выбор с порядком сторон, свой undo/redo, предупреждение об
  оставшихся маркерах, сверка mtime/размера перед записью, выбор стороны
  целиком для бинарных.
- M4: баннер прерванной операции (вид, шаг N из M, ветка, конфликтные файлы,
  continue/skip/abort) и диалоги подтверждения §6.5 с точным текстом команды.

Не сделано (осознанно вне M4):
- Undo/Redo приложения (§8.1), SSH, remotes, сборка — это M5; первый экран
  Git-профиля уже реализован в текущем рабочем дереве (см. состояние выше).
- Перенос строк мышью между колонками редактора конфликтов (§8.5) не сделан:
  построчный выбор с порядком сторон и свободное редактирование дают тот же
  результат и работают с клавиатуры.
- Отдельного экрана для остановки на `edit` в rebase нет: Git останавливается,
  баннер это показывает, правки делаются на экране рабочего дерева.
- Discard сделан (2026-09-24, см. «Отмена изменений (Discard)» выше); `stash drop`
  есть на экране стешей.
- Дифф-режим «слово в слово» и подсветка синтаксиса сделаны (2026-09-24, см. выше).
- Ввод команд в консоль есть, но только read-only git (см. «Ввод команд в
  консоль — read-only» выше); мутирующие команды и шелл-пайплайны — нет.
- Blame по файлу сделан (см. «Blame, Blame History и Reverse Blame» выше).
  Поиск по истории: по сообщению и хэшу, автору, пути и содержимому (`-S`/`-G`)
  сделан (см. «Поиск по автору, файлу и содержимому» выше).
- Пометки good/bad/skip в графе сделаны (2026-09-24, см. запись выше).
- Worktrees, сабмодули, подписи, патчи, диапазоны cherry-pick/revert и LFS
  сделаны (2026-09-24, см. запись выше).
- Селектор репозитория пока без поиска. Clone есть (M5), фоновый fetch есть
  по согласию (2026-09-24, см. «Фоновый fetch по расписанию»).
  Аватары — инициалы автора коммита (в узле графа и в панели), не изображение:
  Gravatar/фордж — это сеть и внешняя картинка, обе запрещены.
- Нет инсталляторов и ключей SSH; M5 по брифу.
- Проверки конфликтов и инверсий операций появляются вместе с реализацией
  соответствующей вехи; не подменять их тестами заглушек.

## Запуск и проверка

```sh
cd modules/git_desk
npm ci
npm run dev
npm test
npm run build
npm start
npm run test:smoke
```

Нужен Node 20.19+ (LTS 20). Рендерер dev: `127.0.0.1:5188`, без сервера nodex.
Electron 41.7.1 закреплён точно: следующие версии установщика требуют Node 22.12,
что противоречит обязательному Node 20. Перед M5 пересмотреть этот конфликт;
не обновлять Electron через `^` молча. Lock-файл включён локальным `.gitignore`.

Smoke запускает реальный Electron через Playwright и временный userData; при старте
он проверяет установленный Git и показывает эту запись в консоли.
Скриншоты в `artifacts/` (не коммитятся). Удаляет временный профиль при завершении.
Для headless Linux нужен рабочий дисплей/Xvfb, sandbox не отключать.

## Ключевые файлы и решения

- `main/index.js` — окно, локальная политика ресурсов, внешние ссылки и меню ОС.
- `main/ipc.js` — узкие app/workspace/repository/console-каналы; проверяет окно,
  главный frame, точный URL и форму аргументов. Не добавлять универсальный exec.
- `main/history-ipc.js` — история/refs/commit/files/diff/compare/rebase-todo-
  каналы; id репозитория резолвится только по уже сохранённому списку, путь из
  renderer никогда не приходит напрямую.
- `main/console-ipc.js` — единственный канал `console:run-command` для строки
  ввода консоли. Резолвит репозиторий по сохранённому списку, сам гоняет
  `tokenize` + `checkReadOnly` (вердикт renderer не в счёт), отклоняет всё, что
  не read-only git, и запускает разрешённое через тот же `runGit`. Не
  универсальный exec: первый токен обязан быть подкомандой из allowlist.
- `main/git/read-only-command.js` — чистый модуль без импортов (грузят renderer
  и Node-проверка): `tokenize` (шелл-операторы запрещены, раскрытия нет, ведущий
  `git` отбрасывается), `READ_ONLY` (allowlist подкоманд) и `checkReadOnly`
  (guard'ы `branch`/`tag`/`remote`/`stash`/`worktree`/`symbolic-ref`/`reflog`,
  запрет `--output`/`--ext-diff`/`--upload-pack`/… и глобальных опций).
- `main/repo-watch.js` — авторефреш при изменениях извне. Чистый модуль без
  импортов `electron` (Node-проверка гоняет напрямую): `resolveGitDir`,
  `isWatchedPath` (ref'ы/`HEAD`/маркеры — да; `index` и `*.lock` — нет),
  `createRepositoryWatcher(getWindow)` — один `fs.watch` (`persistent:false`,
  дебаунс 300 мс) на git-каталог, шлёт `repo:external-change {cwd}`. Канал
  `repo:watch` живёт в `main/ipc.js` (резолвит репозиторий по сохранённому
  списку, один watcher следует за активной вкладкой). Renderer: `App.jsx`
  выбирает цель, `HistoryWorkspace` перечитывает граф по событию (и по
  `blur`→`focus` > 1.5 с), пропуская собственные операции и эхо своего reload
  (`lastReload` < 1.2 с). Не опрос: `setInterval` нет.
- `main/history-ops-ipc.js` — merge/cherry-pick/revert/reset/rebase/sequencer,
  ветки и теги, конфликты. Каждая мутация отвечает состоянием операции,
  прочитанным **после** запуска: ненулевой код у merge или rebase обычно
  означает конфликт, а не отказ, и отличить их можно только по состоянию.
  `TypeError` из билдеров argv не превращается в ответ «не получилось», а
  отклоняет запрос — иначе заведомо неверный вызов выглядел бы как рабочий.
- `main/worktree-ipc.js` — рабочее дерево, staging, commit, stash и sync.
  Renderer **не присылает содержимое патча**: он отдаёт отпечаток диффа,
  который видел, и индексы строк, а main перечитывает дифф сам и отказывает,
  если файл успел измениться. В индекс не может попасть содержимое, которого
  Git только что сам не выдал.
- `main/security.js` — чистые проверки URL для повторного использования и тестов.
  `isExternalLink` пропускает `https:`/`http:` без credentials и `mailto:` для
  голого адреса без query (ссылка на email автора коммита).
- `main/command-log.js`, `main/store.js` — журнал и атомарное хранилище списка
  репозиториев в `userData`; renderer не получает доступа к файловой системе.
- `main/marks.js` — allowlist цветов марок и `validateMark`/`validateOid` (без
  импортов, грузит и Node-проверка). `main/marks-store.js` — атомарный
  `marks.json` по образцу `store.js`, сериализованные записи, ключ репозитория
  чистится после последней марки. `main/marks-ipc.js` — `marks:list/set/clear`,
  Git не запускает; невалидный запрос отклоняется, а не отвечает.
- `main/git/stash.js` — список стешей, обе их стороны и apply/pop/drop/branch.
  Чтение адресует стеш по oid, мутация — по `stash@{n}` с проверкой oid на этом
  индексе: Git отказывается принимать sha в `stash drop`, а индексы съезжают.
- `main/git/commit-ops.js` — `createCommit`, стеш и `rewordHead`. Reword и
  `createCommit({ amend: true })` сверяют HEAD с oid, который показывал renderer
  (`expectedHead`), и отказываются, если ветка успела уехать: сообщение и
  застейдженные файлы написаны для одного коммита, а `--amend` переписал бы тот,
  которым HEAD стал.
- `renderer/src/features/ops/reword-plan.js` — план rebase для переименования
  коммита внутри истории. Импортов нет: его грузит и Vite, и Node в проверке.
- `renderer/src/features/ops/squash-plan.js` — `squashable` (смежность серии,
  немердж, ≥2) и `buildSquashPlan` (reword старейшего + fixup остальных + pick
  хвоста). Импортов нет; `commit-menu.js` берёт из него `squashable`.
- `main/git/bisect.js` — argv и состояние bisect: маркеры под git-каталогом,
  `refs/bisect/*` и `rev-list --bisect-vars` вместо разбора фразы Git.
  Термины (`bad`/`good` или свои) читаются из `BISECT_TERMS` и валидируются
  перед попаданием в argv.
- `renderer/src/ui/Splitter.jsx` + `ui/panel-width.js` — вертикальный разделитель
  между графом и панелью коммита вместо прежнего ползунка «Panel width»,
  а также справа от левого сайдбара (160–400 px, по умолчанию 212 px).
  Оба разделителя работают в демо и реальном репозитории; ширина сайдбара
  сохраняется при сворачивании и переключении вкладок в текущей сессии.
  Отдельная колонка grid'а, `role="separator"`, drag через pointer capture,
  стрелки/Home/End с клавиатуры, двойной клик — сброс. Ширина клампится
  чистой функцией с полом для графа: доступное место меряется в момент
  действия (две соседние панели, без ширины разделителя), без ResizeObserver и таймеров.
  `panel-width.js` без импортов: его грузит и Vite, и Node в проверке.
- `renderer/src/features/graph/ref-lines.js` — перенос плашек столбца
  `Branch / tag` по строкам: `badgeWidth`, `packRefLines` (жадная укладка,
  `lead` под галку HEAD и марку), `extraHeight`, `REF_LINE_HEIGHT`. Импортов
  нет: его грузит и Vite, и Node в проверке. Ширину имён меряет `CommitGraph`
  через `canvas.measureText` тем же шрифтом; высоты строк складывает
  `createRowMetrics` из `layout.js` (разреженные добавки + бинарный поиск).
- `renderer/src/features/graph/column-widths.js` — регулируемые ширины столбцов
  истории (`branch`/`graph`/`message`/`author`/`date`; все фиксированные, слабину
  добирает хвостовой `1fr`-трек грида, `graph` default `null` = авторазмер по
  дорожкам):
  `HISTORY_COLUMNS`, клампы, нормализация, `read/writeColumnWidths`
  (`twig:history-columns` в `localStorage`), `dragColumnWidth`/`nudgeColumnWidth`.
  Импортов нет: его грузит и Vite, и Node в проверке. `CommitGraph` рендерит
  маркеры `role="separator"` на правом краю ячеек шапки, проставляет `--col-*`
  инлайном и держит шапку в синхроне со скроллером по `scrollLeft`; `history.css`
  держит дефолты и `--table-min-width`.
- `renderer/src/features/worktree/worktree-summary.js` — деление
  `repository.status.entries` на staged/changed/untracked без запуска Git:
  `summarizeStatus` (то же правило, что `loadWorktree` в `main/git/worktree.js`;
  `paths` считает пути, а не строки списков), `summaryChips`, `summaryLabel`,
  `conflictCount`, `SECTIONS`. Импортов нет: его грузят и Vite, и Node-проверка.
  `WorktreePanel.jsx` рисует по нему правый блок для строки `Uncommitted
  changes` — списки, фильтр, плюс/минус на файле и Stage all / Unstage all;
  сам он `window.twig.*` не зовёт, действия приходят из `HistoryWorkspace`
  (`stagingActions`) и идут теми же каналами, что экран staging.
  `CommitGraph.jsx` — чипы на самой строке и константу `UNCOMMITTED`.
- `renderer/src/features/refs/remote-ref.js` — к какому remote относится
  `refs/remotes/...`. Импортов нет: его грузит и Vite, и Node в проверке.
- `renderer/src/features/commit/forge-url.js` — remote URL → веб-ссылки на
  коммит и коммиты автора в GitHub/GitLab/Bitbucket. Импортов нет: его грузит и
  Vite, и Node в проверке. Credential-bearing и неизвестные адреса дают null.
- `main/git/blame.js` — `buildBlameArgv` / `buildReverseBlameArgv` (путь сырым
  после `--`), `parseBlamePorcelain` (`--line-porcelain`: метаданные, boundary,
  previous, filename с C-раскавычиванием, ведущий таб строки сохраняется, NUL →
  `BlameError` code `binary`), `loadBlame` / `loadReverseBlame` / `loadBlameBefore`
  (последний читает `previous` авторитетно, для merge отдаёт выбор родителя).
- `main/git/blame-map.js` — `mapLineBack(patch, newLine)`: строка на новой
  стороне дифф-ханка → диапазон на старой + `exact` + пояснение. Импортов нет:
  грузит и Vite, и Node; используется и в `main`, и в проверке.
- `main/blame-ipc.js` — `blame:file|reverse|before|cancel`. Один in-flight blame
  на репозиторий (новый запрос рвёт прежний через `AbortController`), репозиторий
  только из сохранённого списка, oid/ref/путь/строки валидируются; невалидный
  запрос отклоняется, валидный-но-неудобный ответ (нет предка, файла нет в Start)
  возвращается как `{ kind: 'error', … }`.
- `renderer/src/features/blame/{BlameView,BlameDetail}.jsx` + `blame-cache.js`
  (кэш до 16 записей, ключ repo+режим+oid+путь+endOid). BlameView — центр,
  BlameDetail — правая панель, оба монтируются в `HistoryWorkspace` рядом с
  `fileHistory` (state `blame`/`blameSel`, ширина через `fileHistoryWidth`).
- `renderer/src/features/graph/age-color.js` — возраст коммита → ступень рампы
  (`AGE_STOPS`, `ageStop`, классы `graph-age-N`/`age-text-N`). Импортов нет:
  его грузит и Vite, и Node в проверке. Шкала абсолютная, а не относительно
  загруженной истории.
- `renderer/src/features/graph/mark-color.js` — палитра марок (`MARK_COLORS`,
  `MARK_LABELS`, `markClass`). Импортов нет; `marks.mjs` сверяет её с allowlist
  в `main/marks.js`.
- `main/git/exec.js` — единственное место `spawn('git', ...)`; принимает
  необязательные `stdin` (патч и сообщение коммита не пишутся на диск и не
  попадают в журнал — в подписи операции только их размер), `signal`
  (отмена pull/push) и `env` (редакторы rebase на один запуск; глобально их
  выставлять нельзя, а консоль показывает argv, не окружение — поэтому
  вызывающий обязан сказать про редактор в подписи операции). `repository.js`, `history.js`, `refs.js`, `commit.js`,
  `worktree.js`, `stage.js`, `commit-ops.js`, `sync.js` строят безопасные argv;
  `status-parser.js`/`history-parser.js`/`diff-parser.js`/`patch-builder.js`
  ничего не исполняют.
- `main/git/rebase.js` + `sequence-editor.cjs` / `message-editor.cjs` — ядро
  интерактивного rebase. Git зовёт редактор сообщения **один раз на цепочку**
  squash/fixup, а не на строку, и ещё раз на каждом `--continue` после
  конфликта, поэтому сообщения привязаны к oid из `rebase-merge/done`, а не к
  номеру вызова: позиционная очередь разъезжается на первом же конфликте.
  План лежит в `userData`, никогда внутри репозитория, и стирается, как только
  операция закончилась.
- `main/git/operation-state.js` — какая операция идёт. Читает маркеры под
  git-каталогом (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
  `rebase-merge/{msgnum,end,head-name}`): машинного формата для этого у Git
  нет, а человеческий вывод `git status` парсить запрещено §6.3.
- `main/git/history-ops.js` — merge/cherry-pick/revert/reset/continue-skip-abort.
  `git merge --continue` не принимает **никаких** других аргументов, `--no-edit`
  отвергается, поэтому свой `GIT_EDITOR` ставится на каждую операцию — иначе
  Git молча уходит в vi и висит без вывода.
- `renderer/src/features/conflicts/conflict-parser.js` — разбор маркеров обоих
  стилей (`merge` и `diff3`/`zdiff3`) и замена одного региона по номерам строк.
  Живёт в рендерере, а не в `main/git/`: редактор перечитывает текст на каждое
  нажатие клавиши, IPC на это абсурден; импортов нет вовсе, его грузит и Vite,
  и Node в проверке.
- `main/git/patch-builder.js` — ядро staging'а по строкам. Классификация и
  нумерация строк **зеркальны** для staging и unstaging: `git apply` при
  `--reverse` сопоставляет с индексом новую сторону патча, а не старую.
- `renderer/src/features/diff/intraline.js` — построчный дифф изменённых
  символов: `segmentPair` (символьный LCS → `same/del/add`, `null` при
  равенстве / длине > 400 / общего < 30 %), `segmentHunkLines`, `annotatePatch`.
  Импортов нет: грузят и Vite, и Node-проверка. `renderer/src/features/diff/
  DiffLines.jsx` — общий рендер тела диффа (панель коммита, стеши, blame);
  `StageDiff` подключает сегменты напрямую.
- `renderer/src/features/diff/file-status.js` — `FILE_STATUS` (буква статуса →
  `{label, className}`) и `fileStatus` (нормализация ведущей буквы, `R100`→`R`,
  `?`, пробел/неизвестное → нейтральный бейдж). Импортов нет: грузят Vite и
  `scripts/checks/file-status.mjs`. Компонент `FileStatus.jsx` — цветной
  квадратик с буквой (панель коммита, рабочее дерево, файлы стеша).
- `preload/index.js` — ESM-исходник; esbuild → `dist/preload/index.cjs` для sandbox.
  Это требование Electron: sandboxed preload не поддерживает ESM напрямую.
- `renderer/src/app` — окно, вкладки и панели; `Console.jsx` — только развёрнутая
  консоль (бывший `Panels.jsx`, демо-компоненты удалены). Статичного демо больше
  нет: вкладка `workspace-demo` — реальная песочница (см. `main/git/sandbox.js`).
- `main/git/sandbox.js` — `sandboxPlan()` (чистый список коммитов),
  `runSeed`/`resetSandbox`/`ensureSandbox` для `userData/demo-sandbox` и локального
  bare-remote. `createRepositoryService` инъектит песочницу первой в снапшот, не
  персистит; `resetSandbox()` (канал `sandbox:reset`) чистит Undo и марки.
- `features/graph/HistoryWorkspace.jsx` — экран открытого репозитория: сайдбар,
  граф, правая панель, рабочее дерево. `CommitGraph.jsx` — виртуализация и
  клавиатура. `layout.js` — инкрементальная раскладка дорожек (без библиотеки).
  `features/commit/CommitPanel.jsx` — детали коммита, файлы, дифф.
- `ui/tokens.css` — точная копия CSS из `design/TOKENS.md`, паритет проверяет npm test.
  `ui/history.css` — стили реального графа/сайдбара/панели на тех же токенах.
- `scripts/checks/foundation.mjs` — URL-политика, контраст, паритет токенов,
  opt-out/default/error установщика в изолированном temp с подставным npm.
- `scripts/checks/status-parser.mjs`, `git-exec.mjs` — porcelain-v2 и
  исполнитель/журнал/временный реальный репозиторий без shell-команд.
- `scripts/checks/history.mjs`, `refs.mjs` — парсеры `git log`/`for-each-ref`
  и их argv-билдеры, без запуска Git.
- `scripts/checks/commit.mjs` — `main/git/commit.js` (детали/файлы/дифф/сравнение).
- `scripts/checks/graph.mjs` — раскладка дорожек: слияния, root-коммиты,
  непрерывность между страницами, 100k линейных коммитов; плюс геометрия строк
  разной высоты (`createRowMetrics` против наивной префиксной суммы, окно
  видимых строк, `segmentPath` от высоты) и перенос плашек `packRefLines`.
- `scripts/checks/age-color.mjs` — границы ступеней возраста, дата в будущем,
  нечитаемая дата и паритет: у каждой ступени есть токен в обеих темах и оба
  класса в `history.css`. Контраст всех десяти цветов со всеми поверхностями
  проверяет `foundation.mjs`.
- `scripts/checks/panel-width.mjs` — клампинг ширины панели коммита и
  направление перетаскивания (панель справа, движение влево её расширяет),
  а также удвоенный максимум `FILE_HISTORY_PANEL_SIZE` для истории файла.
- `scripts/checks/column-widths.mjs` — регулируемые столбцы истории: набор из
  пяти столбцов, клампы и округление, `graph`-null (нет drag → авторазмер),
  `dragColumnWidth`/`nudgeColumnWidth`, нормализация мусора и выхода за диапазон,
  round-trip через фейковый storage (graph auto и graph pinned) и откат к
  дефолтам на падающем/битом storage.
- `scripts/checks/marks.mjs` — паритет палитры марок renderer↔main, `validateMark`
  (плохой цвет/oid, длина и NUL заметки), атомарный `MarksStore` (изоляция по
  репозиториям, параллельные записи, чистка ключа, persist во временном каталоге).
- `scripts/checks/forge-url.mjs` — разбор всех форм remote URL, отказ на
  локальных/credential/неизвестных адресах, построение commit- и author-ссылок
  для GitHub/GitLab/Bitbucket, `pickRemoteUrl` (origin → upstream → любой фордж).
- `scripts/checks/diff-parser.mjs`, `conflict-parser.mjs` — разбор патча и
  маркеров конфликта, без запуска Git.
- `scripts/checks/intraline.mjs` — построчный дифф символов: реконструкция обеих
  сторон из сегментов, guard'ы длины и похожести, парность в хунке и в патче,
  строки-заголовки патча не парятся, паритет имён классов с `history.css`.
- `scripts/checks/worktree-summary.mjs` — деление статуса на три списка:
  путь в обоих списках, `paths` по путям, игнор вне счёта, мусор на входе, чипы
  и подпись, **паритет с `loadWorktree`** на настоящем `porcelain=v2` и сверка
  пяти строк его кода, паритет классов с `history.css`, и что `uncommitted`
  остался выбором, а не экраном.
- `scripts/checks/file-status.mjs` — бейдж статуса файла: нормализация
  `fileStatus`, паритет имён классов с `history.css` (каждый залит токеном
  марки), контраст `--bg` на каждой заливке `--mark-*` ≥ 3:1 в обеих темах.
- `scripts/checks/blame.mjs` — argv-билдеры (путь после `--`, не `:(literal)`),
  `parseBlamePorcelain` (таб в коде, boundary, previous, C-кавычки, NUL→binary),
  `mapLineBack`, и **на настоящем Git**: атрибуция при add/change/delete строк,
  `loadBlameBefore` (previous-цепочка, root, переименование), reverse blame
  A→B→C (удаление в C → B), Start=End guard, имена с пробелами/Unicode/дефисом.
- `scripts/checks/history-ops.mjs` — argv merge/cherry-pick/revert/reset/
  rebase/веток/тегов/конфликтов, валидация имён по git-check-ref-format,
  план rebase и применимость пунктов контекстного меню. Без запуска Git.
- `scripts/checks/history-ops-live.mjs` — **запускает настоящий Git**:
  конфликтующий merge, разрешение, continue и abort, взятие стороны целиком,
  cherry-pick, revert, `reset --hard`, интерактивный rebase с перестановкой,
  reword, squash и drop, конфликт внутри rebase, бинарный файл. Иначе
  недоказуемо главное: что rebase проигрывает **наш** план, а не собственный
  todo Git.
- `scripts/checks/stash.mjs` — **запускает настоящий Git**: список и его
  порядок, обе стороны стеша (tracked-дифф и дерево `^3`), дифф untracked-файла,
  отказ по устаревшему oid, apply/drop/branch и перенумерация индексов.
- `scripts/checks/bisect.mjs` — **запускает настоящий Git**: полный поиск на 12
  коммитах, седьмой из которых сломан, — и проверяет, что найден именно он;
  skip, чужие термины, reset и валидация argv.
- `scripts/checks/patch-builder.mjs`, `stage.mjs` — **запускают настоящий Git**
  во временном репозитории, в отличие от парсерных проверок. Иначе корректность
  патча недоказуема: единственное доказательство — что его принял
  `git apply --cached` и в индексе ровно выбранное. `stage.mjs` дополнительно
  проверяет unborn-ветку, стеш и pull/push против локального bare-репозитория,
  а для массовых действий — что `add --update` не трогает новые файлы, что
  untracked-каталог и имя с glob-символами доходят до индекса, что Unstage all
  не трогает рабочее дерево, и что конфликтный merge отвергает оба действия и
  переживает отказ (`MERGE_HEAD` на месте).
- `scripts/checks/repo-watch.mjs` — авторефреш: `isWatchedPath` (ref'ы/маркеры
  да, `index`/`*.lock` нет), `resolveGitDir` на настоящем temp-`.git` (каталог,
  `gitdir:`-файл, отсутствие) и **реальный `fs.watch`** — событие на смену ref'а,
  дебаунс одной пачки, молчание на `.lock`, `watch(null)` глушит.
- `scripts/smoke.mjs` — сквозная проверка окна M0/M1 (демо, sandbox, темы),
  включая перетаскивание разделителя мышью, стрелку с клавиатуры и сброс
  двойным кликом — измеряется настоящая ширина панели, не значение состояния.
  Список ключей моста в нём сверяется точно — новый метод preload обязан
  осознанно пройти через эту проверку (`watchRepository`, `onRepositoryChange`).
- `scripts/history-smoke.mjs` — сквозная проверка M2 на настоящем временном
  Git-репозитории: две страницы истории, слияние, annotated-тег, клавиатура,
  вкладки, дифф файла, рабочее дерево, отказ IPC на некорректных аргументах,
  а также цвет по возрасту: фикстура датирована задним числом (корни 2019 года,
  линейная история 45 дней, вершина — сегодня), проверяются ступени рампы на
  экране, переключение на цвета веток, легенда и то, что выбор переживает
  перезагрузку. Локальные марки: постановка из контекстного меню, выбор цвета и
  заметка в панели, подсветка строки, устойчивость к reload, снятие марки и три
  отказа IPC (плохой oid/цвет, чужой репозиторий). Построчный дифф символов:
  правка hello.txt на вершине даёт `.diff-seg-add` и `.diff-seg-del` в реальном DOM.
  Регулируемые столбцы: маркеры `Branch / tag`, `Commit message` и `Graph`
  тянутся шире, `--col-branch`/`--col-message`/`--graph-width` растут и
  переживают перезагрузку, двойной клик по `Graph` возвращает авторазмер.
  Авторефреш: коммит, сделанный внешним `git` уже после запуска приложения,
  появляется в графе сам, без кнопки Refresh.
- `scripts/ops-smoke.mjs` — сквозная проверка M4: контекстное меню мышью и с
  клавиатуры (Shift+F10), конфликтующий merge, редактор конфликтов с выбором
  строк и своим undo/redo, баннер, диалог подтверждения `reset --hard` с
  точным текстом команды, интерактивный rebase с перестановкой и reword,
  переименование вершины (индекс при этом не втягивается в коммит) и коммита
  внутри истории, отказ IPC на неверном режиме/имени/шаге/пути/oid/сообщении. Скриншоты новых экранов —
  `artifacts/m4-{menu,conflict,confirm,rebase,dark,light,menu-dark,menu-light}.png`.
- `scripts/blame-smoke.mjs` — реальный Electron: «Blame history» из меню файла,
  заголовок `путь at <sha>`, навигация строк с клавиатуры, «Blame before this
  change» (шаг в прошлое), Back/Forward, Reverse blame Start→End с «present at
  end» / «last present in», недопустимый диапазон с причиной, «Go to commit»
  возвращает в граф, Unicode-имя файла, **HEAD/индекс/дерево не изменились**,
  6 отказов IPC (плохой oid, traversal, чужой репозиторий, номер строки 0,
  ref с пробелом, абсолютный путь), обе темы 1000×640
  (`artifacts/blame-{dark,light}.png`).
- `scripts/browse-smoke.mjs` — пятый реальный Electron: экран веток (поиск,
  удаление слитой ветки, отказ на неслитой и `-D` через §6.5, upstream из
  списка remote-веток), удаление ветки на настоящем локальном bare-remote и
  публикация тега — оба с точным текстом команды, полный bisect до посаженного
  сломанного коммита, экран стешей с untracked-файлом, drop и pop, двенадцать
  видов неверного ввода IPC и обе темы. Скриншоты — `artifacts/m5-{branches,
  bisect,bisect-done,stash}*.png`.
- `scripts/worktree-smoke.mjs` — сквозная проверка M3: staging отдельных
  строк, unstaging, коммит, бейдж push и сам push против локального bare,
  массовые Stage all по каждой секции отдельно и Unstage all (индекс сверяется
  настоящим `git diff --cached`, новый файл после этого остаётся untracked, а
  не удалённым), отказ IPC на устаревшем отпечатке, traversal-пути и
  неизвестной секции. Снимки со свёрнутой консолью —
  `artifacts/m3-bulk-{dark,light}.png`. При таймауте печатает текст ошибки со
  страницы, а не только «локатор не найден».
- `scripts/app-identity.mjs` — имя и иконка приложения в Dock и меню macOS при
  запуске из исходников. Без упаковки macOS берёт их из запущенного бандла
  `node_modules/electron/dist/Electron.app`, поэтому `app.setName` не помогает —
  проверено отдельным мини-приложением. Лаунчеры `dev.mjs` и `start.mjs` правят
  `CFBundleName`, `CFBundleDisplayName` и `CFBundleIconFile` этого бандла через
  `plutil`. Шаг идемпотентен и переживает `npm ci`, потому что выполняется на
  каждом запуске. Он безопасен, пока ad-hoc подпись Electron не покрывает
  Info.plist (`Info.plist=not bound`); если покроет — шаг пропускается с
  предупреждением, а не ломает подпись. Упакованное приложение берёт имя из
  `build.productName` и этой правки не требует.

- `main/automation/engine.js` — `triggerPipeline({ event, ... })`: собирает
  контекст (ветка, изменённые/staged файлы, добавленные строки) **в main из
  самого git**, отбирает пайплайны события, проверяет условия, гоняет действия
  по порядку, стримит шаги, пишет запись в стор. `selectPipelines` пускает
  repo-пайплайн только если digest совпал и все его команды одобрены.
- `main/automation/actions.js` — диспетчер действий; процесс запускают только
  `command`/`custom`/`script` через `runStep`, остальные — чистые проверки.
- `main/automation/exec.js` — единственное место `spawn` не-git процесса;
  `shell: false`, журнал с `executable`, таймаут, отмена, cap вывода 1 МБ.
- `main/automation/discovery.js` — чтение `.git/hooks/*` (absent/twig/foreign) и
  `.twig/hooks.json` + `digestBytes`. Ничего не исполняет.
- `main/automations-store.js` / `main/automation-runs-store.js` — атомарные
  per-repo JSON по образцу `marks-store.js`.
- `renderer/src/features/automations/*.js` — чистые модули (см. выше). `*.jsx`:
  `AutomationsScreen` (список+редактор+логи), `PipelineEditor`, `ExecutionPanel`
  (оверлей и тело записи лога), `ExecutionLog`, `TrustPrompt`.
- `renderer/src/features/graph/HistoryWorkspace.jsx` — `runAutomation(event)`
  возвращает «можно продолжать»; `performGated(pre, post, run, success)`
  оборачивает мутации истории. Экран `automations` добавлен в `SCREENS`.
- `renderer/src/features/worktree/WorktreeScreen.jsx` — гейт pre-commit →
  commit-msg перед `createCommit`, post-commit после.
- `renderer/src/app/App.jsx` — гейт pre-push перед `runSync` push, свой оверлей.

UI/UX-скилл прочитан и выполнен перед M0; принятые/отклонённые рекомендации
в `design/TOKENS.md`. Новый экран требует повторного прогона скилла по брифу.

## Запреты

Не читать реальные репозитории через renderer; единственный запуск Git —
`main/git/exec.js`, `spawn('git', argv, { cwd, shell: false })` с журналированием.
Не запускать Git «временно» для заполнения макета: консоль не должна врать.
**Единственное санкционированное исключение из «только git» — автоматизации
(M6):** локальные процессы запускает `main/automation/exec.js`,
`spawn(exe, argv, { shell: false })`, всегда без шелла, с журналированием
(`executable`), таймаутом и отменой. `shell: true` запрещён где угодно; цепочку
команд выражают несколькими действиями, а не строкой. Конфиг из репозитория
(`.twig/hooks.json`) — недоверенные данные: не исполнять до явного включения
человеком через `TrustPrompt`. Ярлык действия не заменяет команду — точная
команда видна в редакторе, оверлее выполнения, консоли и trust-запросе.
Не давать renderer доступ к fs, process, ipcRenderer или произвольным каналам.
Не отключать sandbox/contextIsolation. Запрещены webviews и внешняя навигация.
Никаких сетевых запросов из приложения кроме Git, автоматизаций пользователя
(это его команды: `npm test` и т. п. могут ходить в сеть — это ожидаемо и
показано; сам код автоматизаций в сеть не ходит) и **обновления из
приложения** (см. запись «Обновление из приложения»): запрос к GitHub Releases
по нажатию кнопки, а автоматически — только если в Settings → «Check
automatically» выбрано «At launch and daily» (по умолчанию Off); установщик
качается **только по нажатию** Update и только с `github.com/kitarasenka/twig/
releases/download/` (+ хранилище `*.githubusercontent.com`), принимается только
при совпадении размера и SHA-256 из релиза. **Сам по себе** 🌱 Twig ходит в сеть
только фоновым fetch и этой проверкой, и только после явного выбора в Settings —
никакой другой фоновой сети добавлять нельзя.
В dev только localhost Vite.
Никаких внешних шрифтов/изображений. Цвета только из TOKENS.md.
Без подписей и телеметрии. Второе санкционированное исключение из «только git»
— `main/updater.js`: hdiutil/ditto/plutil/codesign/xattr через `runStep` (без
шелла, в журнале) и отсоединённый перезапуск — `/bin/sh -c <константный
RELAUNCH_SCRIPT>` с pid и командой позиционными аргументами (данные в текст
скрипта не подставляются). Не трогать другие модули.

## Проверки M0–M4

Проверено 2026-09-05 на macOS arm64 / Node 20.20.0 / git 2.54.0:
- `npm test` — 13 проверок зелёные: ESLint, foundation, `status-parser`/
  `git-exec`/`history`/`refs`/`commit`/`graph`/`diff-parser`/`patch-builder`/
  `stage`/`conflict-parser`/`history-ops`/`history-ops-live`. `graph.mjs`
  прогоняет раскладку дорожек на 100k линейных коммитов (~70 мс) и проверяет,
  что видимое окно строк ограничено.
- `node scripts/worktree-smoke.mjs` (часть `npm run test:smoke`) — третий
  реальный Electron: выбор строк в диффе и staging только их, unstaging,
  коммит из окна сообщения, бейдж расхождения и push против локального
  bare-репозитория, отказ IPC на устаревшем отпечатке диффа, traversal-пути и
  пустом сообщении. Скриншоты — `artifacts/m3-{dark,light}.png`.
- `npm run build` — preload + production renderer, без предупреждений.
- `node scripts/smoke.mjs` — реальный production Electron, демо M0/M1:
  sandbox/bridge (актуальный список каналов), выбор и клавиатура, табы,
  фильтр, консоль, тёмная/светлая тема, сохранение темы при reload,
  ширина 1000 px, блокировка сети.
- `node scripts/history-smoke.mjs` (часть `npm run test:smoke`) — второй
  реальный Electron с временным настоящим Git-репозиторием: root-коммит,
  ветка, merge с двумя родителями, 259 линейных коммитов, annotated-тег,
  untracked-файл. Проверены обе страницы истории, открытие по клику,
  клавиатура (стрелки), переключение вкладок между репозиториями, дифф файла,
  экран рабочего дерева, переход по ссылке на ветку, отказ IPC на
  отрицательном `skip`/незарегистрированном id/невалидном oid/traversal-пути,
  обе темы и компактная ширина без горизонтального скролла. Скриншоты —
  `artifacts/m2-{dark,light,compact}.png`.
- `node scripts/ops-smoke.mjs` (часть `npm run test:smoke`) — четвёртый
  реальный Electron: контекстное меню правой кнопкой и с клавиатуры,
  конфликтующий merge, редактор конфликтов (выбор строк с обеих сторон, порядок
  сторон, свой undo/redo), баннер с блокировкой Continue до разрешения,
  подтверждение `reset --hard` с точным текстом команды и проверкой, что отмена
  ничего не делает, интерактивный rebase с перестановкой и reword — сверен
  реальный `git log` после него, отказ IPC на пяти видах неверного ввода.
  Скриншоты — `artifacts/m4-*.png`.
- `node scripts/smoke.mjs --dev` — тот же M0/M1-прогон через Vite; HMR работает.
- Визуальный обзор скриншотов M4: меню, редактор конфликтов и диалог rebase
  просмотрены в обеих темах. По итогам обзора исправлено: меню открывалось без
  фокуса (замер идёт при `visibility: hidden`, а скрытый элемент не принимает
  `.focus()`), диалог rebase уезжал за край базовой ширины 480 px, разрушающий
  пункт меню не отличался от остальных. Снимок редактора конфликтов делается со
  свёрнутой консолью — это та высота, которую он реально получает в работе.
- Визуальный обзор скриншотов M2: плотность строки, бейджи веток/тегов,
  раскладка дорожек и правая панель совпадают с референсом `PROMPT.md` §1 в
  обеих темах; контраст токенов по-прежнему проверяет `foundation.mjs`
  (палитра M2 не менялась).
- `git diff --check` — чисто. Windows/Linux физически не запускались; не считать
  наличие кроссплатформенных путей и хоткеев проверкой нативных сборок.

Аудит безопасности: main проверяет sender/frame/аргументы IPC; file URL декодируется
и проверяется через path.relative (включая traversal), внешние схемы отсекаются,
renderer не видит Node. M4 не запускает Git вне `exec.js`; `history-ipc.js`,
`worktree-ipc.js` и `history-ops-ipc.js` резолвят id репозитория только по уже
сохранённому и проверенному списку — произвольный путь из renderer недостижим.
Имена веток и тегов проходят через `validateRefName` (git-check-ref-format) и
идут в argv после `--`, так что имя `--force` остаётся именем; это закреплено
тестом. Ошибка валидации всегда **отклоняет** IPC-запрос, а не превращается в
ответ «не получилось»: иначе заведомо неверный вызов выглядел бы как рабочий —
поймано сквозной проверкой, не ревью. Файл конфликта резолвится через
`path.resolve` + `path.relative` внутри рабочего дерева, содержимое пишется
только после сверки mtime и размера. Переменные окружения редакторов ставятся
на один запуск и не могут перекрыть `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS` и
`ELECTRON_RUN_AS_NODE`, которые `exec.js` применяет последними. `commit.js`,
`worktree.js` и `stage.js` валидируют oid (hex 40/64) и путь файла (без `..`,
без ведущего `/`, без NUL) и передают путь как `:(literal)<path>` после `--`,
так что имя, похожее на флаг или glob, остаётся именем. Содержимое патча в
main из renderer не приходит вовсе — только отпечаток и индексы строк.
Сообщение коммита и патч идут в Git через stdin, не через argv и не через
временный файл, и в журнал попадает только их размер. Парсеры
(`history-parser.js`, `refs.js`, `diff-parser.js`) отвергают некорректный
ввод статической ошибкой без утечки данных репозитория — покрыто тестами.
Из разрушающего доступны `push --force-with-lease` (голый `--force` не
предусмотрен ни одним путём кода, это закреплено тестом) и `reset --hard` —
последний только через диалог §6.5 с точным текстом команды. `branch -D` в
IPC не выведен вовсе.
Аудит производительности: подписки снимаются, переключение вкладок сохраняет DOM,
нет таймеров опроса и запросов/N+1. Журнал хранит в памяти максимум 2000 записей.
История грузится страницами (`--max-count`/`--skip`), виртуализация рендерит
только видимое окно строк; `graph.mjs` подтверждает линейный, не квадратичный
рост раскладки дорожек на 100k коммитов. Живой прогон таких объёмов через
Electron не делался — `history-smoke.mjs` использует 259 коммитов, этого
достаточно для проверки логики пагинации, но не для профилирования UI.
Рабочее дерево читается одним `git status` на весь список (не по файлу) и
одним `git diff` на открытый файл; расхождение для бейджей считается из
`for-each-ref`, без сетевого вызова. Дифф рендерится целиком, без
виртуализации: на файле в десятки тысяч изменённых строк это будет заметно —
предел не измерялся, ориентир — `content-visibility: auto`. То же относится к
редактору конфликтов (файл целиком в textarea, потолок 5 МБ) и к плану rebase
(до 1000 строк без виртуализации; число выбрано с потолка). Состояние
операции — это чтение нескольких мелких файлов плюс один `git status`, оно
запрашивается по событию, а не по таймеру.

Уроки запуска: top-level `await app.whenReady()` блокирует готовность ESM-приложения;
использовать `.then(...)`. Лаунчеры очищают `ELECTRON_RUN_AS_NODE`, которую может
наследовать среда разработки, иначе Electron стартует как Node, без окна.

## Визуальное оформление 🌱 Twig

Пользователь выбрал оригинальный логотип `design/twig-logo.png`. Его исходные
байты сохранены; для UI приготовлена уменьшенная копия 128 px, для ОС — PNG
1024 px, ICNS и ICO в `build/`. Перерисовки нет. Воспроизведение производных
файлов описано в `design/ASSETS.md`. `BrowserWindow.icon` и macOS Dock используют
эти файлы; electron-builder получает пути к платформенным иконкам из package.json.

Палитра TOKENS.md и CSS синхронно обновлены: лесной зелёный, лаймовый, мятный,
кремовый; светлая тема затемняет подписи. Семантические токены дорожек:
`--lane-mint`, `--lane-cream`, `--lane-leaf` вместо старых названий цветов.
Контраст всех текстовых токенов со всеми поверхностями проверяет foundation check.
Логотип присутствует в шапке, на пустой вкладке и в favicon.

Визуальный прогон: production-сборка и Electron smoke прошли на macOS; обе темы
просмотрены на снимках. Smoke завершает CSS-переходы перед снимком, чтобы не
зафиксировать промежуточную смесь тем. Форматы ICNS/ICO созданы, но нативная
упаковка/запуск Windows и Linux по-прежнему не проверены (M5).
Аудит визуальных правок: локальные растровые ресурсы, уменьшенная UI-копия;
новых IPC-каналов, сетевых запросов, слушателей и таймеров нет.
