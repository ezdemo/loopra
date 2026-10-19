package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore.SessionModelSettings;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class SessionSettingsServiceTest {

    @TempDir
    Path sessions;

    private final AtomicInteger opened = new AtomicInteger();
    private final AtomicInteger closed = new AtomicInteger();
    private final AtomicInteger writes = new AtomicInteger();
    private boolean failRead;

    private SessionSettingsService service() {
        return new SessionSettingsService(workspace -> {
            opened.incrementAndGet();
            return new JsonlSessionStore(sessions) {
                @Override
                public SessionModelSettings getModelSettings(String name) {
                    if (failRead) throw new IllegalStateException("read failed");
                    return super.getModelSettings(name);
                }

                @Override
                public void setModelSettings(String name, String model, String channel, String effort) {
                    writes.incrementAndGet();
                    super.setModelSettings(name, model, channel, effort);
                }

                @Override
                public void shutdown() {
                    super.shutdown();
                    closed.incrementAndGet();
                }
            };
        });
    }

    @Test
    void requestOverridesPersistedSettingsFieldByFieldAndPersistsTheResult() throws Exception {
        seed(new SessionModelSettings("persisted-model", "secondary", "medium"));
        SessionModelSettings resolved = service().resolve("project", "session",
                new SessionModelSettings(" requested-model ", null, "high"),
                new SessionModelSettings("cached-model", "main", "low"), config());

        assertEquals(new SessionModelSettings("requested-model", "secondary", "high"), resolved);
        assertEquals(resolved, readPersisted());
        assertEquals(1, writes.get());
        assertEquals(opened.get(), closed.get());
    }

    @Test
    void legacyCachedSettingsTakePrecedenceOverGlobalDefaults() throws Exception {
        SessionModelSettings cached = new SessionModelSettings("cached-model", "secondary", "low");
        assertEquals(cached, service().resolve("project", "session", null, cached, config()));
        assertEquals(cached, readPersisted());
        assertEquals(opened.get(), closed.get());
    }

    @Test
    void newSessionUsesAndPersistsGlobalDefaults() throws Exception {
        assertEquals(new SessionModelSettings("global-model", "main", "medium"),
                service().resolve("project", "session", null, null, config()));
        assertEquals(opened.get(), closed.get());
    }

    @Test
    void explicitlyUnknownChannelIsRejectedWithoutOverwritingSessionMetadata() throws Exception {
        SessionModelSettings existing = new SessionModelSettings("persisted-model", "secondary", "low");
        seed(existing);
        ServiceException error = assertThrows(ServiceException.class, () -> service().resolve(
                "project", "session", new SessionModelSettings(null, "missing", null), null, config()));

        assertEquals(400, error.getCode());
        assertEquals(existing, readPersisted());
        assertEquals(0, writes.get());
        assertEquals(opened.get(), closed.get());
    }

    @Test
    void deletedPersistedChannelFallsBackAndRepeatedResolutionDoesNotRewriteMetadata() throws Exception {
        seed(new SessionModelSettings("persisted-model", "removed-channel", "low"));
        SessionSettingsService service = service();
        SessionModelSettings first = service.resolve("project", "session", null, null, config());
        SessionModelSettings second = service.resolve("project", "session", null, null, config());

        assertEquals(new SessionModelSettings("persisted-model", "main", "low"), first);
        assertEquals(first, second);
        assertEquals(1, writes.get());
        assertEquals(opened.get(), closed.get());
    }

    @Test
    void failedReadStillClosesTheStore() throws Exception {
        failRead = true;
        LoopraConfig config = config();
        assertThrows(IllegalStateException.class,
                () -> service().resolve("project", "session", null, null, config));
        assertEquals(1, opened.get());
        assertEquals(1, closed.get());
        assertEquals(0, writes.get());
    }

    private void seed(SessionModelSettings settings) {
        JsonlSessionStore store = new JsonlSessionStore(sessions);
        try {
            store.setModelSettings("session", settings.model(), settings.modelChannelId(), settings.reasoningEffort());
        } finally {
            store.shutdown();
        }
    }

    private SessionModelSettings readPersisted() {
        JsonlSessionStore store = new JsonlSessionStore(sessions);
        try {
            return store.getModelSettings("session");
        } finally {
            store.shutdown();
        }
    }

    private static LoopraConfig config() throws Exception {
        var constructor = LoopraConfig.class.getDeclaredConstructor(ONode.class);
        constructor.setAccessible(true);
        return constructor.newInstance(ONode.ofJson("""
                {"model":"global-model","modelChannelId":"main","reasoningEffort":"medium","modelChannels":[
                    {"id":"main","models":["global-model"]},
                    {"id":"secondary","models":["secondary-model"]}
                ]}
                """));
    }
}
