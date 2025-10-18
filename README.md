# Single-Slot Music Queue

Веб-сервис: один «слот» воспроизведения, пользователи ставят треки в очередь.  
Техстек: Node.js + Express + Prisma + PostgreSQL, фронт — статика, стрим через `/api/stream`.

## Локальный запуск (Docker)
```bash
docker compose build
docker compose up

