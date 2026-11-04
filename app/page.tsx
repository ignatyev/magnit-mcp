import { ArrowUpRight, CheckCircle2, CircleAlert, ExternalLink, LockKeyhole, Smartphone } from "lucide-react";
import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import { getBridgeSetupStatus } from "./magnit-bridge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [user, bridge] = await Promise.all([getChatGPTUser(), Promise.resolve(getBridgeSetupStatus())]);
  return (
    <main className="min-h-screen bg-[#f8f6f2] text-[#25231f]">
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        <header className="flex items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-3 no-underline">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#d7352f] text-white"><Smartphone size={22} /></span>
            <span><span className="block text-lg font-extrabold tracking-tight">Магнит рядом</span><span className="block text-xs text-[#777168]">Телефонный браузер и MCP</span></span>
          </a>
          <a href="https://github.com/ignatyev/magnit-mcp" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border border-[#e8e2d8] bg-white px-3 py-2 text-xs font-semibold text-[#514d46] no-underline">Исходный код <ArrowUpRight size={14} /></a>
        </header>

        <section className="mt-8 rounded-[28px] bg-[#292622] p-6 text-white shadow-[0_18px_50px_#30271f22] sm:p-9">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs text-[#e7ded2]"><LockKeyhole size={14} /> Ваш вход остаётся на официальной странице Магнит</div>
          <h1 className="max-w-xl text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">Соберите заказ Магнит с телефона</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[#d4cec6] sm:text-base">Этот сайт связывает MCP-инструменты с отдельным браузером, открытым на magnit.ru. Номер телефона и СМС-код вводятся вами непосредственно на странице Магнит. Финальный заказ и оплату подтверждаете вручную.</p>
          <div className={`mt-7 flex items-start gap-3 rounded-2xl px-4 py-4 ${bridge.configured ? "bg-[#164f38]" : "bg-[#5a4023]"}`}>
            {bridge.configured ? <CheckCircle2 className="mt-0.5 shrink-0" size={19} /> : <CircleAlert className="mt-0.5 shrink-0" size={19} />}
            <div className="min-w-0">
              <p className="font-bold">{bridge.configured ? "Адрес браузерного сервера настроен" : "Браузерный сервер ещё не настроен"}</p>
              <p className="mt-1 text-sm leading-5 text-white/80">{bridge.configured ? "Ссылка ниже откроет браузер. Доступность сервера проверяется при вызове MCP-инструментов." : "MCP пока отвечает setup_required. Можно использовать Docker на хостинге или экспериментальный режим Android/Termux на самом телефоне; удалённому MCP всё равно нужен защищённый HTTPS-адрес."}</p>
              {bridge.configured && bridge.phoneUrl ? <a className="mt-3 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 font-bold text-[#25231f] no-underline" href={bridge.phoneUrl} target="_blank" rel="noreferrer">Открыть на телефоне <ExternalLink size={15} /></a> : null}
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            ["01", "Выберите запуск", "Docker на хостинге или экспериментально: Android/Termux и Chrome на вашем телефоне. Для Android нужен ADB."],
            ["02", "Войдите на телефоне", "Откройте страницу сервера, введите его пароль доступа и подтвердите Магнит ID в официальном окне."],
            ["03", "Подключите MCP", "Добавьте адрес /mcp и токен сервера в секреты Sites. Доступ к каталогу и корзине зависит от того, какие страницы Магнит отдаёт браузеру."],
          ].map(([number, title, description]) => (
            <article key={number} className="rounded-3xl border border-[#e9e3da] bg-white p-5">
              <span className="text-xs font-extrabold tracking-[.16em] text-[#d7352f]">{number}</span>
              <h2 className="mt-3 text-base font-bold">{title}</h2>
              <p className="mt-2 text-sm leading-5 text-[#6d675f]">{description}</p>
            </article>
          ))}
        </section>

        <section className="mt-5 rounded-3xl border border-[#e9e3da] bg-white p-5 sm:p-6">
          <h2 className="text-lg font-bold">Настройка для владельца</h2>
          <p className="mt-2 text-sm leading-6 text-[#6d675f]">Браузерный процесс запускается отдельно от этого сайта. Для режима Android/Termux откройте в репозитории раздел инструкции Android: он экспериментальный и зависит от версии Playwright, Android, ADB и Chrome. Магнит может ограничить доступ; обход защиты не используется. После запуска добавьте в runtime secrets проекта:</p>
          <pre className="mt-4 overflow-x-auto rounded-2xl bg-[#292622] p-4 text-xs leading-6 text-[#f4eee6]"><code>MCP_BRIDGE_URL=https://ваш-сервер.example/mcp{"\n"}MCP_BRIDGE_TOKEN=тот-же-секрет-что-на-сервере</code></pre>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <a className="inline-flex items-center gap-1.5 font-semibold text-[#b92d28] no-underline" href="https://github.com/ignatyev/magnit-mcp" target="_blank" rel="noreferrer">Репозиторий и инструкция <ArrowUpRight size={15} /></a>
            {user ? <span className="text-[#777168]">Подключённый профиль: {user.displayName}</span> : <a className="font-semibold text-[#514d46] no-underline" href={chatGPTSignInPath("/")} target="_top">Войти через ChatGPT</a>}
          </div>
        </section>

        <p className="mx-auto mt-6 max-w-xl text-center text-xs leading-5 text-[#837d74]">MCP не нажимает кнопку финального оформления или оплаты. Перед подтверждением проверьте товары, адрес, способ доставки и итоговую сумму в браузере Магнит.</p>
      </div>
    </main>
  );
}
