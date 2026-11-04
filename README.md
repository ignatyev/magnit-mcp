# Магнит с телефона — MCP и браузерный мост

Этот проект связывает личный MCP-плагин Sites с браузером на официальном сайте Магнит. Публичный исходный код: https://github.com/ignatyev/magnit-mcp.

## Текущее состояние

Код сайта и MCP-маршрут `/mcp` готовы, но удалённый браузерный сервер ещё нужно запустить и подключить runtime secrets. Пока `MCP_BRIDGE_URL` и `MCP_BRIDGE_TOKEN` не заданы, инструменты честно отвечают `setup_required`.

Магнит может ограничить доступ в браузере. При подготовке проекта официальный сайт вернул `Forbidden` и сообщение о проверке автоматизации. Обход антибот-защиты не используется; совместимость входа, каталога, корзины и оформления заказа не подтверждена. Финальное оформление и оплату пользователь подтверждает самостоятельно.

## Android и Termux (экспериментально)

Этот вариант может запускать MCP-сервер на самом Android-телефоне, без отдельного ПК или VPS. Он зависит от Android, Chrome, ADB и экспериментального Android API Playwright; запуск на реальном устройстве здесь не проверялся.

1. Установите Termux из доверенного источника и установите инструменты:

   ```sh
   pkg update
   pkg install nodejs-lts npm android-tools git
   ```

2. Установите Playwright JS-зависимости, пропустив загрузку desktop-браузеров:

   ```sh
   cd bridge
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
   ```

3. В Android включите **Параметры разработчика → Беспроводная отладка**, создайте пару с Termux и подключите ADB. Используйте адреса и порты, которые Android показывает для pairing и connect; они динамические. Не открывайте ADB-порт в интернет.

   ```sh
   adb pair <адрес-и-порт-из-экрана-pairing>
   adb connect <адрес-и-порт-из-экрана-connect>
   adb devices
   ```

4. Установите Chrome 105 или новее. Включите флаг Chrome **Enable command line on non-rooted devices**. Оставляйте экран включённым: снимки экрана Android требуют активного дисплея.

5. Создайте два разных случайных секрета. ADB подключается только к `127.0.0.1:5037`; если подключено несколько устройств, укажите точный serial из `adb devices`.

   ```sh
   export BROWSER_MODE=android
   export ANDROID_DEVICE_SERIAL='<serial из adb devices>'
   export ANDROID_CHROME_PACKAGE=com.android.chrome
   export MCP_BEARER_TOKEN='<случайный секрет MCP>'
   export PHONE_ACCESS_SECRET='<другой случайный секрет страницы телефона>'
   export PUBLIC_BASE_URL='https://<выданный HTTPS-адрес>'
   export TRUST_PROXY=1
   export COOKIE_SECURE=1
   export HOST=127.0.0.1
   export PORT=8080
   npm start
   ```

   Можно выбрать `com.chrome.beta`, если он установлен. Сервис откроет отдельную вкладку и не будет управлять другими вкладками Chrome. Android использует общий профиль выбранного Chrome; выходите из Магнит вручную. Сервис не удаляет этот профиль.

6. MCP-клиенту Sites нужен публичный HTTPS endpoint. В Termux можно отдельно настроить защищённый tunnel к `http://127.0.0.1:8080`; tunnel не создаётся автоматически. Публикуйте только HTTPS endpoint, держите оба секрета закрытыми и никогда не публикуйте ADB или DevTools.

7. В runtime secrets Site задайте `MCP_BRIDGE_URL=https://<ваш-HTTPS-адрес>/mcp` и `MCP_BRIDGE_TOKEN` с тем же значением, что `MCP_BEARER_TOKEN`. Сохраните настройки и опубликуйте Site.

Подробности Android API и ограничения описаны в [bridge/README.md](bridge/README.md).

## Docker на сервере

Сервер должен запускать Chromium под Xvfb, иметь исходящий доступ к Магнит, постоянный том профиля и HTTPS reverse proxy. Порт контейнера напрямую не публикуйте.

```sh
cd bridge
cp .env.example .env
# Заполните URL и два разных случайных секрета в .env
docker compose up --build -d
```

На телефоне откройте HTTPS-адрес, введите `PHONE_ACCESS_SECRET`, затем войдите на официальной странице Магнит. MCP endpoint — `/mcp`.

## MCP-инструменты

- `magnit_status` — безопасное состояние страницы.
- `magnit_open_home` — открыть magnit.ru.
- `magnit_search_products` — открыть официальный поиск.
- `magnit_page_summary` — прочитать видимые карточки товаров и разрешённые ссылки.
- `magnit_click_reference` — нажать видимый элемент по актуальной ссылке и точному тексту. Финальная отправка заказа и оплата блокируются для MCP.

Вход, СМС-код и платёжные данные вводит пользователь непосредственно в браузере. MCP не возвращает поля входа или скриншоты.

## Проверки

```sh
cd bridge
npm test
node --check src/server.js
```

Проверены URL allowlist, безопасные MCP-действия, блокировка финальных действий, маскировка секретных полей, подпись/срок cookie и выбор Android-устройства. Реальный Android, вход Магнит и заказ не проверялись.
