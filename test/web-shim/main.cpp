// -----------------------------------------------------------------------------
// logos-web-shim — a C++ module published on the WEB transport, reachable over
// this process's stdio.
//
// The browser build of this SDK talks to a `MessagePort`-shaped channel and
// never to a socket. A native host binds that channel to whatever it owns: a
// webview's postMessage, a custom-scheme fetch pump, a Wasm host's port. This
// program is the smallest honest example of such a binding — the CHANNEL SHIM —
// and it exists so the browser SDK can be tested against a real C++ provider on
// the real logos-protocol web transport rather than against a JS imitation of
// one.
//
// The shim is stdio: one message per line, in on stdin, out on stdout. That is
// safe rather than lucky — every message on this wire is a JSON document and
// JSON escapes the newlines inside its strings, so a raw '\n' can only be a
// message boundary. Diagnostics go to stderr, because stdout IS the wire.
//
//   logos-web-shim [--module <name>] [--token <auth-token>] [--tick-ms <n>]
//
// Prints READY on stderr once it is serving.
// -----------------------------------------------------------------------------
#include "logos_mode.h"
#include "logos_provider_interface.h"
#include "message_channel.h"
#include "module_proxy.h"
#include "web_transport_host.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QTimer>
#include <QVariant>
#include <QVariantList>

#include <atomic>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace {

// -----------------------------------------------------------------------------
// StdioChannel — logos::web::IMessageChannel over this process's stdin/stdout.
//
// The two halves of the contract that matter to the peer above (see
// message_channel.h) are honoured here:
//
//   * DELIVERY IS NOT INLINE. Messages arrive on the reader thread, never on
//     the thread that called send(), because RpcPeer writes with its registry
//     mutex held and an inline delivery would re-enter it.
//   * setReceiver(nullptr) does not return while a delivery is running, so the
//     peer can detach and then be destroyed. m_deliveryMu is that barrier.
// -----------------------------------------------------------------------------
class StdioChannel : public logos::web::IMessageChannel {
public:
    StdioChannel() = default;

    ~StdioChannel() override { close(); }

    void start()
    {
        m_reader = std::thread([this] { readLoop(); });
    }

    void setReceiver(Receiver receiver) override
    {
        std::lock_guard<std::mutex> g(m_deliveryMu);
        m_receiver = std::move(receiver);
    }

    bool send(const std::string& message) override
    {
        if (!m_open.load()) return false;
        std::lock_guard<std::mutex> g(m_writeMu);
        std::cout << message << '\n' << std::flush;
        return std::cout.good();
    }

    void close() override
    {
        if (!m_open.exchange(false)) return;
        {
            std::lock_guard<std::mutex> g(m_deliveryMu);
            m_receiver = nullptr;
        }
        // The reader is blocked in std::getline on stdin; it wakes when the far
        // end closes the pipe (or when this process exits). Detach rather than
        // join so a shutdown driven from the reader's own thread cannot
        // self-join.
        if (m_reader.joinable()) m_reader.detach();
    }

    bool isOpen() const override { return m_open.load(); }

private:
    void readLoop()
    {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) continue;
            std::lock_guard<std::mutex> g(m_deliveryMu);
            if (!m_open.load() || !m_receiver) continue;
            m_receiver(line);
        }
        // stdin ended: the far end is gone. Ask the app to stop from the Qt
        // thread rather than tearing anything down here.
        QMetaObject::invokeMethod(QCoreApplication::instance(),
                                  [] { QCoreApplication::quit(); },
                                  Qt::QueuedConnection);
    }

    std::atomic<bool> m_open{true};
    std::thread       m_reader;
    std::mutex        m_writeMu;
    std::mutex        m_deliveryMu;
    Receiver          m_receiver;
};

// -----------------------------------------------------------------------------
// The module itself: the same three methods and the same event as the JS
// fixture (test/web-provider-worker.js), so the browser SDK's e2e can make the
// SAME assertions against a C++ provider that it makes against a JS one.
// -----------------------------------------------------------------------------
class ShimProvider : public LogosProviderObject {
public:
    QVariant callMethod(const QString& method, const QVariantList& args) override
    {
        if (method == QLatin1String("add"))
            return args.value(0).toInt() + args.value(1).toInt();
        if (method == QLatin1String("greet")) {
            QVariantMap out;
            out["message"] = QStringLiteral("hello ") + args.value(0).toString();
            return out;
        }
        // Returned untouched, which is the point: a {"_bytes": "..."} argument
        // decoded into real bytes on the way in and re-encoded on the way out
        // has to come back byte-identical, or the two base64url
        // implementations disagree.
        if (method == QLatin1String("echoBytes"))
            return args.value(0);
        return QVariant();
    }

    QJsonArray getMethods() override
    {
        QJsonArray out;
        for (const char* name : { "add", "greet", "echoBytes" }) {
            QJsonObject m;
            m["name"] = QString::fromLatin1(name);
            m["type"] = "method";
            m["signature"] = QString::fromLatin1(name) + QStringLiteral("(QVariantList)");
            m["returnType"] = "QVariant";
            out.append(m);
        }
        QJsonObject e;
        e["name"] = "ticked";
        e["type"] = "event";
        e["signature"] = "ticked(int)";
        out.append(e);
        return out;
    }

    bool informModuleToken(const QString& moduleName, const QString& token) override
    {
        std::cerr << "TOKEN " << moduleName.toStdString() << " "
                  << token.toStdString() << std::endl;
        return true;
    }

    void setEventListener(EventCallback callback) override { m_emit = std::move(callback); }
    void init(void*) override {}
    QString providerName() const override { return m_name; }
    QString providerVersion() const override { return QStringLiteral("1.0.0"); }

    void setName(const QString& name) { m_name = name; }
    void tick(int n) { if (m_emit) m_emit(QStringLiteral("ticked"), QVariantList{ n }); }

private:
    QString       m_name = QStringLiteral("calc_cpp");
    EventCallback m_emit;
};

QString argValue(const QStringList& args, const QString& flag, const QString& fallback)
{
    const int i = args.indexOf(flag);
    if (i < 0 || i + 1 >= args.size()) return fallback;
    return args.at(i + 1);
}

} // namespace

int main(int argc, char* argv[])
{
    QCoreApplication app(argc, argv);
    const QStringList args = QCoreApplication::arguments();
    const QString moduleName = argValue(args, QStringLiteral("--module"), QStringLiteral("calc_cpp"));
    const QString authToken  = argValue(args, QStringLiteral("--token"), QStringLiteral("web-shim-tok"));
    const int     tickMs     = argValue(args, QStringLiteral("--tick-ms"), QStringLiteral("100")).toInt();

    // The web transport is a REMOTE transport; the factory resolves Web only in
    // Remote mode. This shim builds the host directly, but the mode is what the
    // rest of the stack reads, so set it rather than leave it to a default.
    LogosModeConfig::setMode(LogosMode::Remote);

    ShimProvider provider;
    provider.setName(moduleName);

    // The proxy lives on the MAIN thread and the main thread runs the event
    // loop: WebTransportHost dispatches an inbound Call with a queued
    // invokeMethod, so the proxy's thread has to be one that turns. The channel
    // delivers on its own reader thread, which is what keeps those two apart.
    ModuleProxy proxy(&provider);
    proxy.saveToken(QStringLiteral("web_consumer"), authToken);

    logos::web::WebTransportHost host;
    if (!host.publishObject(moduleName, &proxy)) {
        std::cerr << "FATAL: publishObject failed for " << moduleName.toStdString() << std::endl;
        return 2;
    }

    auto channel = std::make_shared<StdioChannel>();
    if (!host.attachChannel(channel)) {
        std::cerr << "FATAL: attachChannel failed" << std::endl;
        return 2;
    }
    channel->start();

    QTimer ticker;
    int n = 0;
    if (tickMs > 0) {
        QObject::connect(&ticker, &QTimer::timeout, [&provider, &n] { provider.tick(++n); });
        ticker.start(tickMs);
    }

    // stdout is the wire, so readiness is announced on stderr.
    std::cerr << "READY " << moduleName.toStdString() << std::endl;
    const int rc = app.exec();
    channel->close();
    return rc;
}
