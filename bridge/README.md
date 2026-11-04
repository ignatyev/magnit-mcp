# HTTP-сервис Магнит MCP

Чистый Node.js HTTP-сервис: без Chromium, браузерного профиля, Playwright, ADB и устройства. На Android его можно запустить локально через Termux. Мобильная страница предоставляет поиск каталога; MCP endpoint — `/mcp`.

## Реализованные возможности

- `magnit_status` — сообщает поддерживаемые функции и границы, не делая live-проверку Магнит.
- `magnit_search_products` — поиск по названию, коду магазина и явно выбранному режиму (`delivery` или `retail`).
- `magnit_list_categories` — категории для кода магазина и выбранного режима.
- Локальная мобильная форма `/` делает тот же HTTP поиск после входа паролем самого сервиса.

Вход Магнит ID, SMS, корзина, заказ и оплата не поддерживаются. Реальные возможности проверки корзины/заказа и контрактов входа не удалось подтвердить; MCP не выдаёт инструменты с такими именами.

## Контракт каталога

Реализация опирается на исходники двух открытых проектов:

- `3vgen/market-screening` использует `POST https://magnit.ru/webgate/v2/goods/search`, поля `term`, `pagination`, `sort`, `includeAdultGoods`, `storeCode`, `storeType: "1"`, `catalogType: "1"`; цены хранит в копейках.
- `1artik1/ComboPizzaSushiMCP` также использует этот endpoint и описывает `GET /webgate/v3/categories/store/{storeCode}`. Для доставки там указаны `storeType: "dostavka"`, `catalogType: "3"`.

Источники и API сторонние, неофициальные, в документации Магнит эти контракты не подтверждены. Режим явно выбирается, потому что эти два публичных клиента используют разные значения. Live-доступность, текущий ответ API и региональная поддержка не проверялись. HTTP 403 возвращается как `access_restricted`, без повтора или попытки обойти защиту. TLS certificate verification включён, перенаправления запрещены; заголовки подмены устройства не используются.

## Запуск локально в Termux

Требуется Node.js 22.13 или новее. В Termux установите Node.js и npm:

```sh
pkg update
pkg install nodejs-lts npm git
```

Файл `.env.example` содержит loopback defaults; скопируйте его в `.env`, замените оба значения случайными независимыми строками от 32 символов.

```sh
cd bridge
cp .env.example .env
node --env-file-if-exists=.env src/server.js
```

Откройте `http://127.0.0.1:8080` на телефоне, введите `PHONE_ACCESS_SECRET`, затем укажите свой код магазина и режим. Локальный HTTP допускается только для loopback; не меняйте `HOST` на сетевой адрес в этой конфигурации. Пароли Магнит и SMS не нужны.

Для вызова MCP из Sites/ChatGPT нужен публичный HTTPS endpoint: `PUBLIC_BASE_URL` должен совпадать с внешним URL сервиса и завершаться TLS на корректно настроенном reverse proxy. Порт MCP не публикуйте без HTTPS. Сервис не создаёт tunnel и не меняет сетевые настройки телефона. Локальный `127.0.0.1` напрямую из ChatGPT недоступен.

## Docker на Linux

Задайте `PUBLIC_BASE_URL` с HTTPS адресом, разные `MCP_BEARER_TOKEN` и `PHONE_ACCESS_SECRET`, затем запустите:

```sh
cp .env.example .env
docker compose up --build -d
```

`docker-compose.yml` предполагает внешний TLS reverse proxy, который перезаписывает `X-Forwarded-For` и передаёт `X-Forwarded-Proto: https`. Сервис слушает контейнерный порт 8080 только во внутренней сети Compose.

## Настройка Site

В runtime secrets Sites задайте:

```text
MCP_BRIDGE_URL=https://<ваш-домен>/mcp
MCP_BRIDGE_TOKEN=<тот же токен, что MCP_BEARER_TOKEN>
```

Затем опубликуйте Site. Пока эти secrets отсутствуют, MCP возвращает `setup_required`.

## Проверки

```sh
npm test
node --check src/server.js
```

Все проверки используют mock transport; тесты не обращаются к сайту Магнит. Они проверяют URL/body, явное соответствие режимов, преобразование цен из копеек, неизвестное наличие/цену, размер ответа, TLS redirect policy и поведение при 403/таймауте.
