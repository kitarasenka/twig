# Переезд из монорепозитория

🌱 Twig раньше жил в приватном монорепозитории `nodes-managers` как
`modules/git_desk`. GitHub Pages для приватного репозитория требует плана
Enterprise, поэтому модуль выделен в этот отдельный **публичный** репозиторий.

## Как выделяли

```sh
# в nodes-managers
git subtree split --prefix=modules/git_desk feat/git-desk -b twig-export
# в этом репозитории
git fetch /путь/к/nodes-managers twig-export
git checkout -B main FETCH_HEAD
# поверх — незакоммиченная на тот момент работа «вне вех» из рабочего дерева
# модуля, одним импорт-коммитом
```

История коммитов M0…M6 сохранена. Пути в старых коммитах остались с префиксом
`modules/git_desk/` — это ожидаемо после `subtree split`.

## Что изменилось в коде

- `# modules/git_desk` → `# twig` в `CLAUDE.md`; ссылки на монорепо и nodex
  вычищаются по мере правок, не разом.
- Появился `.github/workflows/site.yml` — сборка и публикация `site/` на
  GitHub Pages этого репозитория (см. `site/README.md`, раздел «GitHub Pages»).
- Команды разработки и проверок не изменились: `npm ci`, `npm run dev`,
  `npm test`, `npm run build`, `npm run test:smoke`.

## Монорепозиторий

В `nodes-managers/modules/git_desk` осталась незакоммиченная копия того же
состояния. Она намеренно не тронута; дальнейшая разработка Twig идёт здесь.
Если из монорепо понадобится донести отдельные правки — снова `subtree split`
и `git cherry-pick`, но обычный путь теперь обратный: этот репозиторий —
источник правды.
