import { createAndroidLogin } from "./android-login.js";
import { getLocalSessionStore, runTool } from "./toolkit.js";

// This command is the only local user-facing entry point. There is no HTTP
// listener, locally hosted shopping page or need to expose a network port.
const command = process.argv[2] || "sync";
const ongoing = new Set(["opening", "waiting", "verifying"]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function synchronize() {
  const store = await getLocalSessionStore();
  const login = createAndroidLogin({
    requireCartContext: true,
    saveSession: saved => store.save(saved),
  });
  let interrupted = false;
  const handleInterrupt = () => {
    interrupted = true;
    void login.cancel().catch(() => {});
  };
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleInterrupt);
  let lastStatus = "";
  try {
    console.log("Открываю официальный Магнит в Chrome на Android.");
    console.log("В Chrome выберите «Экспресс» (или нужный сервис) и откройте его корзину.");
    console.log("Вход и подтверждение корзины происходят только на сайте magnit.ru.");
    await login.start();
    while (true) {
      const current = login.snapshot();
      if (current.status !== lastStatus) {
        console.log(current.message || current.status);
        lastStatus = current.status;
      }
      if (!ongoing.has(current.status)) {
        if (current.status === "ready") {
          const state = (await runTool("status")).session;
          console.log(JSON.stringify({
            ok: true,
            service: state.service,
            store_code: state.store_code,
            verified_browser_context: state.cart_context_ready,
            browser_cart_snapshot: state.browser_cart_snapshot,
            next: "npm run status | npm run debug | npm run tool -- view_cart " +
              (state.store_code || "STORE_CODE") + " " +
              (state.service === "dostavka" ? "delivery" : "express"),
          }, null, 2));
          return;
        }
        if (!interrupted) process.exitCode = 1;
        return;
      }
      await delay(800);
    }
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleInterrupt);
    if (interrupted) {
      await login.cancel().catch(() => {});
      process.exitCode = 130;
    }
  }
}

async function main() {
  switch (command) {
    case "sync":
    case "login":
      return synchronize();
    case "status": {
      const state = await runTool("status");
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    case "debug": {
      const current = await runTool("status");
      const session = current.session;
      if (!session?.cart_context_ready || !session.store_code ||
          !["express", "dostavka"].includes(session.service))
        throw Object.assign(new Error("Сначала выполните npm start и синхронизируйте корзину Chrome."),
          { code: "chrome_context_required" });
      const report = await runTool("collect_debug_report", {
        store_code: session.store_code,
        mode: session.service === "dostavka" ? "delivery" : "express",
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case "logout": {
      await (await getLocalSessionStore()).clear();
      console.log("Локальная зашифрованная сессия удалена. Сессия в официальном Chrome не затронута.");
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log([
        "Магнит UTCP — без кастомной веб-страницы.",
        "npm start       — синхронизация в официальном Android Chrome",
        "npm run sync    — то же самое",
        "npm run status  — статус без Cookie",
        "npm run debug   — полный безопасный JSON отчёт (только чтение)",
        "npm run logout  — удалить локальную сохранённую сессию",
        "npm run tool -- view_cart КОД express  — прочитать корзину через Chrome",
        "python agent.py \"Собери корзину\"    — ИИ-агент (отдельный API ключ)",
      ].join("\n"));
      return;
    default:
      throw Object.assign(new Error("Неизвестная команда. Используйте npm run help."),
        { code: "unknown_command" });
  }
}

try {
  await main();
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Za-z_][A-Za-z0-9_-]{1,80}$/.test(error.code)
    ? error.code : "cli_error";
  console.error("Ошибка (" + code + "): " +
    (error?.message && !/[\r\n\0]/.test(error.message)
      ? error.message.slice(0, 240) : "Операция не выполнена."));
  process.exitCode = 1;
}
