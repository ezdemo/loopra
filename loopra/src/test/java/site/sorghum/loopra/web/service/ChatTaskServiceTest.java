package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class ChatTaskServiceTest {

    private final RecordingAgents agents = new RecordingAgents();
    private final ManualExecutor executor = new ManualExecutor();
    private final AtomicLong clock = new AtomicLong();
    private ChatTaskService service = new ChatTaskService(executor, agents, clock::get);

    @AfterEach
    void close() {
        service.close();
    }

    @Test
    void queuedCancellationCompletesWithoutRunningAndUnregistersExactlyOnce() {
        AtomicBoolean ran = new AtomicBoolean();
        AtomicInteger completed = new AtomicInteger();
        service.submit("queued", "project", "session", () -> ran.set(true), failure -> completed.incrementAndGet());
        assertTrue(agents.active.contains("queued"));

        service.cancel("queued");
        executor.runNext();

        assertFalse(ran.get());
        assertEquals(1, completed.get());
        assertEquals(1, agents.unregistered.get());
        assertTrue(agents.active.isEmpty());
    }

    @Test
    void cancellationBeforeRegistrationSkipsWork() {
        AtomicBoolean ran = new AtomicBoolean();
        AtomicInteger completed = new AtomicInteger();
        service.cancel("early");
        service.submit("early", "project", "session", () -> ran.set(true), failure -> completed.incrementAndGet());

        assertFalse(ran.get());
        assertTrue(executor.pending.isEmpty());
        assertTrue(agents.active.isEmpty());
        assertEquals(1, completed.get());
    }

    @Test
    void expiredEarlyCancellationDoesNotCancelANewRequest() {
        AtomicBoolean ran = new AtomicBoolean();
        service.cancel("expired");
        clock.set(TimeUnit.MINUTES.toMillis(5) + 1);
        service.submit("expired", "project", "session", () -> ran.set(true), failure -> { });
        executor.runNext();

        assertTrue(ran.get());
    }

    @Test
    void duplicateRequestCannotReplaceAnActiveTask() {
        AtomicBoolean originalRan = new AtomicBoolean();
        AtomicBoolean replacementRan = new AtomicBoolean();
        service.submit("same", "project", "first", () -> originalRan.set(true), failure -> { });

        ServiceException error = assertThrows(ServiceException.class,
                () -> service.submit("same", "other-project", "second",
                        () -> replacementRan.set(true), failure -> { }));
        assertEquals(409, error.getCode());
        executor.runNext();

        assertTrue(originalRan.get());
        assertFalse(replacementRan.get());
        assertEquals(1, agents.unregistered.get());
    }

    @Test
    void rejectedAdmissionReportsFailureAndReleasesRegistration() {
        executor.reject = true;
        AtomicReference<ServiceException> completion = new AtomicReference<>();
        ServiceException error = assertThrows(ServiceException.class,
                () -> service.submit("busy", "project", "session", () -> fail("must not run"), completion::set));

        assertEquals(503, error.getCode());
        assertSame(error, completion.get());
        assertTrue(agents.active.isEmpty());
    }

    @Test
    void shutdownReleasesQueuedTasks() {
        AtomicInteger completed = new AtomicInteger();
        service.submit("shutdown", "project", "session", () -> fail("must not run"), failure -> completed.incrementAndGet());
        service.close();

        assertEquals(1, completed.get());
        assertTrue(agents.active.isEmpty());
    }

    @Test
    void operationFailureStillReleasesTaskAndOutput() {
        AtomicInteger completed = new AtomicInteger();
        service.submit("failed", "project", "session", () -> {
            throw new IllegalStateException("operation failed");
        }, failure -> completed.incrementAndGet());
        executor.runNext();

        assertEquals(1, completed.get());
        assertTrue(agents.active.isEmpty());
    }

    @Test
    void runningCancellationKeepsOutputAndSessionUntilFinallyHasFinished() throws Exception {
        service.close();
        service = new ChatTaskService(Executors.newSingleThreadExecutor(), agents, clock::get);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch interrupted = new CountDownLatch(1);
        CountDownLatch releaseFinally = new CountDownLatch(1);
        CountDownLatch completed = new CountDownLatch(1);
        AtomicBoolean deliveredRecovery = new AtomicBoolean();
        service.submit("running", "project", "session", () -> {
            entered.countDown();
            try {
                new CountDownLatch(1).await();
            } catch (InterruptedException exception) {
                interrupted.countDown();
            } finally {
                try {
                    if (releaseFinally.await(5, TimeUnit.SECONDS)) deliveredRecovery.set(true);
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                }
            }
        }, failure -> completed.countDown());

        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            service.cancel("running");
            assertTrue(interrupted.await(5, TimeUnit.SECONDS));
            assertEquals(1, completed.getCount(), "output must remain open for recovery events");
            assertTrue(agents.active.contains("running"), "MCP refresh must still wait for cleanup");
        } finally {
            releaseFinally.countDown();
        }
        assertTrue(completed.await(5, TimeUnit.SECONDS));
        assertTrue(deliveredRecovery.get());
        assertTrue(agents.active.isEmpty());
        assertEquals(1, agents.unregistered.get());
    }

    @Test
    void differentSessionsRunInParallelAndCancellingOneDoesNotInterruptTheOther() throws Exception {
        service.close();
        var parallel = Executors.newFixedThreadPool(2);
        service = new ChatTaskService(parallel, agents, clock::get);
        CountDownLatch started = new CountDownLatch(2);
        CountDownLatch completedA = new CountDownLatch(1);
        CountDownLatch completedB = new CountDownLatch(1);
        CountDownLatch releaseB = new CountDownLatch(1);
        AtomicBoolean interruptedA = new AtomicBoolean();
        AtomicBoolean interruptedB = new AtomicBoolean();
        service.submit("A", "same-project", "first", () -> {
            started.countDown();
            try { new CountDownLatch(1).await(); }
            catch (InterruptedException exception) { interruptedA.set(true); }
        }, failure -> completedA.countDown());
        service.submit("B", "same-project", "second", () -> {
            started.countDown();
            try { releaseB.await(); }
            catch (InterruptedException exception) { interruptedB.set(true); }
        }, failure -> completedB.countDown());
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS), "both sessions must enter before either completes");
            service.cancel("A");
            assertTrue(completedA.await(5, TimeUnit.SECONDS));
            assertTrue(interruptedA.get());
            assertFalse(interruptedB.get());
            assertEquals(Set.of("B"), agents.active);
            assertEquals(1, completedB.getCount());
            releaseB.countDown();
            assertTrue(completedB.await(5, TimeUnit.SECONDS));
            assertTrue(agents.active.isEmpty());
            assertEquals(2, agents.unregistered.get());
        } finally {
            releaseB.countDown(); service.close();
            assertTrue(parallel.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    private static final class RecordingAgents extends AgentService {
        final Set<String> active = ConcurrentHashMap.newKeySet();
        final AtomicInteger unregistered = new AtomicInteger();

        @Override
        public void registerSessionTask(String workspace, String session, String requestId) {
            active.add(requestId);
        }

        @Override
        public void unregisterSessionTask(String workspace, String session, String requestId) {
            active.remove(requestId);
            unregistered.incrementAndGet();
        }
    }

    private static final class ManualExecutor extends AbstractExecutorService {
        final Queue<Runnable> pending = new ArrayDeque<>();
        boolean stopped;
        boolean reject;

        void runNext() {
            pending.remove().run();
        }

        @Override
        public void execute(Runnable command) {
            if (stopped || reject) throw new RejectedExecutionException();
            pending.add(command);
        }

        @Override
        public void shutdown() {
            stopped = true;
        }

        @Override
        public List<Runnable> shutdownNow() {
            stopped = true;
            List<Runnable> remaining = new ArrayList<>(pending);
            pending.clear();
            return remaining;
        }

        @Override
        public boolean isShutdown() {
            return stopped;
        }

        @Override
        public boolean isTerminated() {
            return stopped && pending.isEmpty();
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return isTerminated();
        }
    }
}
