# Calories Info Microservice

Микросервис для поиска продуктов и учёта питания (калории и БЖУ) поверх PostgreSQL.

- Поиск продуктов:
  - локальный словарь в `personal.food_dict`;
  - внешний источник USDA (по ключу API);
  - автоматический перевод RU → EN и EN → RU для запросов.
- Учёт съеденного в логах `personal.food_log`.
- Подсчёт дневной статистики (суммарные калории/БЖУ и сколько осталось до дневных целей).
- Интеграция с GPT для оценки примерных БЖУ по названию продукта.
- Структурированное JSON‑логирование с requestId.

Проект ориентирован на запуск в Railway, но легко поднимается и локально.

---

## Содержание

1. [Архитектура](#архитектура)
2. [Схема базы данных](#схема-базы-данных)
3. [Конфигурация (ENV)](#конфигурация-env)
4. [Локальный запуск](#локальный-запуск)
   - [Запуск Postgres через Docker](#запуск-postgres-через-docker)
   - [Инициализация схемы и таблиц](#инициализация-схемы-и-таблиц)
   - [Запуск сервиса](#запуск-сервиса)
5. [Запуск через Docker образ сервиса](#запуск-через-docker-образ-сервиса)
6. [API](#api)
   - [`GET /health`](#get-health)
   - [`GET /api/search`](#get-apisearch)
   - [`POST /api/auto-add`](#post-apiauto-add)
   - [`POST /api/dict/create_via_gpt`](#post-apidictcreate_via_gpt)
   - [`POST /api/log/add_list`](#post-apilogadd_list)
   - [`POST /api/log/update_item`](#post-apilogupdate_item)
   - [`POST /api/dict/update`](#post-apidictupdate)
   - [`GET /api/stats/daily`](#get-apistatsdaily)
7. [Логирование](#логирование)
8. [Ручное локальное тестирование](#ручное-локальное-тестирование)
9. [Ограничения и заметки](#ограничения-и-заметки)

---

## Архитектура

- **Язык/рантайм:** Node.js (CommonJS)
- **HTTP‑фреймворк:** Express
- **База данных:** PostgreSQL
- **Основные файлы:**
  - `index.js` — основной HTTP‑сервер и все роуты
  - `config.js` — централизованный конфиг (чтение ENV, лимитов, таймаутов)
  - `logger.js` — JSON‑логирование
  - `middlewares/logging.js` — middleware для логирования запросов с requestId
  - `middlewares/errorHandler.js` — централизованный обработчик ошибок
  - `sql/ddl/personal.food_dict.sql` — актуальный DDL справочника продуктов
  - `sql/ddl/personal.food_log.sql` — актуальный DDL лога приёмов пищи

HTTP‑сервер запускается на порту `PORT` (по умолчанию `3000`). В Railway порт и строка подключения к Postgres передаются через переменные окружения.


## Схема базы данных

> ВАЖНО: DDL в папке `sql/ddl` являются **источником правды** — именно такие таблицы используются в боевом сервисе.

### personal.food_dict

Файл: `sql/ddl/personal.food_dict.sql`

```sql
CREATE TABLE personal.food_dict (
    id integer DEFAULT nextval('personal.food_dict_id_seq'::regclass) PRIMARY KEY,
    product text UNIQUE,
    kcal_100 numeric(6,2),
    protein_100 numeric(6,2),
    fat_100 numeric(6,2),
    carbs_100 numeric(6,2),
    source text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
```

- `product` — название продукта (используется и в логах как ключ для join’а).
- `kcal_100`, `protein_100`, `fat_100`, `carbs_100` — БЖУ на 100 г.
- `source` — источник данных (`manual`, `gpt`, `usda` и т.п.).
- `created_at`, `updated_at` — метаданные.

### personal.food_log

Файл: `sql/ddl/personal.food_log.sql`

```sql
CREATE TABLE personal.food_log (
    id bigint DEFAULT nextval('personal.food_log_id_seq'::regclass) PRIMARY KEY,
    meal_type text NOT NULL,
    product text NOT NULL,
    quantity_g integer NOT NULL CHECK (quantity_g > 0),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at_am timestamp without time zone GENERATED ALWAYS AS ((created_at AT TIME ZONE 'Asia/Yerevan'::text)) STORED
);
```

- `meal_type` — тип приёма пищи (например, `breakfast`, `lunch`, `dinner`, `snack`), по умолчанию в сервисе `"unspecified"`.
- `product` — название продукта, линкуется с `food_dict.product` по `LOWER(product)`.
- `quantity_g` — количество в граммах.
- `created_at` — время логирования (используется как время приёма пищи).

Подсчёт статистики идёт по `created_at::date` и join’у по `LOWER(food_log.product) = LOWER(food_dict.product)`.


## Конфигурация (ENV)

Конфиг централизован в файле `config.js`. Все секреты передаются через ENV.

Основные переменные окружения:

### База данных

- `PG_CONNECTION_STRING` — строка подключения к Postgres, например:

  ```bash
  PG_CONNECTION_STRING=postgresql://postgres:postgres@localhost:5432/calories
  ```

### HTTP‑сервер

- `PORT` — порт HTTP‑сервера (по умолчанию `3000`).

### USDA API

- `USDA_API_KEY` — ключ для USDA FoodData Central API.
- `USDA_BASE_URL` — базовый URL (по умолчанию `https://api.nal.usda.gov/fdc/v1/foods/search`).
- `USDA_TIMEOUT_MS` — таймаут HTTP‑запросов к USDA (по умолчанию `1500` мс).

### OpenAI (GPT)

- `OPENAI_API_KEY` — ключ OpenAI (если не задан — GPT‑флоу не работает, эндпоинты, которые до него добираются, вернут ошибку).
- `OPENAI_MODEL` — модель (по умолчанию `gpt-4o-mini`).
- `OPENAI_TIMEOUT_MS` — таймаут запроса к OpenAI (по умолчанию `8000` мс).

### Перевод (Google Translate, неофициальный endpoint)

- `TRANSLATE_TIMEOUT_MS` — таймаут перевода (по умолчанию `2000` мс).

### Поиск

- `SEARCH_LIMIT_DEFAULT` — лимит по умолчанию (по умолчанию `10`).
- `SEARCH_LIMIT_MAX` — максимальный лимит (по умолчанию `25`).

### Дневные цели по макросам

Используются для расчёта «сколько осталось» в `/api/stats/daily` и `/api/log/add_list`.

- `DAILY_KCAL_TARGET`
- `DAILY_PROTEIN_TARGET`
- `DAILY_FAT_TARGET`
- `DAILY_CARBS_TARGET`

Если **все четыре** заданы, сервис считает `macros_left` как `max(target - total, 0)` для каждого показателя. Если хоть одна не задана — `macros_left` будет с `null`.


## Локальный запуск

### Запуск Postgres через Docker

```bash
docker run --name calories-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=calories \
  -p 5432:5432 \
  -d postgres:16
```

### Инициализация схемы и таблиц

Подключаемся к локальному Postgres и накатываем DDL:

```bash
psql postgresql://postgres:postgres@localhost:5432/calories <<'SQL'
CREATE SCHEMA IF NOT EXISTS personal;

-- Справочник продуктов
\i sql/ddl/personal.food_dict.sql

-- Лог приёмов пищи
\i sql/ddl/personal.food_log.sql
SQL
```

(Если выполняешь в psql внутри контейнера, путь к файлам может отличаться — это для локального запуска из корня репозитория.)

### Заполнение тестовыми продуктами (опционально)

```sql
INSERT INTO personal.food_dict (product, kcal_100, protein_100, fat_100, carbs_100, source)
VALUES
  ('куриная грудка', 165, 31, 3.6, 0, 'manual'),
  ('рис отварной', 130, 2.7, 0.3, 28, 'manual');
```

### ENV для локального запуска

```bash
export PG_CONNECTION_STRING="postgresql://postgres:postgres@localhost:5432/calories"
export PORT=3000

# Необязательно для начала
# export USDA_API_KEY=...
# export OPENAI_API_KEY=...

# Цели по макросам (пример)
export DAILY_KCAL_TARGET=2000
export DAILY_PROTEIN_TARGET=150
export DAILY_FAT_TARGET=70
export DAILY_CARBS_TARGET=200
```

### Запуск сервиса

```bash
npm install
npm start
# или
node index.js
```

Ожидаемый лог:

```json
{"ts":"...","level":"info","msg":"API server listening","port":3000}
```

---

## Запуск через Docker образ сервиса

Сборка образа:

```bash
docker build -t calories-api .
```

Запуск, указывая ENV и подключение к базе (пример для локального Postgres на хосте):

```bash
docker run --rm -p 3000:3000 \
  -e PG_CONNECTION_STRING="postgresql://postgres:postgres@host.docker.internal:5432/calories" \
  -e PORT=3000 \
  -e DAILY_KCAL_TARGET=2000 \
  -e DAILY_PROTEIN_TARGET=150 \
  -e DAILY_FAT_TARGET=70 \
  -e DAILY_CARBS_TARGET=200 \
  calories-api
```

---

## API

### `GET /health`

Проверка, что сервис жив и, при наличии подключения к БД, что Postgres отвечает.

**Ответ 200:**

```json
{"ok": true}
```

**Ответ 500:**

```json
{"ok": false}
```

---

### `GET /api/search`

Поиск продуктов в локальном словаре и (опционально) через USDA.

**Параметры query:**

- `query` (string, required) — подстрока для поиска по полю `product`.
- `limit` (number, optional) — лимит результатов, по умолчанию `SEARCH_LIMIT_DEFAULT`, максимум `SEARCH_LIMIT_MAX`.

**Логика:**
1. Сначала ищем в `personal.food_dict` (`source = "local"`).
2. Если локально ничего не найдено и задан `USDA_API_KEY` — отправляем запрос в USDA.
3. Для русских запросов: RU → EN для запроса в USDA и EN → RU для `product` в ответе.

**Пример запроса:**

```bash
curl "http://localhost:3000/api/search?query=кури&limit=5"
```

**Пример ответа (локальный словарь):**

```json
{
  "query": "кури",
  "limit": 5,
  "source": "local",
  "counts": {
    "local": 1,
    "usda": 0,
    "off": 0,
    "total": 1
  },
  "results": [
    {
      "source": "local",
      "id": 1,
      "product": "куриная грудка",
      "brand": null,
      "product_type": null,
      "freq_usage": 0,
      "last_used_at": null,
      "kcal_100": 165,
      "protein_100": 31,
      "fat_100": 3.6,
      "carbs_100": 0,
      "meta": null
    }
  ]
}
```

---

### `POST /api/auto-add`

Ручное добавление или обновление продукта в `personal.food_dict`.

**Тело запроса (JSON):**

```json
{
  "product": "творог 5%",
  "kcal_100": 121,
  "protein_100": 17,
  "fat_100": 5,
  "carbs_100": 3,
  "source": "manual"   // optional, по умолчанию "manual"
}
```

- Если продукт с таким `product` уже существует — БЖУ обновятся, `updated_at` обновится.
- Если нет — будет создана новая запись.

**Ответ:**

```json
{
  "id": 3,
  "product": "творог 5%",
  "source": "manual",
  "created_at": "...",
  "updated_at": "...",
  "kcal_100": 121,
  "protein_100": 17,
  "fat_100": 5,
  "carbs_100": 3
}
```

---

### `POST /api/dict/create_via_gpt`

Создать/обновить продукт в `personal.food_dict`, получив БЖУ через GPT.

**Тело запроса:**

```json
{
  "product": "гречка отварная"
}
```

Требуется `OPENAI_API_KEY`.

**Ответ (пример):**

```json
{
  "id": 4,
  "product": "гречка отварная",
  "kcal_100": 110,
  "protein_100": 4,
  "fat_100": 1.5,
  "carbs_100": 21,
  "source": "gpt",
  "created_at": "...",
  "updated_at": "..."
}
```

**Ошибки:**
- `502 gpt_failed` — проблема с GPT (таймаут, парсинг ответа, ошибка API).
- `500 db_error` — ошибка БД.

---

### `POST /api/log/add_list`

Добавление списка съеденных продуктов в `personal.food_log`.

**Тело запроса:** массив объектов.

```json
[
  {
    "product": "творог 5%",
    "weight": 200,
    "meal_type": "breakfast"
  },
  {
    "product": "куриная грудка",
    "quantity_g": 150,
    "meal_type": "lunch"
  }
]
```

Допустимо использовать либо `weight`, либо `quantity_g` — в обоих случаях это граммы.

- Если `product` уже есть в `personal.food_dict` — используются его БЖУ.
- Если нет и настроен `OPENAI_API_KEY` — сервис запросит GPT и добавит продукт в словарь (`source = "gpt"`).
- `meal_type` опционален, по умолчанию `"unspecified"`.

**Упрощения:**
- В лог пишется только `product` и `quantity_g` — ссылка на словарь по имени.

**Ответ:** суммарные макросы за **сегодняшний день** и «остатки» до дневных целей.

```json
{
  "total_kcal": 1234.5,
  "total_protein": 100.2,
  "total_fat": 50.1,
  "total_carbs": 130.7,
  "left_kcal": 765.5,
  "left_macros": {
    "p": 49.8,
    "f": 19.9,
    "c": 69.3,
    "kcal": 765.5
  }
}
```

---

### `POST /api/log/update_item`

Обновление веса (`quantity_g`) конкретной записи в `personal.food_log`.

**Тело запроса:**

```json
{
  "id": 1,
  "weight": 250
}
```

- `id` — ID записи в `personal.food_log`.
- `weight` — новый вес в граммах (> 0).

**Ответ:** такие же суммарные макросы и остатки, как в `/api/log/add_list`, но уже для даты этой записи.

---

### `POST /api/dict/update`

Ручное обновление БЖУ у уже существующего продукта.

**Тело запроса:**

```json
{
  "product_id": 3,
  "kcal_100": 120,
  "protein_100": 18,
  "fat_100": 4,
  "carbs_100": 3
}
```

**Ответ:**

```json
{
  "id": 3,
  "product": "творог 5%",
  "source": "manual",
  "created_at": "...",
  "updated_at": "...",
  "kcal_100": 120,
  "protein_100": 18,
  "fat_100": 4,
  "carbs_100": 3
}
```

---

### `GET /api/stats/daily`

Получение статистики по одному дню.

**Параметры query:**

- `date` (optional) — строка `YYYY-MM-DD`. Если не указано — берётся текущая дата по `created_at` в логе.

**Пример:**

```bash
curl "http://localhost:3000/api/stats/daily?date=2025-12-07"
```

**Ответ:**

```json
{
  "date": "2025-12-07",
  "macros_total": {
    "p": 120.5,
    "f": 60.1,
    "c": 210.3,
    "kcal": 2100.9
  },
  "macros_left": {
    "p": 29.5,
    "f": 9.9,
    "c": 0,
    "kcal": 0
  },
  "items": [
    {
      "id": 1,
      "product": "творог 5%",
      "product_type": null,
      "meal_type": "breakfast",
      "weight": 200,
      "kcal": 242,
      "protein": 34,
      "fat": 10,
      "carbs": 6,
      "time": "2025-12-07T08:15:00.000Z"
    }
  ]
}
```

---

## Логирование

### Уровни и формат

Все логи пишутся через `logger.js` как **одна JSON‑строка на событие**:

```json
{
  "ts": "2025-12-07T09:00:00.000Z",
  "level": "info",
  "msg": "request:start",
  "reqId": "d3e89f0b-...",
  "method": "GET",
  "path": "/api/search",
  "query": {"query":"курица","limit":"5"}
}
```

Основные уровни:
- `info` — нормальные события (старт/завершение запроса, запуск сервера);
- `warn` — потенциальные проблемы;
- `error` — ошибки (БД, внешние API, некорректные данные);
- `debug` — детальная отладка (по необходимости).

### requestLogger middleware

Файл: `middlewares/logging.js`.

- Каждому запросу присваивается `req.id` (uuid) или берётся из заголовка `x-request-id`.
- Логируются события `request:start` и `request:end` с полями:
  - `reqId`, `method`, `path`, `status`, `duration_ms`.

### errorHandler middleware

Файл: `middlewares/errorHandler.js`.

- Централизованный обработчик ошибок Express.
- Логирует `request:error` с:
  - `reqId`, `method`, `path`, `error`, `stack` (в non‑prod).
- Возвращает клиенту `{ "error": "internal" }` с кодом 500, не раскрывая деталей.

---

## Ручное локальное тестирование

Ниже чек‑лист, как руками проверить все основные функции микросервиса локально.

### 1. Подготовка

1.1. Поднять Postgres (см. раздел выше).

1.2. Накатить DDL из `sql/ddl` и добавить несколько продуктов.

1.3. Задать ENV:

```bash
export PG_CONNECTION_STRING="postgresql://postgres:postgres@localhost:5432/calories"
export PORT=3000
# опционально: USDA_API_KEY, OPENAI_API_KEY, DAILY_*_TARGET
```

1.4. Запустить сервис:

```bash
npm install
npm start
```

Убедиться, что в логах есть запись `API server listening`.

### 2. Healthcheck

```bash
curl http://localhost:3000/health
```

Ожидаем `{ "ok": true }`. В случае проблем с БД — `{ "ok": false }` и `error` в логах.

### 3. Поиск продуктов

3.1. Поиск по существующему локальному продукту:

```bash
curl "http://localhost:3000/api/search?query=кури&limit=5"
```

- Ожидаем `source = "local"`.

3.2. Поиск по несуществующему локально продукту (при наличии `USDA_API_KEY`):

```bash
curl "http://localhost:3000/api/search?query=chicken&limit=3"
```

- Ожидаем `source = "usda"` и список результатов.

### 4. Работа со словарём продуктов

4.1. Ручное добавление продукта:

```bash
curl -X POST http://localhost:3000/api/auto-add \
  -H "Content-Type: application/json" \
  -d '{
    "product": "творог 5%",
    "kcal_100": 121,
    "protein_100": 17,
    "fat_100": 5,
    "carbs_100": 3,
    "source": "manual"
  }'
```

4.2. Создание через GPT (если есть `OPENAI_API_KEY`):

```bash
curl -X POST http://localhost:3000/api/dict/create_via_gpt \
  -H "Content-Type: application/json" \
  -d '{ "product": "гречка отварная" }'
```

- Ожидаем `source = "gpt"` и числовые БЖУ.

4.3. Обновление БЖУ:

```bash
curl -X POST http://localhost:3000/api/dict/update \
  -H "Content-Type: application/json" \
  -d '{
    "product_id": 3,
    "kcal_100": 120,
    "protein_100": 18,
    "fat_100": 4,
    "carbs_100": 3
  }'
```

### 5. Логирование съеденного

5.1. Добавление списка записей:

```bash
curl -X POST http://localhost:3000/api/log/add_list \
  -H "Content-Type: application/json" \
  -d '[
    { "product": "творог 5%", "weight": 200, "meal_type": "breakfast" },
    { "product": "куриная грудка", "quantity_g": 150, "meal_type": "lunch" }
  ]'
```

- Ожидаем агрегированные макросы и `left_macros`.
- В БД появляются строки в `personal.food_log`.

5.2. Обновление веса записи:

- Сначала получить `id` из `personal.food_log` или из ответа `/api/stats/daily`.

```bash
curl -X POST http://localhost:3000/api/log/update_item \
  -H "Content-Type: application/json" \
  -d '{ "id": 1, "weight": 250 }'
```

- Ожидаем пересчёт макросов за соответствующий день.

### 6. Статистика за день

```bash
curl "http://localhost:3000/api/stats/daily?date=2025-12-07"
```

- Проверить, что суммы по `items` совпадают с `macros_total`.
- Если заданы дневные цели — проверить адекватность `macros_left`.

### 7. Проверка логов

- Во время запросов в stdout должны появляться:
  - `request:start` и `request:end` с `reqId` и `duration_ms`;
  - при ошибках — `request:error` или специфичные сообщения типа `[/api/log/add_list] TX error`.

### 8. Поведение без внешних ключей API

- Запустить сервис **без** `USDA_API_KEY` и/или `OPENAI_API_KEY`.
- Проверить:
  - `/api/search` по несуществующему локально продукту → не падает, но не даёт USDA‑результатов.
  - `/api/dict/create_via_gpt` и сценарии, которые требуют GPT → возвращают соответствующую ошибку (`gpt_failed` / `OPENAI_API_KEY is not configured`).

---

## Ограничения и заметки

- Сервис завязан на схему `personal.food_dict` и `personal.food_log` и предполагает, что эти DDL соответствуют боевой БД.
- В логах используются stdout и JSON‑формат, интеграция с внешними системами логов (например, Railway) предполагается через сбор stdout.
- GPT даёт **примерные** БЖУ — это не медицинский инструмент, а вспомогательный помощник.

Если нужно, можно дальше развивать проект:
- добавить автоматические тесты (jest + supertest);
- вынести бизнес‑логику поиска/подсчёта в отдельные модули;
- сделать versioned API и более строгую валидацию входящих данных.
