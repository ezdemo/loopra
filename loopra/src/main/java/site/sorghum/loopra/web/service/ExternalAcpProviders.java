package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;

/** External engines share the ACP lifecycle; only discovery and launch belong to a provider. */
public final class ExternalAcpProviders {
    private ExternalAcpProviders() {}

    public record Availability(boolean available, String detail) {}
    public record Provider(String id, String name, Supplier<Availability> detection,
                           Function<Path, AcpClientTransport> launcher) {
        public Availability detect() { return detection.get(); }
        public AcpClientTransport create(Path cwd) { return launcher.apply(cwd); }
    }

    private static final List<Provider> PROVIDERS = List.of(
            new Provider("claude-code", "Claude Code", () -> {
                var installation = ClaudeAcpProcess.detect();
                return new Availability(installation.available(), installation.reason());
            }, ClaudeAcpProcess::create),
            new Provider("codex", "Codex", () -> {
                var installation = CodexAcpProcess.detect();
                return new Availability(installation.available(), installation.reason());
            }, CodexAcpProcess::create),
            new Provider("pi", "Pi", () -> {
                var installation = PiAcpProcess.detect();
                return new Availability(installation.available(), installation.reason());
            }, PiAcpProcess::create),
            new Provider("dsh", "DeepSeek Harness", () -> {
                var installation = DshAcpProcess.detect();
                return new Availability(installation.available(), installation.reason());
            }, DshAcpProcess::create));

    public static List<Provider> all() { return PROVIDERS; }

    public static Provider require(String id) {
        return PROVIDERS.stream().filter(provider -> provider.id().equals(id)).findFirst()
                .orElseThrow(() -> new ServiceException("未知 Agent: " + id));
    }

    /** Reject unknown persisted identities instead of routing them to Native. */
    public static boolean isExternal(String id) {
        if ("native".equals(id)) return false;
        require(id);
        return true;
    }
}
