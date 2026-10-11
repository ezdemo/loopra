package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SessionAgentRegistryTest {

    @Test
    void removingAnOldTaskCannotHideANewerTaskInTheSameSession() {
        SessionAgentRegistry registry = new SessionAgentRegistry(2, (key, agent) -> { });
        registry.registerTask("project::session", "old");
        registry.registerTask("project::session", "new");
        registry.unregisterTask("project::session", "old");

        assertTrue(registry.status("project::session").running());
        assertEquals("new", registry.status("project::session").requestId());
        assertFalse(registry.status("other-project::session").running());
        registry.unregisterTask("project::session", "new");
        assertFalse(registry.status("project::session").running());
    }

    @Test
    void evictionAndResetCannotReplaceALockStillHeldByARequest() {
        SessionAgentRegistry registry = new SessionAgentRegistry(2, (key, agent) -> { });
        var lock = registry.getLock("project::session");
        lock.lock();
        try {
            registry.remove("project::session");
            registry.clear();
            assertSame(lock, registry.getLock("project::session"));
        } finally {
            lock.unlock();
        }
    }

    @Test
    void sessionsWithCollidingHashesHaveIndependentLocks() {
        SessionAgentRegistry registry = new SessionAgentRegistry(2, (key, agent) -> { });
        assertEquals("Aa".hashCode(), "BB".hashCode());
        assertNotSame(registry.getLock("Aa"), registry.getLock("BB"));
    }
}
