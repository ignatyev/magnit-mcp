# HTTP MCP Магнит

## Что поддерживается

- `magnit_search_products`, `magnit_list_categories` для режимов `delivery`, `retail`, `express`.
- `magnit_view_cart` и `magnit_add_to_cart` для express-корзины с активной сессией владельца.
- Ручной вход в Магнит на официальной Android вкладке Chrome. SMS и CAPTCHA обрабатывает сам пользователь на сайте; сервис не хранит их значения и не автоматизирует решение CAPTCHA.
- `magnit_status` возвращает только capability, ссылку owner UI, режим/магазин сессии и факт необходимости перечитать корзину. Cookie и токены никогда не возвращаются в MCP.

Оформление заказа, оплата и удаление из корзины не поддерживаются. Суммы `lite` не являются итоговым чеком. Автоматическое добавление доступно только для недавно найденного товара, соответствующего ограниченному правилу наблюдавшегося express HAR: совпадающие непустые `id`/`productId`, `service` и `targetCart` равны `express`, выбранный `storeCode`, товар не весовой, `minOrderQuantity=1`, `orderStepQuantity=1`, остальные ограничения товара равны `false`. Правило не прошло live-проверку; весовые товары исключены.

Добавление читает актуальную корзину, проверяет один express формат и контекст магазина, сохраняет все текущие `goodId`, `offerId`, `qnty`, выполняет ровно один `PUT`, затем сравнивает все позиции и количества с ответом. Счётчик `formats.itemsCount` может отставать от `items.length`, поэтому сервис не принимает его за размер корзины. Неизвестные позиции, повторы идентификаторов, другой сервис/магазин или несколько форматов блокируют запись. Неопределённый результат сохраняется в зашифрованном owner state: новое добавление блокируется до отдельного успешного вызова `magnit_view_cart`. Сериализация действует внутри процесса; независимые клиенты могут изменить корзину одновременно.

## Android и Termux

Требуется Node.js 22.13+, npm и `android-tools`:

```sh
pkg update
pkg install nodejs-lts npm android-tools git
git clone https://github.com/ignatyev/magnit-mcp.git
cd magnit-mcp/bridge
cp .env.example .env
```

В `.env` задайте случайный `MCP_BEARER_TOKEN` длиной не менее 32 символов. Для loopback-режима `PHONE_ACCESS_SECRET` не нужен: владелец открывает страницу напрямую, а сервис автоматически создаёт приватный ключ `./data/owner-key` с правами только владельца. Старое значение `PHONE_ACCESS_SECRET` можно оставить — локально оно не запрашивается и продолжает расшифровывать ранее сохранённую сессию. Оставьте `PUBLIC_BASE_URL=http://127.0.0.1:8080`, `HOST=127.0.0.1`. Если подключено несколько устройств, в `ANDROID_DEVICE_SERIAL` укажите serial из `adb devices -l`.

На Android вручную включите **Параметры разработчика → Беспроводная отладка**. Пара и connect используют разные динамические адреса/порты из Android настроек:

```sh
adb pair <адрес-и-порт-pairing-из-настроек-Android>
adb connect <адрес-и-порт-connect-из-настроек-Android>
adb devices -l
npm start
```

Откройте `http://127.0.0.1:8080` и нажмите **Войти в Магнит**; отдельный пароль сервиса в локальном режиме не нужен. Node использует `adb devices -l`, создаёт только собственный `adb forward` и новую вкладку официального `https://magnit.ru/` через Chrome DevTools Protocol. Никаких `adb shell`, переключений настроек, паролей, SMS или токенов CAPTCHA сервис не отправляет. Вкладка ждёт ручной вход и переход в express-корзину. CDP наблюдает только `GET https://magnit.ru/webgate/v1/carts/lite` и запрашивает только `Network.getCookies` для этого URL. Затем сервис один раз вызывает `GET https://magnit.ru/_auth/session`, требует `authorized: true`, один раз читает корзину и только тогда шифрует сессию. При 403 он закрывает временную вкладку без повтора. После успеха или отмены закрываются только созданная вкладка, WebSocket и собственный ADB-forward; остальные Chrome вкладки и профиль остаются открыты. Реальный Android/Chrome здесь не запускался.

Сервис не подключается к произвольному устройству: если online устройств несколько, без `ANDROID_DEVICE_SERIAL` вход просит владельца указать serial. Если ADB/Chrome не готовы, owner UI показывает настройку. Termux процесс должен работать на том же Android устройстве; удалённый Docker helper не может управлять Chrome телефона.

Официальные справки: [Chrome remote debugging on Android](https://developer.chrome.com/docs/devtools/remote-debugging) и [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).

## Локальный запуск и внешний MCP

```sh
npm start
```

`npm start` загружает `.env`. Откройте `http://127.0.0.1:8080`. Plain HTTP разрешён только loopback. Для вызова Sites/ChatGPT нужен доступный bridge HTTPS URL, настроенный внешним TLS reverse proxy или самостоятельно выбранным tunnel; автоматической публикации нет. Не выставляйте локальный owner UI публично: удалённый HTTPS режим сохраняет парольную защиту и требует `PHONE_ACCESS_SECRET` длиной не менее 32 символов. Ключ удалённого режима не создаётся автоматически. В Site runtime secrets задайте `MCP_BRIDGE_URL=https://<домен>/mcp` и `MCP_BRIDGE_TOKEN` с тем же значением, что `MCP_BEARER_TOKEN`.

Docker на Linux предназначен для HTTP MCP и не может обслуживать Android CDP-вход на телефоне. Он использует TLS reverse proxy и постоянный именованный том для зашифрованной сессии. Порт 8080 напрямую наружу не публикуется.

## HAR fallback

Импорт HAR скрыт в дополнительных настройках и не нужен для штатного входа. Обычный экспорт Chrome удаляет Cookie и будет отклонён с `sanitized_export/missing_cookie`. Импортёр допускает только exact-origin HTTPS Magnit `GET/PUT /webgate/v1/carts/lite`, выбирает последнюю express запись, требует реальный Cookie и валидный контекст, затем проверяет сессию и корзину перед сохранением. Он не принимает auth/OTP/captcha endpoints и не сохраняет исходный HAR. Не передавайте sensitive HAR в чат или репозиторий.

## Воспроизводимые проверки

```sh
npm test
node --check src/server.js
```

Тесты используют синтетические cookies, mock ADB/CDP и mock upstream. Они проверяют выбор устройства, loopback WebSocket/origin allowlist, cleanup вкладки и ADB-forward, auth+cart verification до session save, HAR redaction rejection, ciphertext persistence, express mapping, eligibility TTL, cart preservation, ambiguous write lock и отсутствие повторов. Реальный аккаунт, SMS, ADB/Android и Magnit API не проверяются.
